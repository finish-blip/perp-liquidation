# 永续合约清算执行引擎

[![CI](https://github.com/finish-blip/perp-liquidation/actions/workflows/ci.yml/badge.svg)](https://github.com/finish-blip/perp-liquidation/actions/workflows/ci.yml)
[![Ruby](https://img.shields.io/badge/Ruby-3.3.11-CC342D?logo=ruby&logoColor=white)](https://www.ruby-lang.org/)
[![MySQL](https://img.shields.io/badge/MySQL-5.7-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)
[![Redis](https://img.shields.io/badge/Redis-6-DC382D?logo=redis&logoColor=white)](https://redis.io/)

这是永续合约系统中位于风控下游的清算执行服务。风控系统负责判断是否需要清算，并给出允许执行的动作、数量、名义价值和价格边界；本引擎负责幂等接收指令、校验执行条件、提交 `reduce_only` 订单、跟踪成交与结算，并将最终结果可靠地回传给风控系统。

本模块不会计算保证金率、维持保证金或强平价，不会自行决定扩大清算范围，也不会把订单 `FILLED` 直接视为清算完成。

## 目录

- [职责边界](#职责边界)
- [核心流程](#核心流程)
- [安全约束](#安全约束)
- [执行能力](#执行能力)
- [项目结构](#项目结构)
- [运行进程](#运行进程)
- [快速启动](#快速启动)
- [与风控及交易系统对接](#与风控及交易系统对接)
- [主要接口](#主要接口)
- [任务状态机](#任务状态机)
- [Binance 参考行情](#binance-参考行情)
- [数值精度](#数值精度)
- [数据存储](#数据存储)
- [配置](#配置)
- [测试与验证](#测试与验证)
- [监控与生产检查](#监控与生产检查)

## 职责边界

清算引擎负责：

- 幂等接收单仓位和组合清算指令；
- 按 `decision_sequence` 处理同一风险单元的决策顺序；
- 获取风险单元锁和 fencing token，防止并发执行旧任务；
- 校验仓位版本、账户版本、授权数量、价格边界和行情新鲜度；
- 生成 STATIC 或 ADAPTIVE 执行计划并提交减仓订单；
- 消费订单、仓位结算和 ADL 结算事件；
- 编排破产损失、保险基金与 ADL 流程；
- 通过 Inbox、Outbox、恢复任务和对账任务保证最终一致性；
- 为取消、对账和 Outbox 重放提供双人审批入口。

清算引擎不负责：

- 计算保证金率、维持保证金、权益或未实现盈亏；
- 判断账户是否达到清算条件；
- 计算或修改风控给出的破产价和授权数量；
- 实现撮合、真实仓位锁、资金记账或资产结算；
- 绕过订单服务和结算服务的二次安全校验。

## 核心流程

```text
risk.liquidation.command
  -> CommandReceiver / Inbox
  -> liquidation_tasks
  -> LiquidationWorker
  -> risk-unit lock + fencing token
  -> InstructionValidator
  -> execution plan
  -> internal order service / matching engine
  -> order.lifecycle
  -> position.settlement.confirmed
  -> bankruptcy / insurance fund / ADL (when required)
  -> Outbox
  -> liquidation.execution.result
```

正常清算路径遵循“先接受、再执行、后结算、最后发布结果”的顺序。外部调用超时不会被直接当作失败：恢复 Worker 会查询订单与结算系统的权威状态，再决定继续、重试或转人工处理。

## 安全约束

- 风控指令、订单事件、结算事件和订单提交均支持幂等处理。
- 同一风险单元按 `decision_sequence` 顺序执行，旧决策不能覆盖新决策。
- 所有减仓和清算订单必须携带 `reduce_only`。
- 订单数量不得超过风控授权数量或当前可减仓位。
- 仓位版本、账户版本和 fencing token 必须匹配。
- 成交价格不得突破风控授权的硬价格边界。
- 行情过期、外部参考价异常或单品种活动订单过多时，任务进入 `RETRY_WAIT`。
- `FILLED` 仅表示订单成交，任务必须等待仓位或账务结算确认。
- 最终结果先持久化到 Outbox，再异步投递给风控系统。
- 取消组合计划、强制对账和 Outbox 重放必须经过双人审批。

## 执行能力

- `CANCEL_RISK_ORDERS`、`REDUCE_POSITION` 和 `LIQUIDATE_POSITION`。
- `EXACT` 与 `UP_TO` 两种数量语义。
- STATIC 单订单或多步骤执行计划。
- ADAPTIVE 盘口深度拆单、参与率限制、冷却时间、超时撤单和重新规划。
- isolated、cross 和 portfolio 场景的执行契约。
- 账户级组合清算、顺序执行、账户版本推进和 `STOP_ON_FAILURE`。
- 破产检查、保险基金赔付和 ADL 编排。
- 订单、结算、Outbox 和卡住任务的恢复对账。
- HTTP 与 Redis Streams 两种事件接入方式。

## 项目结构

```text
perp-liquidation/
|-- bin/                         # API、Worker、契约检查和 smoke 入口
|-- config/                      # 环境变量与 Binance 参考配置
|-- contracts/
|   |-- openapi/                 # 内部 HTTP API
|   |-- schemas/                 # 跨模块事件 JSON Schema
|   |-- examples/                # 可执行契约样例
|   `-- manifest.json            # 契约版本、方向和所有权
|-- db/
|   |-- migrations/              # 清算引擎生产表结构
|   `-- integration/             # 本地模拟依赖的数据结构
|-- integration/                 # 模拟订单、仓位、结算等依赖服务
|-- lib/perp_liquidation/
|   |-- api/                     # Rack HTTP API
|   |-- clients/                 # 下游 HTTP 与行情客户端
|   |-- consumers/               # 风控、订单、结算事件消费者
|   |-- locks/                   # 风险单元锁与 fencing token
|   |-- messaging/               # Redis Streams 路由与投递
|   |-- reconciliation/          # 恢复与对账
|   |-- repositories/            # Memory / MySQL 仓储
|   `-- workers/                 # 后台执行进程
|-- spec/                        # 单元、契约和集成行为测试
|-- docker-compose.real.yml      # 完整本地联调环境
`-- docker-compose.test.yml      # 隔离测试环境
```

关键实现：

- [`command_receiver.rb`](lib/perp_liquidation/command_receiver.rb)：指令幂等、Inbox 和决策顺序。
- [`orchestrator.rb`](lib/perp_liquidation/orchestrator.rb)：清算、成交、结算和损失处置编排。
- [`instruction_validator.rb`](lib/perp_liquidation/instruction_validator.rb)：执行前置条件校验。
- [`price_protection.rb`](lib/perp_liquidation/price_protection.rb)：硬价格边界。
- [`mysql_repository.rb`](lib/perp_liquidation/repositories/mysql_repository.rb)：MySQL 持久化与任务领取。
- [`rack_app.rb`](lib/perp_liquidation/api/rack_app.rb)：内部 HTTP 接口。
- [`manifest.json`](contracts/manifest.json)：跨模块契约版本和所有权。

## 运行进程

生产环境应将不同角色作为独立进程运行：

| 进程 | 入口 | 职责 |
| --- | --- | --- |
| API | `bin/api_server` | 接收指令、事件和查询请求 |
| Liquidation Worker | `bin/liquidation_worker` | 领取并执行清算任务 |
| Recovery Worker | `bin/recovery_worker` | 恢复超时、卡住或状态不一致的任务 |
| Loss Mitigation Worker | `bin/loss_mitigation_worker` | 推进保险基金和 ADL 流程 |
| Outbox Dispatcher | `bin/outbox_dispatcher` | 将最终结果可靠投递给风控系统 |
| Event Stream Consumer | `bin/event_stream_consumer` | 消费 Redis Streams 中的跨模块事件 |

## 快速启动

目标运行时：

```text
Ruby 3.3.11
Bundler 2.5.22
MySQL 5.7
Redis 6
```

推荐直接使用 Docker Compose 启动 MySQL、Redis、清算 API、全部 Worker 和模拟交易所依赖：

```bash
docker compose -f docker-compose.real.yml up -d --build
```

检查服务状态：

```bash
curl http://127.0.0.1:9292/health
```

预期响应：

```json
{"status":"ok","service":"perp-liquidation"}
```

提交仓库内的风控指令样例：

```bash
curl -X POST http://127.0.0.1:9292/api/v1/internal/liquidation/commands \
  -H "Authorization: Bearer local-integration-token" \
  -H "Content-Type: application/json" \
  --data-binary @contracts/examples/risk-liquidation-command-v1.json
```

本地服务地址：

```text
清算 API          http://127.0.0.1:9292
模拟依赖服务      http://127.0.0.1:3101
MySQL             127.0.0.1:13306
Redis             127.0.0.1:16379
```

停止服务并保留数据：

```bash
docker compose -f docker-compose.real.yml down
```

仅在明确需要清空联调数据时删除命名卷：

```bash
docker compose -f docker-compose.real.yml down -v
```

## 与风控及交易系统对接

最小联调链路：

```text
风控服务
  -> risk.liquidation.command
  -> 清算 API / Redis Streams
  -> 清算任务与执行计划
  -> 订单服务
  -> order.lifecycle
  -> 仓位/结算服务
  -> position.settlement.confirmed
  -> liquidation.execution.result
  -> 风控服务
```

支持的事件主题：

| 主题 | 方向 | 所有者 | 用途 |
| --- | --- | --- | --- |
| `risk.liquidation.command` | 入站 | risk | 单风险单元清算指令 |
| `risk.liquidation.portfolio.command` | 入站 | risk | 账户级组合清算计划 |
| `order.lifecycle` | 入站 | order | 订单接受、部分成交、成交或失败 |
| `position.settlement.confirmed` | 入站 | position-settlement | 仓位或账务结算确认 |
| `adl.settlement.confirmed` | 入站 | loss-mitigation | ADL 结算确认 |
| `liquidation.reconcile.requested` | 入站 | operations | 受控对账请求 |
| `liquidation.execution.result` | 出站 | liquidation | 清算最终结果 |

默认通过 HTTP 回传结果。设置 `RESULT_TRANSPORT=redis_streams` 可改为 Redis Streams；设置 `EVENT_STREAMS_ENABLED=true` 可启动事件流消费者。完整字段和版本规则以 [`contracts/`](contracts/) 中的 OpenAPI、JSON Schema 和 manifest 为准。

## 主要接口

除 `/health` 外，真实数据模式下的接口需要：

```http
Authorization: Bearer <SERVICE_TOKEN>
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/internal/liquidation/commands` | 接收单风险单元清算指令 |
| `POST` | `/api/v1/internal/liquidation/portfolio-plans` | 接收组合清算计划 |
| `GET` | `/api/v1/internal/liquidation/tasks/{taskId}` | 查询任务、执行计划、订单尝试和事件 |
| `GET` | `/api/v1/internal/liquidation/tasks/by-risk-decision/{riskDecisionId}` | 按风控决策查询任务 |
| `GET` | `/api/v1/internal/liquidation/tasks` | 按状态、用户、风险单元和交易对分页查询 |
| `GET` | `/api/v1/internal/liquidation/portfolio-plans/{planId}` | 查询组合计划及子任务 |
| `POST` | `/api/v1/internal/liquidation/events/orders` | 接收订单生命周期事件 |
| `POST` | `/api/v1/internal/liquidation/events/settlements` | 接收仓位结算事件 |
| `POST` | `/api/v1/internal/liquidation/events/adl-settlements` | 接收 ADL 结算事件 |
| `POST` | `/api/v1/internal/liquidation/operator-actions` | 发起双人审批操作 |
| `GET` | `/api/v1/internal/liquidation/reconciliation/issues` | 查询对账问题 |
| `GET` | `/api/v1/internal/liquidation/reconciliation/outbox/dead-letters` | 查询 Outbox 死信 |
| `GET` | `/metrics` | Prometheus 文本格式指标 |
| `GET` | `/health` | 健康检查 |

任务列表的 `limit` 默认为 100、最大为 500。响应中的 `pagination.next_before_id` 可作为下一页的 `before_id`。

完整机器接口定义见 [`contracts/openapi/liquidation-internal-v1.yaml`](contracts/openapi/liquidation-internal-v1.yaml)。

## 任务状态机

主成功路径：

```text
RECEIVED
  -> PENDING
  -> CLAIMED
  -> LOCKING
  -> VALIDATING
  -> EXECUTING
  -> ORDER_SUBMITTING
  -> ORDER_ACCEPTED / PARTIALLY_FILLED
  -> FILLED
  -> SETTLEMENT_PENDING
  -> SETTLED
  -> RESULT_PUBLISHING
  -> COMPLETED
```

存在破产损失时会进入：

```text
SETTLEMENT_PENDING
  -> BANKRUPTCY_CHECKING
  -> INSURANCE_CLAIMING
  -> ADL_REQUIRED
  -> ADL_EXECUTING
  -> ADL_SETTLEMENT_PENDING
  -> SETTLED
```

可恢复错误进入 `RETRY_WAIT`；无法自动安全推进的异常进入 `MANUAL_REVIEW`。其他终态包括 `REJECTED`、`CANCELLED`、`EXPIRED` 和 `SUPERSEDED`。

## Binance 参考行情

推荐保持内部撮合盘口为执行权威，并使用 Binance USD-M 公共 REST 行情做外部价格偏离保护：

```text
internal best bid/ask + Binance best bid/ask
  -> 校验合约状态、时间戳和更新序号
  -> 比较 bid/ask 相对偏离
  -> 正常时返回内部执行盘口
  -> 过期、限频或偏离超限时进入 RETRY_WAIT
```

Binance 客户端读取：

- `/fapi/v1/exchangeInfo`：合约类型、交易状态、`tickSize` 和 `stepSize`；
- `/fapi/v1/depth`：best bid/ask、盘口、交易所时间和 `lastUpdateId`。

启用外部参考保护：

```bash
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml up -d --build
```

Binance 深度不会替代内部市场的可成交数量，也不会用于模拟内部成交。本项目不会向 Binance 提交真实订单。

## 数值精度

- Ruby 领域对象使用 `BigDecimal` 处理数量、价格、费用、名义价值和比例。
- API 与事件中的高精度数值使用十进制字符串传输，避免 JSON 浮点误差。
- 数量、价格、费用和损失等数据库字段主要使用 `DECIMAL(36,18)`。
- 滑点、最大偏离和盘口参与率使用 `DECIMAL(18,8)`。
- 下单前仍必须遵守交易对的 `tickSize`、`stepSize` 和最小数量规则。

## 数据存储

`DATA_MODE=memory` 使用内存仓储和 Fake 客户端，适合单元测试和领域逻辑验证。

`DATA_MODE=real` 使用 MySQL、Redis 和真实 HTTP 客户端，不会回退到内存实现：

- MySQL：任务、风险快照、执行计划、订单尝试、事件、Inbox、Outbox、组合计划、保险基金与 ADL 记录；
- Redis：风险单元分布式锁、fencing token、指标和可选 Redis Streams；
- 下游 HTTP：订单、仓位、账户、内部行情、风控、审批与损失处置服务。

迁移文件位于 [`db/migrations/`](db/migrations/)，必须按编号顺序执行。全新 MySQL 命名卷会自动初始化；已有命名卷不会自动重复执行新增迁移。

## 配置

生产环境变量模板见 [`config/environment.example`](config/environment.example)。核心配置：

```text
DATA_MODE=real
DATABASE_URL=mysql2://user:password@mysql:3306/perp_liquidation
REDIS_URL=redis://redis:6379/0

ORDER_SERVICE_URL=http://order-service
POSITION_SERVICE_URL=http://position-service
ACCOUNT_SERVICE_URL=http://account-service
MARKET_DATA_SERVICE_URL=http://market-data-service
RISK_SERVICE_URL=http://risk-service
APPROVAL_SERVICE_URL=http://approval-service
LOSS_MITIGATION_SERVICE_URL=http://loss-mitigation-service
SERVICE_TOKEN=replace-with-service-token
```

进程角色可使用独立连接池大小：

```text
DATABASE_POOL_SIZE_API=10
DATABASE_POOL_SIZE_BACKGROUND=2
DATABASE_POOL_TIMEOUT_SECONDS=5
```

Binance 参考保护的默认示例：

```text
MARKET_DATA_PROVIDER=internal
BINANCE_REFERENCE_ENABLED=true
BINANCE_REFERENCE_MAX_DEVIATION=0.03
BINANCE_REFERENCE_MAX_AGE_MS=2000
BINANCE_REFERENCE_DEPTH_LIMIT=5
BINANCE_FUTURES_URL=https://fapi.binance.com
ALLOW_BINANCE_AS_EXECUTION_MARKET_DATA=false
```

生产部署必须将 Compose 中的 `reference-services` 替换为交易所真实服务。

## 测试与验证

使用锁定运行时执行完整 RSpec：

```bash
docker compose -f docker-compose.test.yml run --build --rm rspec
```

已有完整本地 Ruby 依赖时：

```bash
ruby -Ilib -S rspec
```

验证 Compose 定义：

```bash
docker compose -f docker-compose.test.yml config --quiet
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml config --quiet
```

验证 Binance 公共 REST 快照：

```bash
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml \
  exec liquidation-worker bundle exec ruby bin/binance_market_data_smoke BTCUSDT
```

验证真实 Binance 参考数据的正常放行和异常阻断路径：

```bash
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml \
  run --rm --no-deps component-smoke /workspace/bin/binance_reference_flow_smoke BTCUSDT
```

成功结果应包含：

```text
PASS  aligned reference accepted
PASS  settlement completed
PASS  10% divergence blocked without order
RESULT PASS
```

该流程只读取真实 Binance 公共行情，订单、仓位和结算仍由本地模拟服务提供，不会产生真实交易。

CI 还会执行契约兼容性检查、依赖安全审计、运行时镜像测试和完整组件 smoke 矩阵。

## 监控与生产检查

`GET /metrics` 暴露 Prometheus 文本格式指标。生产环境至少应监控：

- 任务接收量、完成量、拒绝量和各状态停留时间；
- 任务领取延迟、风险单元锁等待和锁续租失败；
- 订单提交延迟、部分成交、超时、撤单和重新规划；
- 结算等待、保险基金、ADL 和人工处理数量；
- Inbox 重复事件、Outbox 堆积、重试和死信；
- 对账问题、恢复 Worker 扫描结果和 Redis Streams pending 消息；
- Binance 429、行情过期、合约状态异常和参考价偏离。

上线前应完成容量测试、故障注入、数据库恢复、消息重放和依赖服务降级演练。订单服务必须再次校验 `reduce_only`、仓位版本、fencing token、授权数量和硬价格边界。

提交和审核要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，机器契约的所有权与版本规则见 [`contracts/README.md`](contracts/README.md)。

# 永续合约清算执行引擎

本项目是风控系统下游的清算执行服务。风控系统负责计算保证金率、维持保证金、清算资格、破产价和授权数量；本服务负责安全、幂等地执行风控指令。

清算引擎不会自行判断账户是否应该被清算，也不会扩大风控授权的数量、名义价值或价格范围。

## 核心流程

```text
risk.liquidation.command
  -> CommandReceiver / Inbox
  -> liquidation_tasks
  -> LiquidationWorker
  -> risk-unit lock + fencing token
  -> InstructionValidator
  -> internal order service / matching engine
  -> order.lifecycle
  -> position.settlement.confirmed
  -> Outbox
  -> liquidation.execution.result
```

主要安全约束：

- 风控决策、外部事件和订单提交均支持幂等处理。
- 同一风险单元按 `decision_sequence` 顺序执行，旧决策不能覆盖新决策。
- 所有减仓和清算订单必须携带 `reduce_only`。
- 订单数量不得超过风控授权数量或当前可减仓位。
- 仓位版本、账户版本和 fencing token 必须匹配。
- 成交价格不得突破风控授权的硬价格边界。
- `FILLED` 不代表任务完成，必须等待仓位或账务结算确认。
- 最终结果先写 Outbox，再异步投递给风控系统。

## 执行能力

- 单仓位撤单、部分减仓和完整清算。
- `EXACT` 与 `UP_TO` 数量语义。
- STATIC 单订单或多步骤执行计划。
- ADAPTIVE 盘口深度拆单、参与率限制、超时撤单和重新规划。
- isolated、cross 和 portfolio 场景的执行契约。
- 账户级组合清算、顺序执行、账户版本推进和 `STOP_ON_FAILURE`。
- 破产检查、保险基金和 ADL 编排。
- 订单、结算、Outbox 和卡住任务的恢复对账。
- 双人审批的取消、对账和 Outbox 重放操作。

## Binance REST 参考行情

推荐保持内部撮合盘口为执行权威，并使用 Binance USD-M 公共 REST 行情做外部价格偏离保护：

```text
internal best bid/ask + Binance best bid/ask
  -> 校验合约状态、时间戳和更新序号
  -> 比较 bid/ask 相对偏离
  -> 正常时返回内部执行盘口
  -> 过期、限频或偏离超限时进入 RETRY_WAIT
```

Binance 客户端读取：

- `/fapi/v1/exchangeInfo`：合约类型、交易状态、`tickSize` 和 `stepSize`。
- `/fapi/v1/depth`：best bid/ask、盘口、交易所时间和 `lastUpdateId`。

Binance 只作为外部参考时默认读取 5 档深度。Binance 深度不会替代内部市场的可成交数量，也不会用于模拟内部成交。本项目不会向 Binance 提交真实订单。

关键配置：

```text
MARKET_DATA_PROVIDER=internal
BINANCE_REFERENCE_ENABLED=true
BINANCE_REFERENCE_MAX_DEVIATION=0.03
BINANCE_REFERENCE_MAX_AGE_MS=2000
BINANCE_REFERENCE_DEPTH_LIMIT=5
BINANCE_FUTURES_URL=https://fapi.binance.com
BINANCE_EXCHANGE_INFO_TTL_SECONDS=3600
ALLOW_BINANCE_AS_EXECUTION_MARKET_DATA=false
```

完整示例位于 `config/binance-reference.env`。

## 数据模式

`DATA_MODE=memory` 使用内存仓储和 Fake 客户端，适合单元测试。

`DATA_MODE=real` 使用 MySQL、Redis 和 HTTP 客户端，不会回退到内存实现。仓库提供的 `docker-compose.real.yml` 仍使用 `reference-services` 模拟仓位、账户、内部盘口、订单、结算、审批、保险基金和 ADL；Binance 行情可以是真实数据。

生产部署必须把以下地址替换为实际交易所服务：

```text
ORDER_SERVICE_URL
POSITION_SERVICE_URL
ACCOUNT_SERVICE_URL
MARKET_DATA_SERVICE_URL
RISK_SERVICE_URL
APPROVAL_SERVICE_URL
LOSS_MITIGATION_SERVICE_URL
```

## 主要目录

```text
bin/          API、Worker、smoke 和契约检查入口
config/       环境变量示例和 Binance 参考配置
contracts/    OpenAPI、JSON Schema、示例和版本清单
db/           生产迁移和集成测试数据结构
integration/  模拟交易所依赖服务
lib/          清算领域、编排、客户端、仓储和 Worker
spec/         单元、契约和集成行为测试
```

核心实现：

- `lib/perp_liquidation/command_receiver.rb`：幂等接收和决策顺序。
- `lib/perp_liquidation/orchestrator.rb`：清算、成交、结算和损失处置编排。
- `lib/perp_liquidation/instruction_validator.rb`：执行前置条件校验。
- `lib/perp_liquidation/price_protection.rb`：硬价格边界。
- `lib/perp_liquidation/repositories/mysql_repository.rb`：MySQL 持久化。
- `lib/perp_liquidation/clients/binance_futures_market_data_client.rb`：Binance REST 行情。
- `contracts/manifest.json`：跨模块契约版本和所有权。

## 主要接口

```text
POST /api/v1/internal/liquidation/commands
POST /api/v1/internal/liquidation/portfolio-plans
GET  /api/v1/internal/liquidation/tasks/{taskId}
GET  /api/v1/internal/liquidation/tasks?status=PENDING&limit=100
GET  /api/v1/internal/liquidation/portfolio-plans/{planId}
POST /api/v1/internal/liquidation/events/orders
POST /api/v1/internal/liquidation/events/settlements
POST /api/v1/internal/liquidation/events/adl-settlements
POST /api/v1/internal/liquidation/operator-actions
GET  /metrics
GET  /health
```

任务列表在数据库中执行过滤，`limit` 默认为 100、最大为 500。响应中的 `pagination.next_before_id` 可作为下一页的 `before_id`。

完整机器接口定义位于 `contracts/openapi/`，事件定义位于 `contracts/schemas/`，可执行示例位于 `contracts/examples/`。

## 运行环境

目标运行时：

```text
Ruby 3.3.11
Bundler 2.5.22
MySQL 5.7
Redis 6
mysql2 0.5.6
```

连接池支持按进程角色配置：

```text
DATABASE_POOL_SIZE_API=10
DATABASE_POOL_SIZE_BACKGROUND=2
DATABASE_POOL_TIMEOUT_SECONDS=5
```

旧的 `DATABASE_POOL_SIZE` 仍可作为所有角色的兼容回退。

## Docker 启动

启动本地真实基础设施和模拟依赖服务：

```bash
docker compose -f docker-compose.real.yml up -d --build
```

启用 Binance REST 外部参考保护：

```bash
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml up -d --build
```

服务地址：

```text
清算 API：http://127.0.0.1:9292
模拟依赖服务：http://127.0.0.1:3101
MySQL：127.0.0.1:13306
Redis：127.0.0.1:16379
```

停止服务并保留数据：

```bash
docker compose -f docker-compose.real.yml down
```

只有明确需要清空联调数据时才执行：

```bash
docker compose -f docker-compose.real.yml down -v
```

## 数据库迁移

迁移文件位于 `db/migrations/`，必须按编号顺序执行。全新 MySQL 命名卷会通过 `/docker-entrypoint-initdb.d` 自动初始化；已有命名卷不会自动重复运行新增迁移。

当前查询性能索引迁移：

```bash
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml exec -T db \
  mysql -uliquidation -pliquidationpass perp_liquidation \
  < db/migrations/010_add_query_performance_indexes.sql
```

## 测试与验证

完整目标运行时测试：

```bash
docker compose -f docker-compose.test.yml run --build --rm rspec
```

已有完整本地依赖时：

```bash
ruby -Ilib -S rspec
```

验证 Compose：

```bash
docker compose -f docker-compose.test.yml config --quiet
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml config --quiet
```

验证 Binance 公共 REST 快照：

```bash
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml \
  exec liquidation-worker bundle exec ruby bin/binance_market_data_smoke BTCUSDT
```

验证真实 Binance 数据参与清算保护的正常放行和异常阻断路径：

```bash
docker compose --env-file config/binance-reference.env -f docker-compose.real.yml \
  run --rm --no-deps component-smoke /workspace/bin/binance_reference_flow_smoke BTCUSDT
```

成功结果必须包含：

```text
PASS  aligned reference accepted
PASS  settlement completed
PASS  10% divergence blocked without order
RESULT PASS
```

该流程使用真实 Binance 行情和模拟内部订单、仓位及结算，不会产生 Binance 真实交易。

其他组件验证入口：

```bash
ruby bin/real_mode_smoke
ruby bin/portfolio_mode_smoke
ruby bin/stream_smoke
```

## 生产注意事项

- Binance REST 直连适合低频参考校验；高并发生产环境应由独立行情服务集中缓存。
- 内部订单服务必须再次校验 `reduce_only`、仓位版本、fencing token、授权数量和硬价格边界。
- 同一风险单元需要稳定的消息分区和顺序消费。
- 必须监控任务延迟、锁等待、订单提交、结算、Outbox 堆积、对账问题和 Binance 429/数据过期。
- 必须建立历史任务、事件、Inbox 和 Outbox 的归档与保留策略。
- 上线前需要容量测试、故障注入、数据库恢复和消息重放演练。

提交和审核要求位于 `CONTRIBUTING.md`。机器契约的版本规则位于 `contracts/README.md`。

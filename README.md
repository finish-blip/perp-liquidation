# 永续合约清算执行引擎

本服务是风控系统下游的安全执行系统：风控负责判断是否需要清算以及本次允许执行的动作和数量，清算引擎负责幂等接收指令、校验执行前置条件、提交 `reduce_only` 订单、跟踪成交与结算，并回传结果。

清算引擎不计算保证金率、维持保证金或强平价，也不会自行决定继续清算。

## 主流程

```text
risk.liquidation.command
  -> CommandReceiver / Inbox
  -> liquidation_tasks
  -> LiquidationWorker
  -> risk-unit lock + fencing token
  -> InstructionValidator
  -> Order service / Matching engine
  -> order.lifecycle
  -> position.settlement.confirmed
  -> Outbox
  -> liquidation.execution.result
```

## 关键代码

- `liquidation_command.rb`：风控指令解析和契约校验。
- `command_receiver.rb`：幂等接收、序号检查和新旧指令覆盖。
- `liquidation.rb`：执行任务和状态机。
- `orchestrator.rb`：撤单、减仓、清算、订单和结算编排。
- `instruction_validator.rb`：执行安全校验，不做风险判断。
- `workers/`：执行、恢复和 Outbox 投递。
- `repositories/`：内存测试仓储和 MySQL 生产仓储。
- `db/migrations/001_create_liquidation_tables.sql`：生产数据结构。

文档入口见 [`docs/README.md`](docs/README.md)，当前目录结构和运行进程见 [`docs/structure.md`](docs/structure.md)，完整接口、字段和时序见 [`docs/api.md`](docs/api.md)。

分阶段升级说明：

- [`docs/stage-1-correctness-hardening.md`](docs/stage-1-correctness-hardening.md)：并发、事件、结算、租约和超时正确性。
- [`docs/stage-2-execution-protection.md`](docs/stage-2-execution-protection.md)：动态优先级、数量语义、行情新鲜度和硬价格边界。
- [`docs/stage-3-adaptive-execution.md`](docs/stage-3-adaptive-execution.md)：盘口深度拆单、逐笔结算、超时撤单、重规划和背压。
- [`docs/stage-4-portfolio-liquidation.md`](docs/stage-4-portfolio-liquidation.md)：账户级组合计划、顺序执行、账户版本、双人审批和生产并发加固。

生产环境变量示例见 [`config/environment.example`](config/environment.example)。API、执行 Worker、恢复 Worker 和 Outbox Dispatcher 应作为独立进程运行。

## 本地验证

完整测试层级、CI 门禁和目标运行时见 [`docs/testing.md`](docs/testing.md)。提交和审核要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

推荐使用本机已有的 Peatio 镜像离线运行测试：

```bash
docker compose -f docker-compose.test.yml run --rm rspec
```

该测试配置使用 `pull_policy: never`、禁用容器网络并直接使用镜像预装的 gem，不执行 `bundle install`，也不会修改宿主机依赖。也可以用现有 Ruby 环境验证纯业务逻辑：

```bash
ruby -Ilib -S rspec
```

仅在已经准备好独立、完整且版本匹配的 gem 环境时使用：

```bash
bundle exec rspec
```

## 真实数据模式

真实模式不会回退到内存仓储或 Fake 客户端。项目复用本机已有的 Peatio、MySQL 和 Redis 镜像：

```bash
docker compose -f docker-compose.real.yml up -d
ruby bin/real_mode_smoke
ruby bin/portfolio_mode_smoke
```

只接入 Binance USD-M 永续合约公开行情时，不需要 API Key。设置：

```bash
MARKET_DATA_PROVIDER=binance
BINANCE_FUTURES_URL=https://fapi.binance.com
BINANCE_DEPTH_LIMIT=20
BINANCE_EXCHANGE_INFO_TTL_SECONDS=3600
```

该模式直接读取 Binance 深度和交易规则，`MARKET_DATA_SERVICE_URL` 不再必填。可以在不启动数据库、Redis 和真实模式容器的情况下单独验证：

```bash
ruby bin/binance_market_data_smoke BTCUSDT
```

组合计划双人审批取消验证见 [`docs/stage-4-portfolio-liquidation.md`](docs/stage-4-portfolio-liquidation.md)。

真实模式地址：

```text
清算 API：http://127.0.0.1:9292
持久化仓位/订单/风控结果服务：http://127.0.0.1:3101
MySQL：127.0.0.1:13306
Redis：127.0.0.1:16379
```

停止服务但保留数据：

```bash
docker compose -f docker-compose.real.yml down
```

仅在明确需要清空所有联调数据时删除命名卷：

```bash
docker compose -f docker-compose.real.yml down -v
```

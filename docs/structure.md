# 清算引擎目录结构与运行流程

本文说明当前仓库的真实目录布局、主要模块职责、进程拆分和运行链路。接口字段、请求示例和错误码见 [`api.md`](api.md)。

## 目录结构

```text
perp-liquidation/
  bin/
    api_server
    liquidation_worker
    recovery_worker
    loss_mitigation_worker
    event_stream_consumer
    outbox_dispatcher
    reference_services_server
    real_mode_smoke
    portfolio_mode_smoke
    stream_smoke

  config/
    environment.example
    liquidation.yml

  db/
    migrations/
      001_create_liquidation_tables.sql
      002_create_execution_plans.sql
      003_create_loss_mitigation_tables.sql
      004_harden_scheduling_and_outbox.sql
      005_add_order_event_sequence.sql
      006_add_execution_protection.sql
      007_add_adaptive_execution.sql
      008_add_portfolio_liquidation.sql
    integration/
      001_create_reference_service_tables.sql
      002_create_loss_mitigation_reference_tables.sql
      003_add_portfolio_reference_data.sql

  docs/
    README.md
    api.md
    structure.md
    enterprise-liquidation-roadmap.md
    execution-plans.md
    loss-mitigation.md
    production-hardening.md
    reconciliation.md
    stage-1-correctness-hardening.md
    stage-2-execution-protection.md
    stage-3-adaptive-execution.md
    stage-4-portfolio-liquidation.md

  integration/
    reference_services_app.rb

  lib/
    perp_liquidation.rb
    perp_liquidation/
      application.rb
      command_receiver.rb
      liquidation_command.rb
      portfolio_liquidation_command.rb
      liquidation.rb
      orchestrator.rb
      instruction_validator.rb
      execution_planner.rb
      adaptive_execution_strategy.rb
      portfolio_plan_receiver.rb
      portfolio_plan_coordinator.rb
      operator_action_service.rb
      api/
      clients/
      consumers/
      locks/
      messaging/
      publishers/
      reconciliation/
      repositories/
      workers/

  spec/
    perp_liquidation/
    support/
```

## 目录职责

- `bin/`：可执行入口。生产进程包括 API、执行 Worker、恢复 Worker、损失缓释 Worker、事件流消费者和 Outbox Dispatcher；`*_smoke` 脚本用于本地真实模式验证。
- `config/`：运行配置示例和业务常量。`DATA_MODE=real` 时必须提供生产依赖环境变量。
- `db/migrations/`：清算服务生产表结构，按阶段递增。
- `db/integration/`：本地联调 reference service 使用的参考表和种子数据。
- `docs/`：架构、接口、阶段升级、生产化和对账文档。
- `integration/`：本地 reference service，用于真实模式 smoke 测试，不是生产清算引擎本体。
- `lib/perp_liquidation/`：核心业务、依赖装配、仓储、客户端、锁、消息、发布、对账和 worker 实现。
- `spec/`：RSpec 单元和集成级业务测试。

## 核心模块

- `Application`：根据环境变量组装 Memory 或 MySQL/Redis/HTTP 真实依赖。
- `CommandReceiver`：按 `risk_decision_id` 幂等接收，按 `decision_sequence` 处理乱序、覆盖和取消。
- `LiquidationCommand`：解析风控清算指令，验证动作、数量边界和必填字段。
- `PortfolioLiquidationCommand` / `PortfolioPlanReceiver`：接收账户级组合清算计划，生成顺序执行项。
- `Liquidation`：清算任务状态机，不保存风险判断逻辑。
- `InstructionValidator`：校验指令有效期、权威仓位和执行前置条件。
- `Orchestrator`：编排撤单、减仓、清算、订单事件、结算事件、价格保护和重规划。
- `ExecutionPlanner` / `AdaptiveExecutionStrategy`：生成执行计划，支持盘口深度拆单和动态执行。
- `OperatorActionService`：处理需要双人审批的受控操作。
- `RiskUnitLockManager` / `RedisLockClient`：按风险单元串行执行并产生 fencing token。
- `MemoryRepository`：本地测试仓储。
- `MysqlRepository`：生产持久化、事务审计、Inbox、Outbox、组合计划和对账数据。

## 进程职责

```text
api_server
  Rack API，接收内部 HTTP 指令、组合计划、订单事件、结算事件、查询、对账和人工操作。

liquidation_worker
  抢占并执行 PENDING / RETRY_WAIT 清算任务。

recovery_worker
  定期恢复状态不确定的订单提交和结算流程。

loss_mitigation_worker
  处理破产价、保险基金和 ADL 相关的损失缓释流程。

event_stream_consumer
  在 EVENT_STREAMS_ENABLED=true 时消费 Redis Streams 事件，并路由到接收器或编排器。

outbox_dispatcher
  从 Outbox 可靠发布 liquidation.execution.result。

reference_services_server
  本地真实模式验证使用的参考服务，模拟订单、仓位、账户、行情、风控和损失缓释接口。
```

## 主运行流程

```text
risk.liquidation.command
  -> CommandReceiver / Inbox
  -> liquidation_tasks
  -> LiquidationWorker
  -> risk-unit lock + fencing token
  -> InstructionValidator
  -> Orchestrator
  -> Order service / Matching engine
  -> order.lifecycle
  -> position.settlement.confirmed
  -> Outbox
  -> liquidation.execution.result
```

账户级组合清算会先进入 `PortfolioPlanReceiver`，生成 `portfolio_liquidation_plans` 和多个任务项，再由普通清算任务链路按账户版本和计划顺序执行。

## 本地验证

推荐使用本机已有的 Peatio 镜像离线运行：

```bash
docker compose -f docker-compose.test.yml run --rm rspec
```

该配置禁止拉取镜像和访问网络，直接使用镜像预装 gem，不执行依赖安装。也可以使用宿主机现有 Ruby 环境验证纯业务逻辑：

```bash
ruby -Ilib -S rspec
```

仅在已经隔离好的完整依赖环境中运行：

```bash
bundle exec rspec
```

真实数据模式：

```bash
docker compose -f docker-compose.real.yml up -d
ruby bin/real_mode_smoke
ruby bin/portfolio_mode_smoke
```

事件流验证：

```bash
ruby bin/stream_smoke
```

## 生产配置要求

`DATA_MODE=real` 时必须配置：

```text
DATABASE_URL
REDIS_URL
ORDER_SERVICE_URL
POSITION_SERVICE_URL
ACCOUNT_SERVICE_URL
MARKET_DATA_SERVICE_URL
RISK_SERVICE_URL
SERVICE_TOKEN
```

可选配置包括 `LOSS_MITIGATION_SERVICE_URL`、`RESULT_TRANSPORT=redis_streams`、`EVENT_STREAMS_ENABLED=true`、数据库连接池参数、HTTP 超时、Worker 轮询间隔、锁 TTL 和 Outbox 重试参数。

## 整理建议

- `bin/` 当前同时包含生产入口和 smoke 脚本；如果后续继续扩展，可以把 `real_mode_smoke`、`portfolio_mode_smoke`、`stream_smoke` 移到 `scripts/`。
- `.bundle/config` 是本机 Bundler 配置，通常不需要作为项目文档或部署依据。
- 空目录和无效 `.git/` 属于仓库卫生问题，不影响清算引擎运行，但会影响版本管理判断。

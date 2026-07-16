# 文档索引

本目录按“先理解系统，再看接口，再看阶段能力和生产化”的顺序组织。

## 快速阅读顺序

1. [`structure.md`](structure.md)：当前目录结构、模块职责、进程拆分和运行流程。
2. [`api.md`](api.md)：风控对接接口、清算引擎依赖接口、请求字段、错误码和完整时序。
3. [`stage-1-correctness-hardening.md`](stage-1-correctness-hardening.md)：并发、事件、结算、租约和超时正确性。
4. [`stage-2-execution-protection.md`](stage-2-execution-protection.md)：动态优先级、数量语义、行情新鲜度和硬价格边界。
5. [`stage-3-adaptive-execution.md`](stage-3-adaptive-execution.md)：盘口深度拆单、逐笔结算、超时撤单、重规划和背压。
6. [`stage-4-portfolio-liquidation.md`](stage-4-portfolio-liquidation.md)：账户级组合计划、顺序执行、账户版本、双人审批和生产并发加固。

## 专题文档

- [`../contracts/README.md`](../contracts/README.md)：跨模块事件与 HTTP 契约、版本规则和部署顺序。
- [`testing.md`](testing.md)：目标运行时、本地测试、CI 和合并门禁。
- [`security-exceptions.md`](security-exceptions.md)：安全例外登记、补偿控制和关闭记录。
- [`market-data-boundary.md`](market-data-boundary.md)：内部执行盘口与 Binance 参考行情的职责和保护配置。
- [`execution-plans.md`](execution-plans.md)：多步骤执行计划和任务详情扩展。
- [`loss-mitigation.md`](loss-mitigation.md)：破产价、保险基金和 ADL 编排。
- [`reconciliation.md`](reconciliation.md)：订单、结算、Outbox 和卡住任务的对账恢复。
- [`production-hardening.md`](production-hardening.md)：调度、Outbox 投递、指标和 Redis Streams。
- [`enterprise-liquidation-roadmap.md`](enterprise-liquidation-roadmap.md)：企业级升级路线和上线门槛。

## 运行入口

常用本地验证命令：

```bash
docker compose -f docker-compose.test.yml run --build --rm rspec
ruby -Ilib -S rspec
docker compose -f docker-compose.real.yml up -d
ruby bin/real_mode_smoke
ruby bin/portfolio_mode_smoke
```

`docker-compose.test.yml` 使用 `Dockerfile.real` 构建锁定依赖，并在禁用网络的容器中执行测试。仅在已经隔离好的完整依赖环境中使用：

```bash
bundle exec rspec
```

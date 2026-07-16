# 清算引擎企业级升级路线

本路线图坚持以下边界：

```text
风控系统决定是否处置、处置动作、目标风险暴露和最大授权数量。
清算引擎在授权范围内选择安全的订单拆分、重试和成交跟踪方式。
结算系统负责最终仓位、钱包、保险基金和坏账账务。
```

当前阶段状态：

```text
阶段一：正确性与并发加固              已完成
阶段二：执行数量与价格保护            已完成
阶段三：盘口驱动的自适应子订单执行    已完成
阶段四：账户级组合清算与生产化        已完成
```

## 1. 当前已实现

- 风控指令契约和风险快照保存。
- `risk_decision_id` 幂等和 `decision_sequence` 顺序控制。
- 旧指令覆盖、风控撤销和执行结果回传。
- 风险单元锁和 fencing token。
- 仓位版本、方向、数量和有效期校验。
- `CANCEL_RISK_ORDERS`、`REDUCE_POSITION`、`LIQUIDATE_POSITION`。
- `reduce_only` 清算订单和稳定 `client_order_id`。
- 订单部分成交、完全成交和结算确认。
- MySQL 任务、快照、执行、审计、Inbox、Outbox 数据结构。
- 执行 Worker、恢复 Worker 和 Outbox Dispatcher。
- 权威行情新鲜度和破产价硬边界。
- `EXACT` / `UP_TO` 数量语义和风控动态优先级。
- 盘口深度拆单、最大参与率、数量步长和子订单预算。
- 子订单逐笔结算、超时撤单、部分成交后重规划。
- 合约级在途订单背压和优先级老化。
- V2 `LIQUIDATE_PORTFOLIO` 账户级组合指令。
- 父计划、计划项、账户执行作用域和顺序激活。
- 每笔结算精确推进账户版本，后续项等待前项结算。
- `STOP_ON_FAILURE` 和单一账户级父结果。
- 组合计划取消、任务对账和 Outbox 重放的双人审批审计。
- MySQL 精确任务领取和 deadlock/锁等待有限重试。

## 2. 阶段三（已完成）：订单执行策略

风控指令已经扩展：

```text
execution_strategy
execution_urgency
max_child_orders
max_child_quantity
min_child_quantity
max_book_participation
child_order_cooldown_ms
child_order_timeout_ms
```

清算引擎已在授权范围内支持：

- 根据保护价范围内盘口深度拆分子订单。
- NORMAL 限价 IOC 和 HIGH/CRITICAL 受保护市价 IOC。
- 每笔子订单结算后重新读取仓位和盘口。
- 部分成交超时撤单、结算确认和剩余量重挂。
- 最大盘口参与率、数量步长、子订单次数和合约背压。

清算引擎仍不根据保证金率决定追加处置数量。

## 3. 阶段四（已完成）：全仓与组合保证金

逐仓风险单元当前可使用：

```text
risk_unit_id = position:{positionId}
```

全仓或组合保证金应由风控定义：

```text
risk_unit_id = account:{accountId}:settlement:{currency}
```

V2 指令可以包含多个仓位执行项，并共享：

- 决策序号。
- 账户版本或组合风险快照版本。
- 总最大授权名义价值。
- `STOP_ON_FAILURE` 顺序执行计划。

已实现的执行不变量：

- 只有当前计划项进入 `PENDING`，后续项保持 `PLAN_WAITING`。
- 所有子任务共享账户级 `execution_scope_id`。
- 每笔订单携带 `expected_account_version`。
- 每笔结算必须使账户版本精确增加 `1`。
- 子任务不单独回传风控，只发布一个账户级父计划结果。
- 受控取消必须通过双人审批操作审计。

完整实现见 [`stage-4-portfolio-liquidation.md`](stage-4-portfolio-liquidation.md)。

## 4. 仓位接管、保险基金和 ADL

新增风控动作：

```text
TAKE_OVER_POSITION
SETTLE_BANKRUPTCY_SURPLUS
USE_INSURANCE_FUND
EXECUTE_ADL
```

职责划分：

- 风控决定触发哪种动作和授权边界。
- 清算引擎编排仓位接管、保险基金请求或 ADL 执行。
- 结算系统原子修改保险基金和用户账本。
- 清算引擎等待账务确认后回传结果。

需要增加：

```text
liquidation_ledger_requests
insurance_fund_executions
adl_executions
bankruptcy_settlements
```

## 5. 多机房与高可用

- 按 `risk_unit_id` 对指令和任务分区。
- 使用数据库或消息队列 offset 保证同一风险单元有序。
- fencing token 必须由订单、仓位和账务服务共同校验。
- Outbox 事件支持跨机房重放。
- Worker 故障切换后必须先反查外部副作用。
- 建立清算任务、订单、成交、结算和账务的持续对账。

## 6. 上线门槛

- 重复指令不会重复下单。
- 乱序旧指令不会产生副作用。
- 旧 fencing token 会被下游拒绝。
- 下单超时后能够按 `client_order_id` 恢复。
- `FILLED` 未结算时不能完成任务。
- 重复订单和结算事件不会重复推进。
- 任意状态重启后可以恢复或进入人工处理。
- 极端行情容量测试覆盖指令堆积、下游超时和部分成交。

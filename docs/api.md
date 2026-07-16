# 清算引擎接口与风控对接协议

## 1. 系统边界

风控系统负责：

- 计算保证金率、维持保证金、清算价和风险等级。
- 决定是否清算、执行动作、执行优先级和本次授权数量。
- 给出破产价、最大允许偏离比例和数量执行语义。
- 收到执行结果后决定是否继续下发新指令。

清算引擎负责：

- 幂等接收风控指令并按风险单元顺序执行。
- 校验指令有效期、仓位版本、仓位方向和授权数量。
- 读取权威实时行情，校验行情新鲜度和风控授权的价格边界。
- 提交 `reduce_only` 订单，跟踪成交和结算。
- 将执行结果可靠回传给风控系统。

清算引擎不计算保证金、清算资格或破产价，也不会自行扩大清算数量。

## 2. 风控需要对接的接口

### 2.1 下发风险处理指令

消息主题：

```text
risk.liquidation.command
```

HTTP 等价接口：

```http
POST /api/v1/internal/liquidation/commands
Content-Type: application/json
```

请求：

```json
{
  "schema_version": 1,
  "risk_decision_id": "risk_20260714_000103",
  "risk_unit_id": "position:888",
  "decision_sequence": 103,
  "action": "LIQUIDATE_POSITION",
  "execution_priority": 10,
  "user_id": 1001,
  "account_id": "acc_1001",
  "position_id": 888,
  "position_version": 42,
  "symbol": "BTCUSDT",
  "position_side": "LONG",
  "instruction": {
    "target_quantity": "0.01000000",
    "max_executable_quantity": "0.01000000",
    "quantity_mode": "EXACT",
    "order_type": "MARKET",
    "reduce_only": true,
    "time_in_force": "IOC",
    "max_slippage": "0.005"
  },
  "price_protection": {
    "bankruptcy_price": "54000",
    "max_deviation": "0.03",
    "quote_max_age_ms": 2000
  },
  "execution_policy": {
    "strategy": "ADAPTIVE",
    "urgency": "NORMAL",
    "max_child_orders": 8,
    "max_child_quantity": "0.004",
    "min_child_quantity": "0.001",
    "max_book_participation": "0.5",
    "child_order_cooldown_ms": 250,
    "child_order_timeout_ms": 5000
  },
  "risk_snapshot": {
    "mark_price": "54200",
    "margin_ratio": "0.004",
    "liquidation_price": "54250",
    "position_size": "0.01000000",
    "market_data_timestamp": "2026-07-14T10:00:00+08:00"
  },
  "expire_at": "2026-07-14T10:00:05+08:00",
  "created_at": "2026-07-14T10:00:00+08:00"
}
```

支持的 `action`：

| action | 含义 |
|---|---|
| `CANCEL_RISK_ORDERS` | 撤销会占用保证金或增加风险的挂单 |
| `REDUCE_POSITION` | 按风控授权数量部分减仓 |
| `LIQUIDATE_POSITION` | 按风控授权数量执行清算 |

执行保护字段：

- `execution_priority`：取值 `0..1000`，数值越小优先级越高；不传时沿用 action 默认优先级。
- `quantity_mode=EXACT`：仓位版本必须精确匹配，按风控目标数量执行。
- `quantity_mode=UP_TO`：允许仓位因并发减仓而缩小，只执行当前仍可减且未超过风控授权的数量；绝不放大。
- `LIQUIDATE_POSITION` 必须提供完整 `price_protection`；`REDUCE_POSITION` 可以不提供以兼容旧协议。
- `bankruptcy_price`、`max_deviation` 和 `quote_max_age_ms` 均由风控授权；`max_deviation` 必须在 `(0, 1)`，行情最大年龄必须在 `1..60000ms`。
- 使用价格保护时，`risk_snapshot.market_data_timestamp` 必填，用于保留风控决策时行情证据。
- `execution_policy.strategy=ADAPTIVE` 时，清算引擎可以在授权总量内按盘口拆分子订单，但必须遵守子订单数量、盘口参与率、冷却和超时上限。
- `ADAPTIVE` 必须同时提供 `price_protection`；不传 `execution_policy` 时使用兼容的 `STATIC` 执行。

响应：

```json
{
  "data": {
    "task_id": "liq_risk_20260714_000103",
    "risk_decision_id": "risk_20260714_000103",
    "risk_unit_id": "position:888",
    "decision_sequence": 103,
    "status": "PENDING"
  }
}
```

幂等和顺序要求：

- `risk_decision_id` 必须全局唯一；重复发送返回同一个任务。
- 同一 `risk_unit_id` 的 `decision_sequence` 必须单调递增。
- 低于已接收序号的指令会进入 `REJECTED`，错误码为 `STALE_DECISION`。
- 新指令会覆盖尚未产生外部副作用的旧指令。
- Worker 先按 `execution_priority ASC` 领取任务，再按创建时间和任务 ID 稳定排序。

### 2.2 撤销尚未执行的风控决策

```http
POST /api/v1/internal/liquidation/commands/{riskDecisionId}/cancel
Content-Type: application/json
```

```json
{
  "reason": "risk_recovered"
}
```

只有尚未下单的任务可以撤销。已经进入订单执行阶段的任务必须等待订单结果，风控再根据实际成交量下发新决策。

### 2.3 查询任务

```http
GET /api/v1/internal/liquidation/tasks/{taskId}
GET /api/v1/internal/liquidation/tasks/by-risk-decision/{riskDecisionId}
GET /api/v1/internal/liquidation/tasks?status=PENDING&risk_unit_id=position:888
```

详情响应包括：

- `data`：任务当前状态。
- `risk_snapshot`：风控下发的原始风险快照。
- `execution`：订单执行信息。
- `events`：完整状态迁移和审计事件。

### 2.4 接收清算执行结果

推荐消息主题：

```text
liquidation.execution.result
```

HTTP 回调接口：

```http
POST /api/v1/internal/risk/liquidation-results
Idempotency-Key: {eventId}
Content-Type: application/json
```

完成结果：

```json
{
  "topic": "liquidation.execution.result",
  "event_id": "result_liq_risk_20260714_000103",
  "data": {
    "task_id": "liq_risk_20260714_000103",
    "risk_decision_id": "risk_20260714_000103",
    "risk_unit_id": "position:888",
    "decision_sequence": 103,
    "action": "REDUCE_POSITION",
    "status": "COMPLETED",
    "requested_quantity": "0.01000000",
    "executed_quantity": "0.01000000",
    "average_price": "54180",
    "position_version_before": 42,
    "position_version_after": 43
  }
}
```

失败或拒绝结果：

```json
{
  "topic": "liquidation.execution.result",
  "event_id": "result_liq_risk_20260714_000103",
  "data": {
    "task_id": "liq_risk_20260714_000103",
    "risk_decision_id": "risk_20260714_000103",
    "status": "REJECTED",
    "error_code": "PRECONDITION_REJECTED",
    "error_message": "position_version mismatch: expected 42, got 43",
    "retryable": false,
    "executed_quantity": "0"
  }
}
```

风控必须使用 `event_id` 幂等消费结果。

## 3. 清算引擎依赖的内部接口

### 3.1 查询权威仓位

```http
GET /api/v1/internal/positions/{positionId}
```

响应必须包含：

```json
{
  "data": {
    "position_id": 888,
    "version": 42,
    "user_id": 1001,
    "account_id": "acc_1001",
    "symbol": "BTCUSDT",
    "side": "LONG",
    "size": "0.01000000"
  }
}
```

### 3.2 查询权威市场行情

```http
GET /api/v1/internal/market/quotes/{symbol}
```

响应必须包含：

```json
{
  "data": {
    "symbol": "BTCUSDT",
    "best_bid": "54190",
    "best_ask": "54210",
    "bids": [
      {"price": "54190", "quantity": "0.004"},
      {"price": "54180", "quantity": "0.004"}
    ],
    "asks": [
      {"price": "54210", "quantity": "0.004"},
      {"price": "54220", "quantity": "0.004"}
    ],
    "quantity_increment": "0.001",
    "observed_at": "2026-07-14T02:00:01Z",
    "sequence": 123456
  }
}
```

清算卖单使用 `best_bid`，清算买单使用 `best_ask`。行情时间超过风控授权的 `quote_max_age_ms` 时不允许下单，任务进入可重试状态。ADAPTIVE 执行还要求排序盘口和正数 `quantity_increment`。

推荐使用内部撮合行情作为该契约的执行权威，并设置 `BINANCE_REFERENCE_ENABLED=true` 使用 Binance USD-M Futures 公开行情做外部偏离保护：

- `/fapi/v1/depth` 提供 bid/ask、盘口和更新序号。
- `/fapi/v1/exchangeInfo` 提供永续合约类型、交易状态、`LOT_SIZE` 和 `PRICE_FILTER`。
- 只接受 `contractType=PERPETUAL` 且 `status=TRADING` 的交易对。
- `418`、`429`、服务端错误、超时、空盘口和无效响应均按可重试行情错误处理。
- 参考行情过期或与内部 best bid/ask 偏离超过配置阈值时不下单。
- 拆单始终使用内部盘口；Binance 深度不作为内部市场可成交数量的证据。
- `MARKET_DATA_PROVIDER=binance` 必须同时显式设置 `ALLOW_BINANCE_AS_EXECUTION_MARKET_DATA=true`，且只适用于执行场所确为 Binance 的适配架构或开发验证。
- 两种模式都只读取公开行情，不使用 Binance API Key，也不向 Binance 提交订单。

完整边界和生产 WebSocket 同步要求见 [`market-data-boundary.md`](market-data-boundary.md)。

### 3.3 提交清算订单

```http
POST /api/v1/internal/orders/liquidation
```

关键字段：

```json
{
  "client_order_id": "liq_risk_20260714_000103_order_1",
  "risk_decision_id": "risk_20260714_000103",
  "position_id": 888,
  "expected_position_version": 42,
  "fencing_token": 9918,
  "side": "SELL",
  "quantity": "0.01000000",
  "reduce_only": true,
  "source": "LIQUIDATION",
  "bankruptcy_price": "54000",
  "max_liquidation_deviation": "0.03",
  "worst_acceptable_price": "52380",
  "market_quote_price": "54190",
  "market_quote_observed_at": "2026-07-14T02:00:01Z",
  "market_quote_sequence": 123456,
  "execution_strategy": "ADAPTIVE",
  "execution_urgency": "NORMAL",
  "child_order_sequence": 1,
  "limit_price": "52380",
  "market_depth_quantity": "0.028",
  "depth_quantity_cap": "0.014",
  "max_book_participation": "0.5",
  "quantity_increment": "0.001"
}
```

订单系统必须原子校验 `client_order_id`、`expected_position_version`、`fencing_token`、当前可减数量和 `reduce_only`。提交时和实际成交时都必须校验 `worst_acceptable_price`，并根据 `bankruptcy_price` 和 `max_liquidation_deviation` 重算边界，拒绝被上游放宽的边界。

ADAPTIVE 订单还必须根据当前权威盘口重新校验深度参与率、数量步长和 LIMIT 保护价格。

价格边界：

```text
LONG 仓位卖出：worst_acceptable_price = bankruptcy_price * (1 - max_deviation)
SHORT 仓位买入：worst_acceptable_price = bankruptcy_price * (1 + max_deviation)
```

### 3.4 下单状态不确定时反查

```http
GET /api/v1/internal/orders/by-client-order-id/{clientOrderId}
```

网络超时后清算引擎先反查，不能直接创建另一笔订单。

ADAPTIVE 子订单超过 `child_order_timeout_ms` 后使用：

```http
POST /api/v1/internal/orders/liquidation/{clientOrderId}/cancel
```

有部分成交的撤单必须先等待对应仓位结算确认，再重规划剩余量。

### 3.5 撤销风险挂单

```http
POST /api/v1/internal/orders/cancel-risk
```

### 3.6 订单生命周期事件

消息主题：

```text
order.lifecycle
```

HTTP 等价入口：

```http
POST /api/v1/internal/liquidation/events/orders
Content-Type: application/json
```

```json
{
  "event_id": "order_event_123",
  "order_id": "ord_123",
  "client_order_id": "liq_risk_20260714_000103_order_1",
  "status": "FILLED",
  "order_event_sequence": 12,
  "filled_quantity": "0.01000000",
  "average_price": "54180",
  "fee": "0.2"
}
```

### 3.7 仓位结算确认事件

消息主题：

```text
position.settlement.confirmed
```

HTTP 等价入口：

```http
POST /api/v1/internal/liquidation/events/settlements
Content-Type: application/json
```

```json
{
  "event_id": "settlement_123",
  "task_id": "liq_risk_20260714_000103",
  "order_id": "ord_123",
  "position_id": 888,
  "position_version": 43
}
```

订单 `FILLED` 后任务只进入 `SETTLEMENT_PENDING`；收到该事件后才能完成。

## 4. 完整流程

```text
1. 风控读取行情、账户和仓位并完成风险计算。
2. 风控生成 risk_decision_id、risk_unit_id 和 decision_sequence。
3. 风控下发 CANCEL_RISK_ORDERS、REDUCE_POSITION 或 LIQUIDATE_POSITION。
4. 清算引擎通过 Inbox 幂等接收，保存风险快照，创建 PENDING 任务。
5. Worker 抢占任务，按 risk_unit_id 获取锁和 fencing_token。
6. 清算引擎校验过期时间、决策序号、仓位版本、方向和授权数量。
7. `EXACT` 保持精确数量；`UP_TO` 按最新权威仓位向下收缩计划，未使用步骤记为 `SKIPPED`。
8. 清算引擎读取最新权威 bid/ask 和盘口，校验行情新鲜度并计算风控授权价格边界。
9. ADAPTIVE 根据保护价内盘口深度、参与率、数量步长和子订单上限计算本次子订单量。
10. 清算引擎向订单系统提交带 `reduce_only`、仓位版本、`fencing_token`、硬价格边界和子订单证据的订单。
11. 订单系统在提交和成交时再次校验价格边界、盘口参与率和数量步长。
12. 子订单成交或部分成交撤单后，清算任务等待该笔仓位/账务结算确认。
13. 仍有剩余量时重新读取仓位和盘口并规划下一笔；无剩余量时完成执行步骤。
14. 最终结算确认后，清算引擎事务内写任务终态和 Outbox 结果。
15. Outbox Dispatcher 将结果发给风控系统。
16. 风控根据实际成交量和最新账户状态决定是否下发下一条指令。
```

## 5. 主要错误码

| 错误码 | 含义 | 风控处理 |
|---|---|---|
| `STALE_DECISION` | 指令序号落后 | 丢弃旧结果，检查最新决策 |
| `DECISION_EXPIRED` | 指令已过期 | 重新计算并生成新指令 |
| `PRECONDITION_REJECTED` | 仓位版本、方向或数量不匹配 | 读取最新仓位并重新决策 |
| `CANCELLED_BY_RISK` | 风控主动撤销 | 无需继续执行旧指令 |
| `SUPERSEDED_BY_NEWER_DECISION` | 被新序号指令覆盖 | 以新指令结果为准 |
| `PriceProtectionBreached` | 当前可成交价越过风控授权边界 | 不会下单；等待行情恢复或由风控下发新决策 |
| `RetryableError` | 权威行情过期、缺失或服务暂时不可用 | 不会下单；按退避策略重试 |
| `InsufficientMarketLiquidity` | 保护价内盘口无法满足最小子订单 | 不会下单；等待流动性恢复或指令过期 |
| `ExecutionBackpressure` | 合约在途清算达到配置上限 | 不会下单；不消耗普通重试预算，延后执行 |
| `EXECUTION_POLICY_EXHAUSTED` | 已使用完风控授权的子订单次数 | 终止旧决策并回传已成交数量，由风控重新决策 |
| `MANUAL_REVIEW_REQUIRED` | 状态不确定 | 暂停扩大处置并人工核对 |

## 6. 一致性要求

- 指令和订单事件均采用至少一次投递，消费者必须幂等。
- 指令、任务和风险快照必须在同一数据库事务中落库。
- 状态迁移必须同时写审计事件。
- 结果必须先写 Outbox，再由 Dispatcher 投递。
- 金额、价格和数量使用字符串传输、`BigDecimal` 计算和数据库 `DECIMAL` 存储。
- `LIQUIDATE_POSITION` 对接方升级前必须执行 `db/migrations/006_add_execution_protection.sql`。
- 启用 ADAPTIVE 执行前必须执行 `db/migrations/007_add_adaptive_execution.sql`，并先升级行情和订单服务契约。

## 7. 账户级组合清算 V2

### 7.1 下发组合计划

消息主题：

```text
risk.liquidation.portfolio.command
```

HTTP 接口：

```http
POST /api/v1/internal/liquidation/portfolio-plans
Content-Type: application/json
```

请求示例：

```json
{
  "schema_version": 2,
  "plan_id": "portfolio_20260715_001",
  "risk_decision_id": "risk_portfolio_20260715_001",
  "risk_unit_id": "account:acc_1001:settlement:USDT",
  "decision_sequence": 201,
  "action": "LIQUIDATE_PORTFOLIO",
  "execution_priority": 5,
  "user_id": "1001",
  "account_id": "acc_1001",
  "account_version": 88,
  "margin_mode": "CROSS",
  "max_total_authorized_notional": "100000",
  "failure_mode": "STOP_ON_FAILURE",
  "items": [
    {
      "action": "LIQUIDATE_POSITION",
      "position_id": "888",
      "position_version": 42,
      "symbol": "BTCUSDT",
      "position_side": "LONG",
      "authorized_notional": "60000",
      "instruction": {
        "target_quantity": "0.01",
        "max_executable_quantity": "0.01",
        "quantity_mode": "EXACT",
        "order_type": "MARKET",
        "reduce_only": true,
        "time_in_force": "IOC",
        "max_slippage": "0.005"
      },
      "price_protection": {
        "bankruptcy_price": "54000",
        "max_deviation": "0.03",
        "quote_max_age_ms": 60000
      },
      "risk_snapshot": {
        "position_size": "0.01",
        "mark_price": "54200",
        "market_data_timestamp": "2026-07-15T08:00:00Z"
      }
    }
  ],
  "expire_at": "2026-07-15T08:05:00Z",
  "created_at": "2026-07-15T08:00:00Z"
}
```

接收规则：

- `account_version` 必须与账户服务返回的权威版本精确一致。
- 同一账户 `risk_unit_id` 同时只允许一个活动组合计划。
- `decision_sequence` 必须严格递增。
- 所有 `authorized_notional` 之和不得超过父级上限。
- 风控决定计划项顺序；清算引擎不得重排。
- 当前只允许 `failure_mode=STOP_ON_FAILURE`。

### 7.2 计划查询

```http
GET /api/v1/internal/liquidation/portfolio-plans/{planId}
GET /api/v1/internal/liquidation/portfolio-plans/by-risk-decision/{riskDecisionId}
```

响应包含父计划、所有计划项、子任务状态和父计划事件。

### 7.3 订单与结算版本契约

组合计划订单在单仓位订单字段之外必须携带：

```json
{
  "execution_scope_id": "account:acc_1001:settlement:USDT",
  "portfolio_plan_id": "portfolio_20260715_001",
  "plan_item_sequence": 1,
  "authorized_notional": "60000",
  "notional_reference_price": "54200",
  "expected_account_version": 88
}
```

清算引擎要求 `target_quantity * risk_snapshot.mark_price <= authorized_notional`，
并把同一 `mark_price` 作为 `notional_reference_price` 传给订单服务。订单服务必须再次校验
该名义价值边界，并原子校验 `expected_account_version`。结算确认必须返回：

```json
{
  "event_id": "settlement_123",
  "task_id": "liq_risk_portfolio_20260715_001_item_1",
  "order_id": "ord_123",
  "position_id": "888",
  "position_version": 43,
  "account_version": 89
}
```

清算引擎只接受账户版本精确增加 `1` 的事件，之后才允许下一笔子订单或下一计划项执行。

### 7.4 父计划结果

子任务不单独发布风控结果。父计划终态只发布一个 `liquidation.execution.result`，其 `action` 为 `LIQUIDATE_PORTFOLIO`，并包含：

- 初始 `account_version` 和最终 `current_account_version`。
- 父计划状态和完成项数量。
- 每个计划项的实际成交数量、均价、仓位版本和错误。

### 7.5 双人审批操作

组合计划取消、人工对账和 Outbox 重放使用：

```http
POST /api/v1/internal/liquidation/operator-actions
Content-Type: application/json
```

```json
{
  "operation_id": "operator_cancel_001",
  "action": "CANCEL_PORTFOLIO_PLAN",
  "target_type": "PORTFOLIO_PLAN",
  "target_id": "portfolio_20260715_001",
  "operator_id": "operator-a",
  "approver_id": "operator-b",
  "approval_id": "approval-001",
  "reason": "exchange maintenance"
}
```

`operator_id` 和 `approver_id` 必须不同。查询审计结果：

```http
GET /api/v1/internal/liquidation/operator-actions/{operationId}
```

直接取消端点：

```http
POST /api/v1/internal/liquidation/portfolio-plans/{planId}/cancel
```

固定返回 `403 dual_approval_required`，不能绕过操作审计。

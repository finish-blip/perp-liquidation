# 阶段三：自适应子订单执行

阶段三让清算引擎在风控授权边界内，根据实时可成交盘口安全拆分子订单。它不决定是否清算、不计算清算数量，也不会突破风控授权的总量、价格和子订单预算。

## 1. 风控授权契约

启用动态执行时，风控在原指令中增加：

```json
{
  "execution_policy": {
    "strategy": "ADAPTIVE",
    "urgency": "NORMAL",
    "max_child_orders": 8,
    "max_child_quantity": "0.004",
    "min_child_quantity": "0.001",
    "max_book_participation": "0.5",
    "child_order_cooldown_ms": 250,
    "child_order_timeout_ms": 5000
  }
}
```

字段约束：

| 字段 | 约束 | 含义 |
|---|---|---|
| `strategy` | `STATIC` / `ADAPTIVE` | 是否启用动态子订单规划 |
| `urgency` | `NORMAL` / `HIGH` / `CRITICAL` | 风控授权的执行紧急度 |
| `max_child_orders` | `1..32` | 包含拒单、撤单和成交单在内的最大提交次数 |
| `max_child_quantity` | 正数且不超过目标量 | 单笔子订单上限 |
| `min_child_quantity` | 正数且不超过单笔上限 | 非尾量子订单的最小数量 |
| `max_book_participation` | `(0, 1]` | 最多使用保护价范围内盘口深度的比例 |
| `child_order_cooldown_ms` | `0..60000` | 已结算子订单之间的等待时间 |
| `child_order_timeout_ms` | `100..300000` | 在途子订单进入撤单恢复的时间 |

`ADAPTIVE` 必须同时启用阶段二的 `price_protection`。未提供 `execution_policy` 的现有指令继续使用 `STATIC`，保持兼容。

## 2. 权威盘口契约

行情服务在 best bid/ask 之外提供按价格排序的盘口和数量步长：

```json
{
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
  "observed_at": "2026-07-15T07:00:00Z",
  "sequence": 123456
}
```

LONG 清算只累计价格不低于 `worst_acceptable_price` 的 bid 数量；SHORT 清算只累计价格不高于边界的 ask 数量。

## 3. 子订单数量算法

每次下单前重新读取仓位与盘口，然后计算：

```text
protected_depth = 保护价范围内的可成交盘口数量
depth_cap       = floor(protected_depth * max_book_participation, quantity_increment)
child_quantity  = floor(min(步骤剩余量, max_child_quantity, depth_cap), quantity_increment)
required_min    = min(min_child_quantity, 步骤剩余量)
```

只有 `child_quantity >= required_min` 才能下单。深度不足时任务进入 `RETRY_WAIT`，错误码为 `InsufficientMarketLiquidity`，不创建订单，也不消耗普通错误重试次数；任务会持续等待到行情恢复或风控指令过期。

紧急度映射：

```text
NORMAL        -> LIMIT + IOC，limit_price 等于硬保护边界
HIGH/CRITICAL -> MARKET + IOC，但订单服务仍强制执行硬保护边界
```

## 4. 子订单结算循环

一个风险执行步骤现在可以对应多笔子订单：

```text
PLANNED
  -> 规划子订单
  -> SUBMITTING / WORKING
  -> 子订单 FILLED
  -> SETTLEMENT_PENDING
  -> 仓位结算确认
  -> 仍有剩余量：PLANNED，重新读取仓位与盘口
  -> 无剩余量：SETTLED
```

每个子订单都使用新的 attempt sequence、client order ID 和 fencing token。即使前一笔已完全成交，也必须收到新的仓位版本后才能提交下一笔。

## 5. 部分成交、撤单与重挂

恢复 Worker 使用 `child_order_timeout_ms` 判断 ADAPTIVE 在途订单是否超时：

1. 按原 `client_order_id` 查询权威订单状态。
2. 对仍为 `ACCEPTED` 或 `PARTIALLY_FILLED` 的超时订单调用幂等撤单接口。
3. 零成交撤单进入普通重试，下一次只提交剩余量。
4. 有部分成交的撤单进入 `SETTLEMENT_PENDING`。
5. 收到该部分成交的仓位结算版本后，步骤恢复为 `PLANNED`，重新规划剩余量。

撤单接口：

```http
POST /api/v1/internal/orders/liquidation/{clientOrderId}/cancel
```

请求必须带 `task_id`、`risk_decision_id` 和原订单的 `fencing_token`。订单服务需要原子校验订单归属。

## 6. 背压与调度

新增两层调度保护：

- `SYMBOL_ACTIVE_ORDER_LIMIT` 限制一个合约同时处于下单、成交和结算阶段的清算任务数量。
- `PRIORITY_AGING_SECONDS` 持续降低等待任务的有效优先级，防止较低优先任务永久饥饿。

背压不会占用普通错误重试预算。任务保持原风控优先级和授权数量，只是延后执行。

配置：

```text
PRIORITY_AGING_SECONDS=30
SYMBOL_ACTIVE_ORDER_LIMIT=100
EXECUTION_DEFER_SECONDS=2
```

## 7. 订单服务二次校验

ADAPTIVE 订单请求新增：

```json
{
  "execution_strategy": "ADAPTIVE",
  "execution_urgency": "NORMAL",
  "child_order_sequence": 1,
  "quantity": "0.004",
  "limit_price": "52380",
  "market_depth_quantity": "0.028",
  "depth_quantity_cap": "0.014",
  "max_book_participation": "0.5",
  "quantity_increment": "0.001"
}
```

订单服务重新读取当前盘口并校验：

- 子订单数量不超过当前保护价范围内深度乘以参与率。
- 数量符合 `quantity_increment`。
- LIMIT 子订单的价格严格等于授权保护边界。
- 原有 `reduce_only`、仓位版本、fencing token 和成交价格边界继续生效。

## 8. 数据迁移

迁移文件：

```text
db/migrations/007_add_adaptive_execution.sql
```

新增任务字段：

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

现有数据库必须先执行迁移。新数据库通过 Compose 初始化脚本自动创建字段。

## 9. 结果与审计

结果回传增加：

```json
{
  "execution_strategy": "ADAPTIVE",
  "execution_urgency": "NORMAL",
  "child_order_count": 3
}
```

关键审计事件包括：

```text
CHILD_ORDER_PLANNED
CHILD_ORDER_SETTLED
CHILD_ORDER_COOLDOWN
CHILD_ORDER_CANCEL_REQUESTED
EXECUTION_DEFERRED
```

## 10. 验证结果

自动化测试：

```text
71 examples, 0 failures
```

真实 MySQL、Redis 和 HTTP 模式已验证：

- `0.01` 单步骤目标按 `0.004 + 0.004 + 0.002` 动态拆成三笔并逐笔结算。
- 第一笔 `0.004` 子订单成交 `0.002` 后超时撤单，先确认部分结算，再以 `0.004 + 0.004` 完成剩余量。
- 静态单订单、静态多步骤、对账恢复、价格保护阻断和 Redis Streams 均保持通过。

验证命令：

```bash
ruby -Ilib -S rspec
ruby bin/real_mode_smoke --adaptive
ruby bin/real_mode_smoke --adaptive-cancel
ruby bin/real_mode_smoke
ruby bin/real_mode_smoke --multi-step --reconcile
ruby bin/real_mode_smoke --price-block
ruby bin/stream_smoke
```

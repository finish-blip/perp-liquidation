# 阶段二：执行保护与动态授权

阶段二只增强清算指令的安全执行，不把风险计算迁入清算服务。

风控引擎仍然负责决定：

- 是否触发清算，以及下发 `REDUCE_POSITION` 还是 `LIQUIDATE_POSITION`。
- 风险单元、决策序号、执行优先级和最大授权数量。
- `EXACT` 或 `UP_TO` 数量语义。
- 破产价、最大允许价格偏离和行情有效时间。

清算引擎只负责验证这些授权在执行时仍然成立，并把硬约束传给订单服务。它不会计算保证金率、清算价、破产价或自行追加清算数量。

## 1. 风控指令契约

```json
{
  "execution_priority": 10,
  "action": "LIQUIDATE_POSITION",
  "instruction": {
    "target_quantity": "0.01",
    "max_executable_quantity": "0.01",
    "quantity_mode": "EXACT",
    "order_type": "MARKET",
    "reduce_only": true,
    "time_in_force": "IOC"
  },
  "price_protection": {
    "bankruptcy_price": "54000",
    "max_deviation": "0.03",
    "quote_max_age_ms": 2000
  },
  "risk_snapshot": {
    "position_size": "0.01",
    "market_data_timestamp": "2026-07-15T06:30:00Z"
  }
}
```

契约规则：

- `execution_priority` 范围是 `0..1000`，数值越小越先执行。
- 未传优先级时继续使用 action 默认值：清算 `10`、撤单 `20`、减仓 `50`。
- `LIQUIDATE_POSITION` 必须提供完整 `price_protection`，这是阶段二的协议升级点。
- `REDUCE_POSITION` 只有显式提供 `price_protection` 时才启用价格保护，保留旧调用兼容性。
- `bankruptcy_price > 0`，`0 < max_deviation < 1`，`quote_max_age_ms` 范围是 `1..60000`。
- 使用价格保护时必须带 `risk_snapshot.market_data_timestamp`，用于审计风控决策依据。

## 2. 动态执行优先级

任务领取顺序使用数据库持久化的 `priority ASC, created_at ASC, task_id ASC`。动态优先级只决定待执行任务的先后，不绕过同一 `risk_unit_id` 的互斥锁、持久化租约和 fencing token。

因此高优先级任务仍然受以下约束：

- 同一风险单元只能有一个有效执行者。
- 决策序号必须单调递增。
- 已经产生外部订单副作用的旧任务不能被静默替换。

## 3. 数量执行语义

### EXACT

`EXACT` 用于要求严格重放风控授权的场景：

- 当前仓位身份、用户、账户、合约、方向和版本必须精确匹配。
- 下一执行步骤的剩余数量不能超过当前仓位。
- 任一前置条件变化都会拒绝旧决策，风控需要基于最新仓位重新计算。

### UP_TO

`UP_TO` 只允许因其他合法减仓而向下收缩，不能扩大：

- 当前仓位版本不得低于指令版本或上一步结算版本。
- 仓位身份、用户、账户、合约和方向仍必须完全一致。
- 当前仓位不得大于 `risk_snapshot.position_size`，防止新增仓位被旧授权清算。
- 实际可执行量为 `min(当前仓位, 目标剩余量, 授权剩余量)`。
- 执行计划按上述上限原子缩减，未使用步骤落为 `SKIPPED`。
- 当前仓位已经为零时，不提交订单，任务以实际执行量完成。

## 4. 价格保护

每个执行步骤下单前，清算引擎通过 `MARKET_DATA_SERVICE_URL` 读取权威 `best_bid`、`best_ask`、行情时间和序号。

价格边界由风控授权参数机械推导：

```text
LONG 仓位清算卖出：worst_price = bankruptcy_price * (1 - max_deviation)
SHORT 仓位清算买入：worst_price = bankruptcy_price * (1 + max_deviation)
```

校验规则：

- LONG 使用 `best_bid`，只有 `best_bid >= worst_price` 才允许提交卖单。
- SHORT 使用 `best_ask`，只有 `best_ask <= worst_price` 才允许提交买单。
- 行情年龄超过 `quote_max_age_ms`、时间明显来自未来或行情服务不可用时进入可重试状态。
- 当前价格越过边界时抛出 `PriceProtectionBreached`，任务进入 `RETRY_WAIT`，不会创建订单。

订单请求携带完整审计证据：

```json
{
  "bankruptcy_price": "54000.0",
  "max_liquidation_deviation": "0.03",
  "worst_acceptable_price": "52380.0",
  "market_quote_price": "54190.0",
  "market_quote_observed_at": "2026-07-15T06:30:01Z",
  "market_quote_sequence": 123456,
  "expected_position_version": 84
}
```

保护分两层执行：

1. 清算引擎在提交前检查最新行情，避免发送已知不可接受的订单。
2. 订单服务在接受订单和实际成交时再次校验边界，并从破产价与偏离比例重算期望边界，防止 `worst_acceptable_price` 被放宽。

生产订单服务必须实现第二层原子校验；`integration/reference_services_app.rb` 是当前可运行的参考实现。

## 5. 完整执行流程

```text
风险指令
  -> Inbox 幂等落库
  -> 按动态优先级领取任务
  -> risk_unit Redis 锁 + MySQL 租约 + fencing token
  -> 校验决策序号、有效期和权威仓位
  -> EXACT 精确授权 / UP_TO 向下收缩执行计划
  -> 获取新鲜权威 bid/ask
  -> 校验风控价格边界
  -> 提交 reduce_only + fencing token + worst_acceptable_price
  -> 订单服务提交时二次校验
  -> 跟踪单调订单事件与累计成交
  -> 订单服务成交时再次校验
  -> 等待仓位结算确认
  -> Outbox 回传实际结果给风控
```

回传结果新增：

- `execution_priority`
- `quantity_mode`
- `authorized_bankruptcy_price`

`authorized_bankruptcy_price` 与后续损失减损阶段计算出的实际 `bankruptcy_price` 分开，避免两个不同语义的字段互相覆盖。

## 6. 数据结构与部署

迁移文件：

```text
db/migrations/006_add_execution_protection.sql
```

新增任务字段：

| 字段 | 类型 | 用途 |
|---|---|---|
| `quantity_mode` | `VARCHAR(16)` | `EXACT` 或 `UP_TO` |
| `bankruptcy_price` | `DECIMAL(36,18)` | 风控授权破产价 |
| `max_liquidation_deviation` | `DECIMAL(18,8)` | 风控授权最大偏离 |
| `quote_max_age_ms` | `INT` | 下单前行情最大年龄 |

部署顺序：

1. 先在现有数据库执行迁移；已有 MySQL 数据目录不会重新运行 `/docker-entrypoint-initdb.d`。
2. 配置 `MARKET_DATA_SERVICE_URL`、鉴权令牌和 HTTP 超时。
3. 升级订单服务，使其支持并强制执行硬价格边界。
4. 再升级 API、执行 Worker、恢复 Worker 和事件消费者。
5. 最后让风控开始为 `LIQUIDATE_POSITION` 发送新字段。

## 7. 验证结果

自动化测试：

```text
59 examples, 0 failures
```

真实 MySQL、Redis 和 HTTP 模式已验证：

- 普通清算、分步执行、结算恢复和 Redis Streams 消费完成。
- `UP_TO` 将 `0.01` 目标安全缩减为当前仓位 `0.006`。
- LONG/SHORT 边界和过期行情自动化用例通过。
- 价格低于 LONG 保护边界时进入 `RETRY_WAIT`，错误码为 `PriceProtectionBreached`，且没有订单 ID。
- 行情恢复后正常任务完成，请求中的 `worst_acceptable_price` 为 `52380.0`，结果保留 `authorized_bankruptcy_price=54000.0`。

验证命令：

```bash
ruby -Ilib -S rspec
ruby bin/real_mode_smoke --price-block
ruby bin/real_mode_smoke
```

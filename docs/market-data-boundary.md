# 执行行情与 Binance 参考行情边界

## 数据职责

| 数据 | 权威来源 | 用途 |
|---|---|---|
| 可执行 best bid/ask 和盘口深度 | 内部撮合/行情服务 | 价格保护、拆单和订单证据 |
| 数量与价格精度 | 内部市场配置和订单服务 | 下单与成交校验 |
| Binance best bid/ask | Binance USD-M 公开行情 | 外部价格偏离保护 |
| Binance mark/index price | 独立行情服务提供给风控 | 保证金和风险决策，不由清算引擎计算 |

清算引擎发送到内部订单服务时，不能使用 Binance 盘口代替内部可执行盘口。两个市场的流动性、价差和可成交数量并不相同。

## 推荐配置

```text
MARKET_DATA_PROVIDER=internal
MARKET_DATA_SERVICE_URL=http://market-data:3104
BINANCE_REFERENCE_ENABLED=true
BINANCE_REFERENCE_MAX_DEVIATION=0.03
BINANCE_REFERENCE_MAX_AGE_MS=2000
BINANCE_FUTURES_URL=https://fapi.binance.com
BINANCE_DEPTH_LIMIT=20
BINANCE_EXCHANGE_INFO_TTL_SECONDS=3600
```

处理顺序：

1. 读取内部执行盘口。
2. 读取 Binance 参考盘口。
3. 校验 Binance 合约为 `PERPETUAL`、状态为 `TRADING`，并校验交易规则、时间戳和更新序号。
4. 分别比较内部与 Binance 的 best bid、best ask 相对偏离。
5. 偏离未超过阈值时返回内部盘口；Binance 盘口不会进入拆单深度计算。

参考行情超时、限频、过期、时间在未来或偏离越界时，任务进入 `RETRY_WAIT`，不会提交订单。错误码分别为 `ReferenceMarketDataUnavailable` 或 `ReferencePriceDivergence`。

## Binance 直连执行模式

只有实际执行场所就是 Binance，或者处于明确批准的开发验证场景时，才允许：

```text
MARKET_DATA_PROVIDER=binance
ALLOW_BINANCE_AS_EXECUTION_MARKET_DATA=true
```

该确认只改变行情来源，不会向 Binance 下单，也不需要 API Key。清算引擎仍把订单发送到配置的订单服务。若订单服务实际不是 Binance 执行适配器，该模式不得用于生产。

## 生产行情服务

清算引擎内置 Binance 客户端使用 REST 深度快照，适合低频参考校验和连通性验证。高并发生产环境应由独立行情服务维护 Binance 数据：

1. 使用 `/fapi/v1/exchangeInfo` 缓存合约状态、`LOT_SIZE` 和 `PRICE_FILTER`。
2. 连接 USD-M Futures WebSocket diff depth，并先缓存增量事件。
3. 使用 `/fapi/v1/depth` 获取初始快照，丢弃过旧事件。
4. 第一条应用事件必须覆盖快照更新号，后续事件的 `pu` 必须等于上一条 `u`。
5. 发现序号缺口、断线或解析失败时立即废弃本地订单簿并重新同步。
6. 使用 `bookTicker` 更新最优买卖价，使用 mark price/index price stream 服务风控。
7. 对数据年龄、断流时间、重连次数、序号缺口、HTTP 418/429 和内部/Binance 偏离建立指标与告警。

独立行情服务向清算引擎输出内部契约，清算进程本身不承担 WebSocket 订单簿状态和断线恢复。

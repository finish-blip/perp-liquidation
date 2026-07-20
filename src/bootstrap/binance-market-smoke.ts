import { randomUUID } from "node:crypto";

import { loadConfig } from "../config/env.js";
import { BinanceFuturesMarketDataClient } from "../infrastructure/http-clients/binance-futures-market-data-client.js";
import { UndiciJsonHttpTransport } from "../infrastructure/http-clients/json-http-transport.js";
import { createLogger } from "../observability/logger.js";

const config = loadConfig();
const logger = createLogger(config, { component: "binance-market-smoke" });
const client = new BinanceFuturesMarketDataClient(
  new UndiciJsonHttpTransport({
    baseUrl: config.binance.baseUrl,
    timeoutMs: config.binance.timeoutMs,
    maxGetAttempts: config.binance.maxGetAttempts
  }),
  { exchangeInfoTtlMs: config.binance.exchangeInfoTtlMs }
);
const snapshot = await client.getSnapshot({
  market: config.binance.smokeMarket,
  correlationId: `binance-smoke-${randomUUID()}`,
  signal: undefined
});

logger.info(
  {
    market: snapshot.market,
    best_bid: snapshot.bestBid,
    best_ask: snapshot.bestAsk,
    mark_price: snapshot.markPrice,
    tick_size: snapshot.tickSize,
    step_size: snapshot.stepSize,
    observed_at: snapshot.observedAt
  },
  "Binance USD-M Futures market snapshot received"
);

import { Ajv2020 } from "ajv/dist/2020.js";

import type { MarketDataClient } from "../../application/ports/market-data-client.js";
import {
  assertPositiveDecimal,
  compareDecimal,
  type DecimalString
} from "../../domain/shared/decimal.js";
import { ExternalFatalError, ValidationError } from "../../domain/shared/errors.js";
import { assertUtcIsoString } from "../../domain/shared/time.js";
import type { JsonHttpTransport } from "./json-http-transport.js";

type BinanceBookTicker = {
  readonly symbol: string;
  readonly bidPrice: string;
  readonly askPrice: string;
  readonly time: number;
};

type BinancePremiumIndex = {
  readonly symbol: string;
  readonly markPrice: string;
  readonly time: number;
};

type BinanceExchangeInfo = {
  readonly symbols: readonly {
    readonly symbol: string;
    readonly status: string;
    readonly contractType: string;
    readonly filters: readonly {
      readonly filterType: string;
      readonly tickSize?: string;
      readonly stepSize?: string;
    }[];
  }[];
};

type MarketRules = {
  readonly tickSize: DecimalString;
  readonly stepSize: DecimalString;
};

export type BinanceFuturesMarketDataClientOptions = {
  readonly exchangeInfoTtlMs: number;
  readonly clock?: () => Date;
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateBookTicker = ajv.compile<BinanceBookTicker>({
  type: "object",
  additionalProperties: true,
  required: ["symbol", "bidPrice", "askPrice", "time"],
  properties: {
    symbol: { type: "string" },
    bidPrice: { type: "string" },
    askPrice: { type: "string" },
    time: { type: "integer" }
  }
});
const validatePremiumIndex = ajv.compile<BinancePremiumIndex>({
  type: "object",
  additionalProperties: true,
  required: ["symbol", "markPrice", "time"],
  properties: {
    symbol: { type: "string" },
    markPrice: { type: "string" },
    time: { type: "integer" }
  }
});
const validateExchangeInfo = ajv.compile<BinanceExchangeInfo>({
  type: "object",
  additionalProperties: true,
  required: ["symbols"],
  properties: {
    symbols: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["symbol", "status", "contractType", "filters"],
        properties: {
          symbol: { type: "string" },
          status: { type: "string" },
          contractType: { type: "string" },
          filters: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              required: ["filterType"],
              properties: {
                filterType: { type: "string" },
                tickSize: { type: "string" },
                stepSize: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
});

export class BinanceFuturesMarketDataClient implements MarketDataClient {
  private readonly clock: () => Date;
  private rulesCache: { readonly expiresAt: number; readonly rules: ReadonlyMap<string, MarketRules> } | undefined;
  private rulesRequest: Promise<ReadonlyMap<string, MarketRules>> | undefined;

  constructor(
    private readonly transport: JsonHttpTransport,
    private readonly options: BinanceFuturesMarketDataClientOptions
  ) {
    if (
      !Number.isInteger(options.exchangeInfoTtlMs) ||
      options.exchangeInfoTtlMs < 1000 ||
      options.exchangeInfoTtlMs > 86_400_000
    ) {
      throw new ValidationError("exchangeInfoTtlMs must be between 1000 and 86400000");
    }
    this.clock = options.clock ?? (() => new Date());
  }

  async getSnapshot(
    input: Parameters<MarketDataClient["getSnapshot"]>[0]
  ): ReturnType<MarketDataClient["getSnapshot"]> {
    assertMarket(input.market);
    const symbol = encodeURIComponent(input.market);
    const [bookPayload, premiumPayload, rules] = await Promise.all([
      this.transport.send({
        method: "GET",
        path: `/fapi/v1/ticker/bookTicker?symbol=${symbol}`,
        correlationId: input.correlationId,
        signal: input.signal
      }),
      this.transport.send({
        method: "GET",
        path: `/fapi/v1/premiumIndex?symbol=${symbol}`,
        correlationId: input.correlationId,
        signal: input.signal
      }),
      this.getMarketRules(input.correlationId, input.signal)
    ]);
    if (!validateBookTicker(bookPayload)) {
      throw contractError("book ticker", validateBookTicker.errors);
    }
    if (!validatePremiumIndex(premiumPayload)) {
      throw contractError("premium index", validatePremiumIndex.errors);
    }
    if (bookPayload.symbol !== input.market || premiumPayload.symbol !== input.market) {
      throw new ExternalFatalError("Binance response symbol does not match requested market");
    }

    const bestBid = assertPositiveDecimal(bookPayload.bidPrice, "binance.bidPrice");
    const bestAsk = assertPositiveDecimal(bookPayload.askPrice, "binance.askPrice");
    if (compareDecimal(bestAsk, bestBid) < 0) {
      throw new ExternalFatalError("Binance best ask is below best bid");
    }
    const marketRules = rules.get(input.market);
    if (marketRules === undefined) {
      throw new ExternalFatalError("Binance market is not an active perpetual contract", {
        market: input.market
      });
    }

    return {
      market: input.market,
      bestBid,
      bestAsk,
      markPrice: assertPositiveDecimal(premiumPayload.markPrice, "binance.markPrice"),
      tickSize: marketRules.tickSize,
      stepSize: marketRules.stepSize,
      observedAt: timestampToUtc(Math.max(bookPayload.time, premiumPayload.time))
    };
  }

  private async getMarketRules(
    correlationId: string,
    signal: AbortSignal | undefined
  ): Promise<ReadonlyMap<string, MarketRules>> {
    const now = this.clock().getTime();
    if (this.rulesCache !== undefined && this.rulesCache.expiresAt > now) {
      return this.rulesCache.rules;
    }
    if (this.rulesRequest !== undefined) {
      return this.rulesRequest;
    }

    this.rulesRequest = this.loadMarketRules(correlationId, signal);
    try {
      const rules = await this.rulesRequest;
      this.rulesCache = { expiresAt: now + this.options.exchangeInfoTtlMs, rules };
      return rules;
    } finally {
      this.rulesRequest = undefined;
    }
  }

  private async loadMarketRules(
    correlationId: string,
    signal: AbortSignal | undefined
  ): Promise<ReadonlyMap<string, MarketRules>> {
    const payload = await this.transport.send({
      method: "GET",
      path: "/fapi/v1/exchangeInfo",
      correlationId,
      signal
    });
    if (!validateExchangeInfo(payload)) {
      throw contractError("exchange info", validateExchangeInfo.errors);
    }

    const rules = new Map<string, MarketRules>();
    for (const market of payload.symbols) {
      if (market.status !== "TRADING" || market.contractType !== "PERPETUAL") {
        continue;
      }
      const priceFilter = market.filters.find((filter) => filter.filterType === "PRICE_FILTER");
      const lotSizeFilter = market.filters.find((filter) => filter.filterType === "LOT_SIZE");
      if (priceFilter?.tickSize === undefined || lotSizeFilter?.stepSize === undefined) {
        continue;
      }
      rules.set(market.symbol, {
        tickSize: assertPositiveDecimal(priceFilter.tickSize, "binance.tickSize"),
        stepSize: assertPositiveDecimal(lotSizeFilter.stepSize, "binance.stepSize")
      });
    }
    return rules;
  }
}

function timestampToUtc(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExternalFatalError("Binance returned an invalid event timestamp", { value });
  }
  return assertUtcIsoString(new Date(value).toISOString(), "binance.time");
}

function assertMarket(value: string): void {
  if (!/^[A-Z0-9]{2,32}$/.test(value)) {
    throw new ValidationError("Binance market must contain 2-32 uppercase letters or digits");
  }
}

function contractError(label: string, errors: unknown): ExternalFatalError {
  return new ExternalFatalError(`Binance ${label} response does not match its contract`, {
    errors
  });
}

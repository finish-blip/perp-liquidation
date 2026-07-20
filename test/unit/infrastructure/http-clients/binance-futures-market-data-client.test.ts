import { describe, expect, it, vi } from "vitest";

import { ExternalFatalError } from "../../../../src/domain/shared/errors.js";
import { BinanceFuturesMarketDataClient } from "../../../../src/infrastructure/http-clients/binance-futures-market-data-client.js";
import type { JsonHttpTransport } from "../../../../src/infrastructure/http-clients/json-http-transport.js";

describe("BinanceFuturesMarketDataClient", () => {
  it("combines public USD-M book, mark price, and exchange rules", async () => {
    const send = binanceTransport();
    const client = new BinanceFuturesMarketDataClient(
      { send },
      { exchangeInfoTtlMs: 300_000, clock: () => new Date("2026-07-18T09:00:00.000Z") }
    );

    await expect(
      client.getSnapshot({
        market: "BTCUSDT",
        correlationId: "correlation-1",
        signal: undefined
      })
    ).resolves.toEqual({
      market: "BTCUSDT",
      bestBid: "60000.1",
      bestAsk: "60000.2",
      markPrice: "60000.15",
      tickSize: "0.1",
      stepSize: "0.001",
      observedAt: new Date(1_710_000_000_100).toISOString()
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/fapi/v1/ticker/bookTicker?symbol=BTCUSDT"
      })
    );
  });

  it("caches exchange metadata while refreshing prices", async () => {
    const send = binanceTransport();
    const client = new BinanceFuturesMarketDataClient(
      { send },
      { exchangeInfoTtlMs: 300_000, clock: () => new Date("2026-07-18T09:00:00.000Z") }
    );
    const input = {
      market: "BTCUSDT",
      correlationId: "correlation-1",
      signal: undefined
    };

    await client.getSnapshot(input);
    await client.getSnapshot(input);

    expect(
      send.mock.calls.filter((call) => call[0].path === "/fapi/v1/exchangeInfo")
    ).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("rejects a response for a different symbol", async () => {
    const send = binanceTransport({ bookSymbol: "ETHUSDT" });
    const client = new BinanceFuturesMarketDataClient(
      { send },
      { exchangeInfoTtlMs: 300_000 }
    );

    await expect(
      client.getSnapshot({
        market: "BTCUSDT",
        correlationId: "correlation-1",
        signal: undefined
      })
    ).rejects.toBeInstanceOf(ExternalFatalError);
  });
});

function binanceTransport(options: { readonly bookSymbol?: string } = {}) {
  return vi.fn<JsonHttpTransport["send"]>((input) => {
    if (input.path.startsWith("/fapi/v1/ticker/bookTicker")) {
      return Promise.resolve({
        symbol: options.bookSymbol ?? "BTCUSDT",
        bidPrice: "60000.10000000",
        askPrice: "60000.20000000",
        time: 1_710_000_000_000
      });
    }
    if (input.path.startsWith("/fapi/v1/premiumIndex")) {
      return Promise.resolve({
        symbol: "BTCUSDT",
        markPrice: "60000.15000000",
        time: 1_710_000_000_100
      });
    }
    if (input.path === "/fapi/v1/exchangeInfo") {
      return Promise.resolve({
        symbols: [
          {
            symbol: "BTCUSDT",
            status: "TRADING",
            contractType: "PERPETUAL",
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.10000000" },
              { filterType: "LOT_SIZE", stepSize: "0.00100000" }
            ]
          }
        ]
      });
    }
    return Promise.reject(new Error(`Unexpected Binance path ${input.path}`));
  });
}

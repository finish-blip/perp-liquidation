import { describe, expect, it, vi } from "vitest";

import { assertDecimalString } from "../../../../src/domain/shared/decimal.js";
import { assertEntityId } from "../../../../src/domain/shared/id.js";
import { ExternalFatalError } from "../../../../src/domain/shared/errors.js";
import { HttpMarketDataClient } from "../../../../src/infrastructure/http-clients/market-data-client.js";
import { HttpOrderGateway } from "../../../../src/infrastructure/http-clients/order-gateway.js";
import { HttpPortfolioClient } from "../../../../src/infrastructure/http-clients/portfolio-client.js";
import type { JsonHttpTransport } from "../../../../src/infrastructure/http-clients/json-http-transport.js";

describe("HTTP service clients", () => {
  it("parses position and market responses through their contracts", async () => {
    const positionSend = vi.fn<JsonHttpTransport["send"]>(() =>
      Promise.resolve(positionPayload())
    );
    const marketSend = vi.fn<JsonHttpTransport["send"]>(() =>
      Promise.resolve(marketPayload())
    );
    const portfolio = new HttpPortfolioClient({ send: positionSend });
    const market = new HttpMarketDataClient({ send: marketSend });

    const [positionResult, marketResult] = await Promise.all([
      portfolio.getPosition({
        positionId: "position/1",
        correlationId: "correlation-1",
        signal: undefined
      }),
      market.getSnapshot({
        market: "BTC/USDT",
        correlationId: "correlation-1",
        signal: undefined
      })
    ]);

    expect(positionResult.version).toBe(12n);
    expect(marketResult.bestAsk).toBe("100.2");
    expect(positionSend).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/positions/position%2F1" })
    );
    expect(marketSend).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/markets/BTC%2FUSDT/snapshot" })
    );
  });

  it("serializes fencing tokens as strings when placing an order", async () => {
    const send = vi.fn<JsonHttpTransport["send"]>(() =>
      Promise.resolve({ accepted: true, exchange_order_id: "exchange-1" })
    );
    const gateway = new HttpOrderGateway({ send });

    await expect(
      gateway.placeReduceOnly({
        order: {
          clientOrderId: assertEntityId("coid_1", "coid"),
          correlationId: "correlation-1",
          accountId: "account-1",
          positionId: "position-1",
          market: "BTCUSDT",
          side: "SELL",
          quantity: assertDecimalString("0.25"),
          limitPrice: assertDecimalString("99"),
          reduceOnly: true,
          timeInForce: "IOC",
          fencingToken: 9_007_199_254_740_993n
        },
        signal: undefined
      })
    ).resolves.toEqual({ accepted: true, exchangeOrderId: "exchange-1" });
    const request = send.mock.calls[0]?.[0];
    expect(request?.method).toBe("POST");
    expect(request?.body?.fencing_token).toBe("9007199254740993");
    expect(request?.body?.reduce_only).toBe(true);
  });

  it("rejects malformed order responses", async () => {
    const send = vi.fn<JsonHttpTransport["send"]>(() =>
      Promise.resolve({ accepted: true })
    );
    const gateway = new HttpOrderGateway({ send });

    await expect(
      gateway.placeReduceOnly({
        order: {
          clientOrderId: assertEntityId("coid_1", "coid"),
          correlationId: "correlation-1",
          accountId: "account-1",
          positionId: "position-1",
          market: "BTCUSDT",
          side: "SELL",
          quantity: assertDecimalString("0.25"),
          limitPrice: assertDecimalString("99"),
          reduceOnly: true,
          timeInForce: "IOC",
          fencingToken: 17n
        },
        signal: undefined
      })
    ).rejects.toBeInstanceOf(ExternalFatalError);
  });

  it("queries by encoded client order id and preserves an unsigned BIGINT sequence", async () => {
    const send = vi.fn<JsonHttpTransport["send"]>(() =>
      Promise.resolve({
        found: true,
        exchange_order_id: "exchange-1",
        event_sequence: "18446744073709551615",
        event_type: "PARTIALLY_FILLED",
        cumulative_filled_quantity: "0.125",
        occurred_at: "2026-07-18T03:00:00.000Z"
      })
    );
    const gateway = new HttpOrderGateway({ send });

    await expect(
      gateway.getByClientOrderId({
        clientOrderId: assertEntityId("coid_order/1", "coid"),
        correlationId: "correlation-1",
        signal: undefined
      })
    ).resolves.toEqual({
      found: true,
      exchangeOrderId: "exchange-1",
      eventSequence: 18_446_744_073_709_551_615n,
      eventType: "PARTIALLY_FILLED",
      cumulativeFilledQuantity: "0.125",
      occurredAt: "2026-07-18T03:00:00.000Z"
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/v1/orders/by-client-id/coid_order%2F1"
      })
    );
  });

  it("rejects an order query sequence above MySQL UNSIGNED BIGINT", async () => {
    const send = vi.fn<JsonHttpTransport["send"]>(() =>
      Promise.resolve({
        found: true,
        exchange_order_id: "exchange-1",
        event_sequence: "18446744073709551616",
        event_type: "ACCEPTED",
        cumulative_filled_quantity: "0",
        occurred_at: "2026-07-18T03:00:00.000Z"
      })
    );
    const gateway = new HttpOrderGateway({ send });

    await expect(
      gateway.getByClientOrderId({
        clientOrderId: assertEntityId("coid_order_1", "coid"),
        correlationId: "correlation-1",
        signal: undefined
      })
    ).rejects.toBeInstanceOf(ExternalFatalError);
  });
});

function positionPayload(): Record<string, unknown> {
  return {
    position_id: "position-1",
    account_id: "account-1",
    risk_unit_id: "account-1:BTCUSDT",
    market: "BTCUSDT",
    side: "LONG",
    version: "12",
    quantity: "1",
    reducible_quantity: "0.25",
    bankruptcy_price: "80"
  };
}

function marketPayload(): Record<string, unknown> {
  return {
    market: "BTCUSDT",
    best_bid: "100",
    best_ask: "100.2",
    mark_price: "100",
    tick_size: "0.1",
    step_size: "0.01",
    observed_at: "2026-07-18T02:59:59.500Z"
  };
}

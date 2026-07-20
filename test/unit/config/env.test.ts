import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/env.js";

describe("loadConfig stream settings", () => {
  it("loads cluster-compatible stream defaults", () => {
    const config = loadConfig({});

    expect(config.streams).toEqual({
      commands: "liquidation:{engine}:commands",
      orderEvents: "liquidation:{engine}:order-events",
      settlementEvents: "liquidation:{engine}:settlement-events",
      deadLetter: "liquidation:{engine}:dead-letter",
      group: "liquidation-engine",
      consumer: "stream-consumer-1",
      batchSize: 50,
      blockMs: 1000,
      reclaimMinIdleMs: 30000,
      maxDeliveries: 5,
      errorBackoffMs: 1000
    });
    expect(config.binance).toEqual({
      baseUrl: "https://fapi.binance.com",
      timeoutMs: 5000,
      maxGetAttempts: 2,
      exchangeInfoTtlMs: 300000,
      smokeMarket: "BTCUSDT"
    });
    expect(config.rabbit).toEqual({
      url: "amqp://guest:guest@127.0.0.1:5672",
      exchange: "perpetual.events",
      commandQueue: "liquidation.commands.q",
      commandRoutingKey: "risk.liquidation.requested.v1",
      resultRoutingKey: "liquidation.execution.result.v1",
      deadLetterExchange: "perpetual.dead-letter",
      deadLetterQueue: "liquidation.commands.dlq",
      deadLetterRoutingKey: "liquidation.failed",
      retryExchange: "perpetual.retry",
      retryQueue: "liquidation.commands.retry.q",
      retryRoutingKey: "liquidation.retry",
      retryDelayMs: 1000,
      maxRetries: 5,
      prefetch: 10
    });
  });

  it("rejects stream delivery limits outside the bounded retry range", () => {
    expect(() => loadConfig({ STREAM_MAX_DELIVERIES: "0" })).toThrow(
      /Invalid application configuration/
    );
  });

  it("requires service authentication in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/SERVICE_AUTH_TOKEN/);
    expect(
      loadConfig({
        NODE_ENV: "production",
        SERVICE_AUTH_TOKEN: "production-token-1234"
      }).api.serviceAuthToken
    ).toBe("production-token-1234");
  });
});

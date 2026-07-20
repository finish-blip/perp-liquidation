import { describe, expect, it, vi } from "vitest";

import { ExternalRetryableError } from "../../../../src/domain/shared/errors.js";
import {
  UndiciJsonHttpTransport,
  type HttpRequestFunction,
  type RawHttpResponse
} from "../../../../src/infrastructure/http-clients/json-http-transport.js";

describe("UndiciJsonHttpTransport retry policy", () => {
  it("retries an idempotent GET after a retryable status", async () => {
    const request = vi
      .fn<HttpRequestFunction>()
      .mockResolvedValueOnce(response(503, { error: "temporarily unavailable" }))
      .mockResolvedValueOnce(response(200, { value: "ok" }));
    const transport = new UndiciJsonHttpTransport(
      { baseUrl: "http://portfolio.local", timeoutMs: 1000, maxGetAttempts: 2 },
      request
    );

    await expect(
      transport.send({
        method: "GET",
        path: "/v1/position/1",
        correlationId: "correlation-1",
        signal: undefined
      })
    ).resolves.toEqual({ value: "ok" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never retries a POST after a retryable status", async () => {
    const request = vi.fn<HttpRequestFunction>(() =>
      Promise.resolve(response(503, { error: "temporarily unavailable" }))
    );
    const transport = new UndiciJsonHttpTransport(
      { baseUrl: "http://orders.local", timeoutMs: 1000, maxGetAttempts: 3 },
      request
    );

    await expect(
      transport.send({
        method: "POST",
        path: "/v1/orders",
        correlationId: "correlation-1",
        body: { client_order_id: "coid_1" },
        signal: undefined
      })
    ).rejects.toBeInstanceOf(ExternalRetryableError);
    expect(request).toHaveBeenCalledOnce();
  });
});

function response(statusCode: number, body: Record<string, unknown>): RawHttpResponse {
  return {
    statusCode,
    body: {
      text: () => Promise.resolve(JSON.stringify(body))
    }
  };
}

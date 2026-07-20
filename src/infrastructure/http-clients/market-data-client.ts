import type { MarketDataClient } from "../../application/ports/market-data-client.js";
import { parseMarketSnapshot } from "../../domain/execution/market-snapshot.js";
import type { JsonHttpTransport } from "./json-http-transport.js";

export class HttpMarketDataClient implements MarketDataClient {
  constructor(private readonly transport: JsonHttpTransport) {}

  async getSnapshot(
    input: Parameters<MarketDataClient["getSnapshot"]>[0]
  ): ReturnType<MarketDataClient["getSnapshot"]> {
    const payload = await this.transport.send({
      method: "GET",
      path: `/v1/markets/${encodeURIComponent(input.market)}/snapshot`,
      correlationId: input.correlationId,
      signal: input.signal
    });
    return parseMarketSnapshot(payload);
  }
}

import type { PortfolioClient } from "../../application/ports/portfolio-client.js";
import { parsePositionSnapshot } from "../../domain/portfolio/position-snapshot.js";
import type { JsonHttpTransport } from "./json-http-transport.js";

export class HttpPortfolioClient implements PortfolioClient {
  constructor(private readonly transport: JsonHttpTransport) {}

  async getPosition(
    input: Parameters<PortfolioClient["getPosition"]>[0]
  ): ReturnType<PortfolioClient["getPosition"]> {
    const payload = await this.transport.send({
      method: "GET",
      path: `/v1/positions/${encodeURIComponent(input.positionId)}`,
      correlationId: input.correlationId,
      signal: input.signal
    });
    return parsePositionSnapshot(payload);
  }
}

import type { EventPublisher } from "../../application/ports/event-publisher.js";
import type { JsonHttpTransport } from "./json-http-transport.js";

export class HttpEventPublisher implements EventPublisher {
  constructor(private readonly transport: JsonHttpTransport) {}

  async publish(
    message: Parameters<EventPublisher["publish"]>[0],
    signal: AbortSignal | undefined
  ): Promise<void> {
    await this.transport.send({
      method: "POST",
      path: "/v1/events",
      correlationId: message.aggregateId,
      body: {
        message_id: message.id,
        aggregate_type: message.aggregateType,
        aggregate_id: message.aggregateId,
        event_type: message.eventType,
        payload: message.payload
      },
      signal
    });
  }
}

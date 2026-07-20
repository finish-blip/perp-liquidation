import type { ConfirmChannel } from "amqplib";

import type { EventPublisher } from "../../application/ports/event-publisher.js";
import {
  liquidationResultEventFromOutbox
} from "../../domain/integration/liquidation-result-event.js";
import { publishConfirmed } from "./confirmed-publish.js";

export class RabbitLiquidationResultPublisher implements EventPublisher {
  private topologyReady: Promise<void> | undefined;

  constructor(
    private readonly channel: ConfirmChannel,
    private readonly exchange: string,
    private readonly routingKey: string
  ) {}

  async publish(
    message: Parameters<EventPublisher["publish"]>[0],
    signal: AbortSignal | undefined
  ): Promise<void> {
    void signal;
    await this.ensureTopology();
    const event = liquidationResultEventFromOutbox(message);
    await publishConfirmed(this.channel, {
      exchange: this.exchange,
      routingKey: this.routingKey,
      content: Buffer.from(JSON.stringify(event), "utf8"),
      options: {
        contentType: "application/json",
        contentEncoding: "utf8",
        persistent: true,
        messageId: event.eventId,
        correlationId: event.data.riskDecisionId,
        type: event.eventType,
        timestamp: Math.floor(Date.parse(event.occurredAt) / 1000)
      }
    });
  }

  private ensureTopology(): Promise<void> {
    this.topologyReady ??= this.channel
      .assertExchange(this.exchange, "topic", { durable: true })
      .then(() => undefined);
    return this.topologyReady;
  }
}

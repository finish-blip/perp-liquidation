import { createHash } from "node:crypto";

import type { ConfirmChannel, ConsumeMessage } from "amqplib";

import type { ReceiveRiskLiquidationEvent } from "../../application/receive-risk-liquidation-event.js";
import { AppError, ValidationError } from "../../domain/shared/errors.js";
import type { AppLogger } from "../../observability/logger.js";
import { publishConfirmed } from "./confirmed-publish.js";

export type RabbitLiquidationCommandConsumerOptions = {
  readonly exchange: string;
  readonly queue: string;
  readonly routingKey: string;
  readonly resultRoutingKey: string;
  readonly deadLetterExchange: string;
  readonly deadLetterQueue: string;
  readonly deadLetterRoutingKey: string;
  readonly retryExchange: string;
  readonly retryQueue: string;
  readonly retryRoutingKey: string;
  readonly retryDelayMs: number;
  readonly maxRetries: number;
  readonly prefetch: number;
};

export class RabbitLiquidationCommandConsumer {
  private consumerTag: string | undefined;

  constructor(
    private readonly channel: ConfirmChannel,
    private readonly receiver: Pick<ReceiveRiskLiquidationEvent, "execute">,
    private readonly options: RabbitLiquidationCommandConsumerOptions,
    private readonly logger: AppLogger
  ) {
    validateOptions(options);
  }

  async start(): Promise<void> {
    await this.assertTopology();
    await this.channel.prefetch(this.options.prefetch);
    const reply = await this.channel.consume(
      this.options.queue,
      (message) => {
        if (message !== null) {
          void this.processMessage(message);
        }
      },
      { noAck: false }
    );
    this.consumerTag = reply.consumerTag;
    this.logger.info(
      {
        exchange: this.options.exchange,
        queue: this.options.queue,
        routing_key: this.options.routingKey,
        prefetch: this.options.prefetch
      },
      "rabbit liquidation command consumer started"
    );
  }

  async stop(): Promise<void> {
    if (this.consumerTag !== undefined) {
      await this.channel.cancel(this.consumerTag);
      this.consumerTag = undefined;
    }
  }

  private async assertTopology(): Promise<void> {
    await this.channel.assertExchange(this.options.exchange, "topic", { durable: true });
    await this.channel.assertExchange(this.options.deadLetterExchange, "topic", {
      durable: true
    });
    await this.channel.assertExchange(this.options.retryExchange, "direct", {
      durable: true
    });

    await this.channel.assertQueue(this.options.queue, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": this.options.deadLetterExchange,
        "x-dead-letter-routing-key": this.options.deadLetterRoutingKey
      }
    });
    await this.channel.bindQueue(
      this.options.queue,
      this.options.exchange,
      this.options.routingKey
    );

    await this.channel.assertQueue(this.options.deadLetterQueue, { durable: true });
    await this.channel.bindQueue(
      this.options.deadLetterQueue,
      this.options.deadLetterExchange,
      this.options.deadLetterRoutingKey
    );

    await this.channel.assertQueue(this.options.retryQueue, {
      durable: true,
      arguments: {
        "x-message-ttl": this.options.retryDelayMs,
        "x-dead-letter-exchange": this.options.exchange,
        "x-dead-letter-routing-key": this.options.routingKey
      }
    });
    await this.channel.bindQueue(
      this.options.retryQueue,
      this.options.retryExchange,
      this.options.retryRoutingKey
    );
  }

  private async processMessage(message: ConsumeMessage): Promise<void> {
    try {
      const payload = parseJsonMessage(message);
      const result = await this.receiver.execute({ payload });
      const eventId = messageIdFrom(message);
      if (result.outcome.status === "EXPIRED") {
        await this.publishIntakeResult(result.context, "EXPIRED", "COMMAND_EXPIRED");
      } else if (result.outcome.status === "STALE_SEQUENCE") {
        await this.publishIntakeResult(
          result.context,
          "SUPERSEDED",
          "STALE_DECISION_SEQUENCE"
        );
      }
      if (result.usedDerivedDecisionSequence || result.usedDerivedRiskUnitId) {
        this.logger.warn(
          {
            event_id: eventId,
            derived_decision_sequence: result.usedDerivedDecisionSequence,
            derived_risk_unit_id: result.usedDerivedRiskUnitId
          },
          "risk event used compatibility-derived command fields"
        );
      }
      this.channel.ack(message);
      this.logger.info(
        {
          event_id: eventId,
          outcome: result.outcome.status
        },
        "risk liquidation event processed"
      );
    } catch (error) {
      await this.handleFailure(message, error);
    }
  }

  private async handleFailure(message: ConsumeMessage, error: unknown): Promise<void> {
    const retryCount = retryCountFrom(message);
    const eventId = messageIdFrom(message);
    const retryable = !(error instanceof AppError) || error.retryable;
    if (retryable && retryCount < this.options.maxRetries) {
      this.channel.publish(
        this.options.retryExchange,
        this.options.retryRoutingKey,
        message.content,
        {
          persistent: true,
          contentType: "application/json",
          contentEncoding: "utf8",
          ...(eventId === undefined ? {} : { messageId: eventId }),
          headers: {
            "x-retry-count": retryCount + 1
          }
        }
      );
      await this.channel.waitForConfirms();
      this.channel.ack(message);
      this.logger.warn(
        { error, retry_count: retryCount + 1, event_id: eventId },
        "risk liquidation event scheduled for retry"
      );
      return;
    }

    this.channel.nack(message, false, false);
    this.logger.error(
      { error, retry_count: retryCount, event_id: eventId },
      "risk liquidation event rejected to dead letter"
    );
  }

  private async publishIntakeResult(
    context: {
      readonly eventId: string;
      readonly riskDecisionId: string;
      readonly positionId: string;
      readonly positionVersion: string;
      readonly requestedSize: string;
    },
    status: "EXPIRED" | "SUPERSEDED",
    errorCode: string
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    const eventId = `result_${createHash("sha256").update(`${context.eventId}:${status}`).digest("hex").slice(0, 32)}`;
    const event = {
      eventId,
      eventType: "liquidation.execution.result.v1",
      eventVersion: 1,
      occurredAt,
      producer: "liquidation-service",
      data: {
        riskDecisionId: context.riskDecisionId,
        requestEventId: context.eventId,
        taskId: null,
        positionId: context.positionId,
        positionVersion: context.positionVersion,
        status,
        requestedSize: context.requestedSize,
        executedSize: "0",
        averagePrice: null,
        remainingSize: context.requestedSize,
        errorCode,
        errorMessage:
          status === "EXPIRED"
            ? "Liquidation request expired before command intake"
            : "Liquidation request was superseded by a newer decision"
      }
    };
    await publishConfirmed(this.channel, {
      exchange: this.options.exchange,
      routingKey: this.options.resultRoutingKey,
      content: Buffer.from(JSON.stringify(event), "utf8"),
      options: {
        contentType: "application/json",
        contentEncoding: "utf8",
        persistent: true,
        messageId: eventId,
        correlationId: context.riskDecisionId,
        type: event.eventType,
        timestamp: Math.floor(Date.parse(occurredAt) / 1000)
      }
    });
  }
}

function parseJsonMessage(message: ConsumeMessage): unknown {
  try {
    return JSON.parse(message.content.toString("utf8")) as unknown;
  } catch (error) {
    throw new ValidationError("RabbitMQ message body must be valid JSON", {
      error: error instanceof Error ? error.message : "unknown JSON parse error"
    });
  }
}

function retryCountFrom(message: ConsumeMessage): number {
  const value = message.properties.headers?.["x-retry-count"] as unknown;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function messageIdFrom(message: ConsumeMessage): string | undefined {
  const value = message.properties.messageId as unknown;
  return typeof value === "string" ? value : undefined;
}

function validateOptions(options: RabbitLiquidationCommandConsumerOptions): void {
  for (const [field, value] of [
    ["exchange", options.exchange],
    ["queue", options.queue],
    ["routingKey", options.routingKey],
    ["resultRoutingKey", options.resultRoutingKey],
    ["deadLetterExchange", options.deadLetterExchange],
    ["deadLetterQueue", options.deadLetterQueue],
    ["deadLetterRoutingKey", options.deadLetterRoutingKey],
    ["retryExchange", options.retryExchange],
    ["retryQueue", options.retryQueue],
    ["retryRoutingKey", options.retryRoutingKey]
  ] as const) {
    if (value.length < 1 || value.length > 255) {
      throw new ValidationError(`${field} must be between 1 and 255 characters`);
    }
  }
  for (const [field, value, minimum, maximum] of [
    ["retryDelayMs", options.retryDelayMs, 100, 3_600_000],
    ["maxRetries", options.maxRetries, 0, 100],
    ["prefetch", options.prefetch, 1, 1000]
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new ValidationError(`${field} must be between ${minimum} and ${maximum}`);
    }
  }
}

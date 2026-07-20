import type { AppLogger } from "../observability/logger.js";
import { AppError, ValidationError } from "../domain/shared/errors.js";
import { nowUtcIso } from "../domain/shared/time.js";
import type {
  StreamMessage,
  StreamMessageSource
} from "./ports/stream-message-source.js";

export type StreamMessageContext = {
  readonly messageId: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly deliveryCount: number;
  readonly reclaimed: boolean;
};

export type StreamMessageHandler = {
  handle(payload: unknown, context: StreamMessageContext): Promise<void>;
};

export type ConsumeStreamOptions = {
  readonly batchSize: number;
  readonly blockMs: number;
  readonly reclaimMinIdleMs: number;
  readonly maxDeliveries: number;
  readonly errorBackoffMs: number;
};

export type ConsumeStreamBatchResult = {
  readonly received: number;
  readonly processed: number;
  readonly deferred: number;
  readonly dead: number;
};

export type ConsumeStreamDependencies = {
  readonly source: StreamMessageSource;
  readonly handler: StreamMessageHandler;
  readonly logger?: AppLogger;
  readonly clock?: () => Date;
};

export class ConsumeStream {
  private initialized = false;
  private reclaimCursor = "0-0";
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: ConsumeStreamDependencies,
    private readonly options: ConsumeStreamOptions
  ) {
    validateOptions(options);
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async processNextBatch(): Promise<ConsumeStreamBatchResult> {
    await this.ensureInitialized();
    const reclaimed = await this.dependencies.source.reclaim({
      cursor: this.reclaimCursor,
      count: this.options.batchSize,
      minIdleMs: this.options.reclaimMinIdleMs
    });
    this.reclaimCursor = reclaimed.nextCursor;
    const messages =
      reclaimed.messages.length > 0
        ? reclaimed.messages
        : await this.dependencies.source.readNew({
            count: this.options.batchSize,
            blockMs: this.options.blockMs
          });
    const result = {
      received: messages.length,
      processed: 0,
      deferred: 0,
      dead: 0
    };

    for (const message of messages) {
      const disposition = await this.processMessage(message);
      result[disposition] += 1;
    }
    return result;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.processNextBatch();
        if (result.received > 0) {
          this.dependencies.logger?.debug(result, "stream batch processed");
        }
      } catch (error) {
        if (isAborted(signal)) {
          return;
        }
        this.dependencies.logger?.error({ error }, "stream batch failed");
        await sleep(this.options.errorBackoffMs, signal);
      }
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.dependencies.source.ensureGroup();
    this.initialized = true;
  }

  private async processMessage(
    message: StreamMessage
  ): Promise<"processed" | "deferred" | "dead"> {
    let payload: unknown;
    try {
      payload = parsePayload(message);
      await this.dependencies.handler.handle(payload, {
        messageId: message.id,
        fields: message.fields,
        deliveryCount: message.deliveryCount,
        reclaimed: message.reclaimed
      });
    } catch (error) {
      const shouldDeadLetter =
        isPermanentError(error) || message.deliveryCount >= this.options.maxDeliveries;
      if (!shouldDeadLetter) {
        this.dependencies.logger?.warn(
          {
            error,
            messageId: message.id,
            deliveryCount: message.deliveryCount
          },
          "stream message deferred"
        );
        return "deferred";
      }
      await this.dependencies.source.deadLetter({
        message,
        error: errorMessage(error),
        failedAt: nowUtcIso(this.clock)
      });
      this.dependencies.logger?.error(
        { error, messageId: message.id, deliveryCount: message.deliveryCount },
        "stream message moved to dead letter"
      );
      return "dead";
    }

    await this.dependencies.source.acknowledge(message.id);
    return "processed";
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function parsePayload(message: StreamMessage): unknown {
  const payload = message.fields.payload;
  if (payload === undefined) {
    throw new ValidationError("Stream message is missing the payload field");
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new ValidationError("Stream message payload must be valid JSON", {
      messageId: message.id,
      error: errorMessage(error)
    });
  }
}

function isPermanentError(error: unknown): boolean {
  return error instanceof AppError && !error.retryable;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown stream handler error";
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function validateOptions(options: ConsumeStreamOptions): void {
  for (const [field, value, minimum, maximum] of [
    ["batchSize", options.batchSize, 1, 1000],
    ["blockMs", options.blockMs, 1, 60_000],
    ["reclaimMinIdleMs", options.reclaimMinIdleMs, 1000, 3_600_000],
    ["maxDeliveries", options.maxDeliveries, 1, 100],
    ["errorBackoffMs", options.errorBackoffMs, 10, 60_000]
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new ValidationError(`${field} must be between ${minimum} and ${maximum}`);
    }
  }
}

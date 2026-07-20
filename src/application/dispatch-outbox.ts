import type { EventPublisher } from "./ports/event-publisher.js";
import { ValidationError } from "../domain/shared/errors.js";
import { assertEntityId } from "../domain/shared/id.js";
import { addMillis, nowUtcIso } from "../domain/shared/time.js";
import type { OutboxUnitOfWork } from "../repositories/outbox-unit-of-work.js";

export type DispatchOutboxOptions = {
  readonly workerId: string;
  readonly batchSize: number;
  readonly lockMs: number;
  readonly publishTimeoutMs: number;
  readonly maxAttempts: number;
  readonly baseRetryMs: number;
  readonly maxRetryMs: number;
};

export type DispatchOutboxResult = {
  readonly claimed: number;
  readonly published: number;
  readonly deferred: number;
  readonly dead: number;
};

export type DispatchOutboxDependencies = {
  readonly unitOfWork: OutboxUnitOfWork;
  readonly publisher: EventPublisher;
  readonly clock?: () => Date;
};

export class DispatchOutbox {
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: DispatchOutboxDependencies,
    private readonly options: DispatchOutboxOptions
  ) {
    validateOptions(options);
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async execute(): Promise<DispatchOutboxResult> {
    const claimedAt = nowUtcIso(this.clock);
    const messages = await this.dependencies.unitOfWork.execute((repositories) =>
      repositories.outbox.claimDue(
        this.options.workerId,
        addMillis(claimedAt, this.options.lockMs),
        this.options.batchSize
      )
    );
    const result = {
      claimed: messages.length,
      published: 0,
      deferred: 0,
      dead: 0
    };

    for (const message of messages) {
      try {
        await this.dependencies.publisher.publish(
          message,
          AbortSignal.timeout(this.options.publishTimeoutMs)
        );
        const publishedAt = nowUtcIso(this.clock);
        await this.dependencies.unitOfWork.execute(async (repositories) => {
          await repositories.outbox.markPublished(
            message.id,
            this.options.workerId,
            publishedAt
          );
          if (message.eventType !== "LIQUIDATION_EXECUTION_SETTLED") {
            return;
          }
          const task = await repositories.tasks.findById(
            assertEntityId(message.aggregateId, "task")
          );
          if (task?.status !== "RESULT_PUBLISHING") {
            throw new ValidationError(
              "Settled Outbox message does not reference a RESULT_PUBLISHING task"
            );
          }
          const completed = await repositories.tasks.transition(task.id, "COMPLETED", {
            at: publishedAt,
            reason: "settlement result published"
          });
          await repositories.taskEvents.append({
            taskId: completed.id,
            eventType: "TASK_COMPLETED",
            eventSequence: BigInt(completed.version + 1),
            payload: { status: completed.status, outbox_message_id: message.id },
            createdAt: publishedAt
          });
        });
        result.published += 1;
      } catch (error) {
        const lastError = error instanceof Error ? error.message : "unknown publish error";
        const attempt = message.attempts + 1;
        if (attempt >= this.options.maxAttempts) {
          await this.dependencies.unitOfWork.execute((repositories) =>
            repositories.outbox.markDead(message.id, this.options.workerId, lastError)
          );
          result.dead += 1;
        } else {
          const failedAt = nowUtcIso(this.clock);
          const nextAttemptAt = addMillis(failedAt, retryDelayMs(attempt, this.options));
          await this.dependencies.unitOfWork.execute((repositories) =>
            repositories.outbox.markFailed(
              message.id,
              this.options.workerId,
              nextAttemptAt,
              lastError
            )
          );
          result.deferred += 1;
        }
      }
    }

    return result;
  }
}

function retryDelayMs(attempt: number, options: DispatchOutboxOptions): number {
  const multiplier = 2 ** Math.max(0, attempt - 1);
  return Math.min(options.baseRetryMs * multiplier, options.maxRetryMs);
}

function validateOptions(options: DispatchOutboxOptions): void {
  if (options.workerId.length < 1 || options.workerId.length > 128) {
    throw new ValidationError("Outbox workerId must be between 1 and 128 characters");
  }
  for (const [field, value, minimum, maximum] of [
    ["batchSize", options.batchSize, 1, 1000],
    ["lockMs", options.lockMs, 1000, 300_000],
    ["publishTimeoutMs", options.publishTimeoutMs, 100, 30_000],
    ["maxAttempts", options.maxAttempts, 1, 100],
    ["baseRetryMs", options.baseRetryMs, 100, 3_600_000],
    ["maxRetryMs", options.maxRetryMs, 100, 86_400_000]
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new ValidationError(`${field} must be between ${minimum} and ${maximum}`);
    }
  }
  if (options.maxRetryMs < options.baseRetryMs) {
    throw new ValidationError("maxRetryMs must be greater than or equal to baseRetryMs");
  }
}

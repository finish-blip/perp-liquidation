import type { OutboxMessageId } from "../domain/shared/id.js";
import type { UtcIsoString } from "../domain/shared/time.js";

export type OutboxStatus = "PENDING" | "PUBLISHING" | "PUBLISHED" | "DEAD";

export type OutboxMessage = {
  readonly id: OutboxMessageId;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: UtcIsoString;
  readonly lockedBy: string | undefined;
  readonly lockedUntil: UtcIsoString | undefined;
  readonly publishedAt: UtcIsoString | undefined;
  readonly lastError: string | undefined;
};

export type CreateOutboxMessageInput = {
  readonly id: OutboxMessageId;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly nextAttemptAt: UtcIsoString;
};

export type OutboxRepository = {
  create(input: CreateOutboxMessageInput): Promise<OutboxMessage>;
  findById(id: OutboxMessageId): Promise<OutboxMessage | undefined>;
  claimDue(workerId: string, lockedUntil: UtcIsoString, limit: number): Promise<OutboxMessage[]>;
  markPublished(
    id: OutboxMessageId,
    workerId: string,
    publishedAt: UtcIsoString
  ): Promise<void>;
  markFailed(
    id: OutboxMessageId,
    workerId: string,
    nextAttemptAt: UtcIsoString,
    lastError: string
  ): Promise<void>;
  markDead(id: OutboxMessageId, workerId: string, lastError: string): Promise<void>;
  replayDead(id: OutboxMessageId, nextAttemptAt: UtcIsoString): Promise<void>;
};

import { createHash, randomUUID } from "node:crypto";

import { ValidationError } from "./errors.js";

export type EntityId<Prefix extends string> = `${Prefix}_${string}` & {
  readonly __entityIdBrand: Prefix;
};

export type TaskId = EntityId<"task">;
export type InboxMessageId = EntityId<"inbox">;
export type OutboxMessageId = EntityId<"outbox">;
export type ClientOrderId = EntityId<"coid">;

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{1,24}$/;

export function newEntityId<Prefix extends string>(prefix: Prefix): EntityId<Prefix> {
  assertPrefix(prefix);
  return `${prefix}_${randomUUID()}` as EntityId<Prefix>;
}

export function deterministicEntityId<Prefix extends string>(
  prefix: Prefix,
  parts: readonly string[]
): EntityId<Prefix> {
  assertPrefix(prefix);
  const hash = createHash("sha256");

  for (const part of parts) {
    hash.update(part);
    hash.update("\u001f");
  }

  return `${prefix}_${hash.digest("hex").slice(0, 32)}` as EntityId<Prefix>;
}

export function assertEntityId<Prefix extends string>(
  value: string,
  prefix: Prefix
): EntityId<Prefix> {
  assertPrefix(prefix);

  if (!value.startsWith(`${prefix}_`) || value.length <= prefix.length + 1) {
    throw new ValidationError(`id must use prefix ${prefix}`, { value, prefix });
  }

  return value as EntityId<Prefix>;
}

export function newTaskId(): TaskId {
  return newEntityId("task");
}

export function newInboxMessageId(): InboxMessageId {
  return newEntityId("inbox");
}

export function newOutboxMessageId(): OutboxMessageId {
  return newEntityId("outbox");
}

export function deterministicClientOrderId(input: {
  readonly taskId: TaskId;
  readonly stepSequence: number;
  readonly attemptSequence: number;
}): ClientOrderId {
  return deterministicEntityId("coid", [
    input.taskId,
    input.stepSequence.toString(),
    input.attemptSequence.toString()
  ]);
}

function assertPrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new ValidationError("id prefix is invalid", { prefix });
  }
}

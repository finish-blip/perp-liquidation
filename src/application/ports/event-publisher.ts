import type { OutboxMessage } from "../../repositories/outbox-repository.js";

export type EventPublisher = {
  publish(message: OutboxMessage, signal: AbortSignal | undefined): Promise<void>;
};

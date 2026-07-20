import type { OutboxRepository } from "./outbox-repository.js";
import type { TaskEventRepository } from "./task-event-repository.js";
import type { TaskRepository } from "./task-repository.js";

export type OutboxRepositories = {
  readonly outbox: OutboxRepository;
  readonly taskEvents: TaskEventRepository;
  readonly tasks: TaskRepository;
};

export type OutboxUnitOfWork = {
  execute<T>(handler: (repositories: OutboxRepositories) => Promise<T>): Promise<T>;
};

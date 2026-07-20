import type { DecisionSequenceRepository } from "./decision-sequence-repository.js";
import type { ExecutionStepRepository } from "./execution-step-repository.js";
import type { InboxRepository } from "./inbox-repository.js";
import type { OutboxRepository } from "./outbox-repository.js";
import type { TaskEventRepository } from "./task-event-repository.js";
import type { TaskRepository } from "./task-repository.js";

export type CommandIntakeRepositories = {
  readonly decisionSequences: DecisionSequenceRepository;
  readonly executionSteps: ExecutionStepRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
  readonly taskEvents: TaskEventRepository;
  readonly tasks: TaskRepository;
};

export type CommandIntakeUnitOfWork = {
  execute<T>(handler: (repositories: CommandIntakeRepositories) => Promise<T>): Promise<T>;
};

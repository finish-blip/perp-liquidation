import type { ExecutionStepRepository } from "./execution-step-repository.js";
import type { OrderAttemptRepository } from "./order-attempt-repository.js";
import type { OutboxRepository } from "./outbox-repository.js";
import type { RiskUnitFenceRepository } from "./risk-unit-fence-repository.js";
import type { TaskEventRepository } from "./task-event-repository.js";
import type { TaskRepository } from "./task-repository.js";

export type StaticExecutionRepositories = {
  readonly executionSteps: ExecutionStepRepository;
  readonly orderAttempts: OrderAttemptRepository;
  readonly outbox: OutboxRepository;
  readonly riskUnitFences: RiskUnitFenceRepository;
  readonly taskEvents: TaskEventRepository;
  readonly tasks: TaskRepository;
};

export type StaticExecutionUnitOfWork = {
  execute<T>(handler: (repositories: StaticExecutionRepositories) => Promise<T>): Promise<T>;
};

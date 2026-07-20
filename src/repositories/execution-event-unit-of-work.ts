import type {
  OrderEventRepository,
  SettlementEventRepository
} from "./execution-event-repository.js";
import type { ExecutionStepRepository } from "./execution-step-repository.js";
import type { OrderAttemptRepository } from "./order-attempt-repository.js";
import type { OutboxRepository } from "./outbox-repository.js";
import type { RiskUnitFenceRepository } from "./risk-unit-fence-repository.js";
import type { TaskEventRepository } from "./task-event-repository.js";
import type { TaskRepository } from "./task-repository.js";

export type ExecutionEventRepositories = {
  readonly executionSteps: ExecutionStepRepository;
  readonly orderAttempts: OrderAttemptRepository;
  readonly orderEvents: OrderEventRepository;
  readonly outbox: OutboxRepository;
  readonly riskUnitFences: RiskUnitFenceRepository;
  readonly settlementEvents: SettlementEventRepository;
  readonly taskEvents: TaskEventRepository;
  readonly tasks: TaskRepository;
};

export type ExecutionEventUnitOfWork = {
  execute<T>(handler: (repositories: ExecutionEventRepositories) => Promise<T>): Promise<T>;
};

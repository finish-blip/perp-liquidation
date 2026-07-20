import type { ApprovalRepository } from "./approval-repository.js";
import type { OutboxRepository } from "./outbox-repository.js";
import type { RiskUnitFenceRepository } from "./risk-unit-fence-repository.js";
import type { TaskEventRepository } from "./task-event-repository.js";
import type { TaskRepository } from "./task-repository.js";

export type ApprovalRepositories = {
  readonly approvals: ApprovalRepository;
  readonly outbox: OutboxRepository;
  readonly riskUnitFences: RiskUnitFenceRepository;
  readonly taskEvents: TaskEventRepository;
  readonly tasks: TaskRepository;
};

export type ApprovalUnitOfWork = {
  execute<T>(handler: (repositories: ApprovalRepositories) => Promise<T>): Promise<T>;
};

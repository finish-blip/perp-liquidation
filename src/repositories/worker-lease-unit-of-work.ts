import type { RiskUnitFenceRepository } from "./risk-unit-fence-repository.js";
import type { TaskEventRepository } from "./task-event-repository.js";
import type { TaskRepository } from "./task-repository.js";

export type WorkerLeaseRepositories = {
  readonly riskUnitFences: RiskUnitFenceRepository;
  readonly taskEvents: TaskEventRepository;
  readonly tasks: TaskRepository;
};

export type WorkerLeaseUnitOfWork = {
  execute<T>(handler: (repositories: WorkerLeaseRepositories) => Promise<T>): Promise<T>;
};

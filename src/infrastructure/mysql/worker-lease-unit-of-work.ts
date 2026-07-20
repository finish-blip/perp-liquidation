import type { Pool } from "mysql2/promise";

import type {
  WorkerLeaseRepositories,
  WorkerLeaseUnitOfWork
} from "../../repositories/worker-lease-unit-of-work.js";
import { MysqlRiskUnitFenceRepository } from "./risk-unit-fence-repository.js";
import { MysqlTaskEventRepository } from "./task-event-repository.js";
import { MysqlTaskRepository } from "./task-repository.js";
import { withTransaction } from "./transaction.js";

export class MysqlWorkerLeaseUnitOfWork implements WorkerLeaseUnitOfWork {
  constructor(private readonly pool: Pool) {}

  async execute<T>(handler: (repositories: WorkerLeaseRepositories) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (connection) =>
      handler({
        riskUnitFences: new MysqlRiskUnitFenceRepository(connection),
        taskEvents: new MysqlTaskEventRepository(connection),
        tasks: new MysqlTaskRepository(connection)
      })
    );
  }
}

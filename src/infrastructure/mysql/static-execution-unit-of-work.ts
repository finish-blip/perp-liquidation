import type { Pool } from "mysql2/promise";

import type {
  StaticExecutionRepositories,
  StaticExecutionUnitOfWork
} from "../../repositories/static-execution-unit-of-work.js";
import { MysqlExecutionStepRepository } from "./execution-step-repository.js";
import { MysqlOrderAttemptRepository } from "./order-attempt-repository.js";
import { MysqlOutboxRepository } from "./outbox-repository.js";
import { MysqlRiskUnitFenceRepository } from "./risk-unit-fence-repository.js";
import { MysqlTaskEventRepository } from "./task-event-repository.js";
import { MysqlTaskRepository } from "./task-repository.js";
import { withTransaction } from "./transaction.js";

export class MysqlStaticExecutionUnitOfWork implements StaticExecutionUnitOfWork {
  constructor(private readonly pool: Pool) {}

  async execute<T>(
    handler: (repositories: StaticExecutionRepositories) => Promise<T>
  ): Promise<T> {
    return withTransaction(this.pool, async (connection) =>
      handler({
        executionSteps: new MysqlExecutionStepRepository(connection),
        orderAttempts: new MysqlOrderAttemptRepository(connection),
        outbox: new MysqlOutboxRepository(connection),
        riskUnitFences: new MysqlRiskUnitFenceRepository(connection),
        taskEvents: new MysqlTaskEventRepository(connection),
        tasks: new MysqlTaskRepository(connection)
      })
    );
  }
}

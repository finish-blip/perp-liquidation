import type { Pool } from "mysql2/promise";

import type {
  CommandIntakeRepositories,
  CommandIntakeUnitOfWork
} from "../../repositories/command-intake-unit-of-work.js";
import { withTransaction } from "./transaction.js";
import { MysqlDecisionSequenceRepository } from "./decision-sequence-repository.js";
import { MysqlExecutionStepRepository } from "./execution-step-repository.js";
import { MysqlInboxRepository } from "./inbox-repository.js";
import { MysqlOutboxRepository } from "./outbox-repository.js";
import { MysqlTaskEventRepository } from "./task-event-repository.js";
import { MysqlTaskRepository } from "./task-repository.js";

export class MysqlCommandIntakeUnitOfWork implements CommandIntakeUnitOfWork {
  constructor(private readonly pool: Pool) {}

  async execute<T>(
    handler: (repositories: CommandIntakeRepositories) => Promise<T>
  ): Promise<T> {
    return withTransaction(this.pool, async (connection) =>
      handler({
        decisionSequences: new MysqlDecisionSequenceRepository(connection),
        executionSteps: new MysqlExecutionStepRepository(connection),
        inbox: new MysqlInboxRepository(connection),
        outbox: new MysqlOutboxRepository(connection),
        taskEvents: new MysqlTaskEventRepository(connection),
        tasks: new MysqlTaskRepository(connection)
      })
    );
  }
}

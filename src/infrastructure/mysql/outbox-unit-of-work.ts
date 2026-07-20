import type { Pool } from "mysql2/promise";

import type { OutboxUnitOfWork } from "../../repositories/outbox-unit-of-work.js";
import { MysqlOutboxRepository } from "./outbox-repository.js";
import { MysqlTaskEventRepository } from "./task-event-repository.js";
import { MysqlTaskRepository } from "./task-repository.js";
import { withTransaction } from "./transaction.js";

export class MysqlOutboxUnitOfWork implements OutboxUnitOfWork {
  constructor(private readonly pool: Pool) {}

  async execute<T>(
    handler: (repositories: import("../../repositories/outbox-unit-of-work.js").OutboxRepositories) => Promise<T>
  ): Promise<T> {
    return withTransaction(this.pool, async (connection) =>
      handler({
        outbox: new MysqlOutboxRepository(connection),
        taskEvents: new MysqlTaskEventRepository(connection),
        tasks: new MysqlTaskRepository(connection)
      })
    );
  }
}

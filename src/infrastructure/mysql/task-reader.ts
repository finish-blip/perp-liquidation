import type { Pool } from "mysql2/promise";

import type { TaskReader } from "../../repositories/task-reader.js";
import { MysqlTaskRepository } from "./task-repository.js";

export class MysqlTaskReader implements TaskReader {
  constructor(private readonly pool: Pool) {}

  async findById(
    id: Parameters<TaskReader["findById"]>[0]
  ): ReturnType<TaskReader["findById"]> {
    const connection = await this.pool.getConnection();
    try {
      return await new MysqlTaskRepository(connection).findById(id);
    } finally {
      connection.release();
    }
  }
}

import type { PoolConnection } from "mysql2/promise";

import { stringifyJson } from "../../domain/shared/serialization.js";
import type {
  AppendTaskEventInput,
  TaskEventRepository
} from "../../repositories/task-event-repository.js";
import { toMysqlDateTime } from "./mapping.js";

export class MysqlTaskEventRepository implements TaskEventRepository {
  constructor(private readonly connection: PoolConnection) {}

  async append(input: AppendTaskEventInput): Promise<void> {
    await this.connection.execute(
      `INSERT INTO task_events (
        task_id, event_type, event_sequence, payload, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.eventType,
        input.eventSequence.toString(),
        stringifyJson(input.payload),
        toMysqlDateTime(input.createdAt)
      ]
    );
  }
}

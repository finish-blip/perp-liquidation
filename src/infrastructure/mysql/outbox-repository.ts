import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { ConflictError, ValidationError } from "../../domain/shared/errors.js";
import { assertEntityId, type OutboxMessageId } from "../../domain/shared/id.js";
import { stringifyJson } from "../../domain/shared/serialization.js";
import type { UtcIsoString } from "../../domain/shared/time.js";
import type {
  CreateOutboxMessageInput,
  OutboxMessage,
  OutboxRepository,
  OutboxStatus
} from "../../repositories/outbox-repository.js";
import { fromMysqlDateTime, parseMysqlJsonObject, toMysqlDateTime } from "./mapping.js";

type OutboxRow = RowDataPacket & {
  readonly message_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly status: string;
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly locked_by: string | null;
  readonly locked_until: string | null;
  readonly published_at: string | null;
  readonly last_error: string | null;
};

const OUTBOX_COLUMNS = `
  message_id, aggregate_type, aggregate_id, event_type, payload, status,
  attempts, next_attempt_at, locked_by, locked_until, published_at, last_error
`;

export class MysqlOutboxRepository implements OutboxRepository {
  constructor(private readonly connection: PoolConnection) {}

  async create(input: CreateOutboxMessageInput): Promise<OutboxMessage> {
    await this.connection.execute(
      `INSERT INTO outbox_messages (
        message_id, aggregate_type, aggregate_id, event_type, payload,
        status, attempts, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?)`,
      [
        input.id,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        stringifyJson(input.payload),
        toMysqlDateTime(input.nextAttemptAt)
      ]
    );

    return {
      id: input.id,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: input.nextAttemptAt,
      lockedBy: undefined,
      lockedUntil: undefined,
      publishedAt: undefined,
      lastError: undefined
    };
  }

  async findById(id: OutboxMessageId): Promise<OutboxMessage | undefined> {
    const [rows] = await this.connection.execute<OutboxRow[]>(
      `SELECT ${OUTBOX_COLUMNS}
       FROM outbox_messages
       WHERE message_id = ?
       FOR UPDATE`,
      [id]
    );
    return rows[0] === undefined ? undefined : mapOutboxRow(rows[0]);
  }

  async claimDue(
    workerId: string,
    lockedUntil: UtcIsoString,
    limit: number
  ): Promise<OutboxMessage[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ValidationError("Outbox claim limit must be between 1 and 1000", { limit });
    }

    const [rows] = await this.connection.execute<OutboxRow[]>(
      `SELECT ${OUTBOX_COLUMNS}
       FROM outbox_messages
       WHERE next_attempt_at <= UTC_TIMESTAMP(3)
         AND (
           status = 'PENDING'
           OR (status = 'PUBLISHING' AND locked_until <= UTC_TIMESTAMP(3))
         )
       ORDER BY next_attempt_at ASC, id ASC
       LIMIT ${limit}
       FOR UPDATE`
    );

    if (rows.length === 0) {
      return [];
    }

    const messageIds = rows.map((row) => row.message_id);
    const placeholders = messageIds.map(() => "?").join(", ");
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE outbox_messages
       SET status = 'PUBLISHING', locked_by = ?, locked_until = ?
       WHERE message_id IN (${placeholders})`,
      [workerId, toMysqlDateTime(lockedUntil), ...messageIds]
    );

    if (result.affectedRows !== rows.length) {
      throw new ConflictError("Outbox batch changed while being claimed", {
        expected: rows.length,
        actual: result.affectedRows
      });
    }

    return rows.map((row) => ({
      ...mapOutboxRow(row),
      status: "PUBLISHING",
      lockedBy: workerId,
      lockedUntil
    }));
  }

  async markPublished(
    id: OutboxMessageId,
    workerId: string,
    publishedAt: UtcIsoString
  ): Promise<void> {
    await this.updateOne(
      `UPDATE outbox_messages
       SET status = 'PUBLISHED', published_at = ?, locked_by = NULL,
           locked_until = NULL, last_error = NULL
       WHERE message_id = ? AND status = 'PUBLISHING' AND locked_by = ?`,
      [toMysqlDateTime(publishedAt), id, workerId],
      id
    );
  }

  async markFailed(
    id: OutboxMessageId,
    workerId: string,
    nextAttemptAt: UtcIsoString,
    lastError: string
  ): Promise<void> {
    await this.updateOne(
      `UPDATE outbox_messages
       SET status = 'PENDING', attempts = attempts + 1, next_attempt_at = ?,
           locked_by = NULL, locked_until = NULL, last_error = ?
       WHERE message_id = ? AND status = 'PUBLISHING' AND locked_by = ?`,
      [toMysqlDateTime(nextAttemptAt), lastError, id, workerId],
      id
    );
  }

  async markDead(
    id: OutboxMessageId,
    workerId: string,
    lastError: string
  ): Promise<void> {
    await this.updateOne(
      `UPDATE outbox_messages
       SET status = 'DEAD', attempts = attempts + 1, locked_by = NULL,
           locked_until = NULL, last_error = ?
       WHERE message_id = ? AND status = 'PUBLISHING' AND locked_by = ?`,
      [lastError, id, workerId],
      id
    );
  }

  async replayDead(id: OutboxMessageId, nextAttemptAt: UtcIsoString): Promise<void> {
    await this.updateOne(
      `UPDATE outbox_messages
       SET status = 'PENDING', attempts = 0, next_attempt_at = ?,
           locked_by = NULL, locked_until = NULL, published_at = NULL,
           last_error = NULL
       WHERE message_id = ? AND status = 'DEAD'`,
      [toMysqlDateTime(nextAttemptAt), id],
      id
    );
  }

  private async updateOne(
    sql: string,
    values: (string | number | null)[],
    id: OutboxMessageId
  ): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(sql, values);
    if (result.affectedRows !== 1) {
      throw new ConflictError("Outbox message was not in the expected state", {
        outboxMessageId: id
      });
    }
  }
}

function mapOutboxRow(row: OutboxRow): OutboxMessage {
  return {
    id: assertEntityId(row.message_id, "outbox"),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: parseMysqlJsonObject(row.payload),
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    nextAttemptAt: fromMysqlDateTime(row.next_attempt_at),
    lockedBy: row.locked_by ?? undefined,
    lockedUntil: row.locked_until === null ? undefined : fromMysqlDateTime(row.locked_until),
    publishedAt: row.published_at === null ? undefined : fromMysqlDateTime(row.published_at),
    lastError: row.last_error ?? undefined
  };
}

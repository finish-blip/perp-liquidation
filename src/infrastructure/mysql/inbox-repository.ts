import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { isDeepStrictEqual } from "node:util";

import { liquidationCommandToPayload } from "../../domain/commands/liquidation-command-parser.js";
import { ConflictError, InvariantViolationError } from "../../domain/shared/errors.js";
import { assertEntityId, type TaskId } from "../../domain/shared/id.js";
import { stringifyJson } from "../../domain/shared/serialization.js";
import type {
  InboxReceipt,
  InboxRepository,
  MarkInboxProcessedInput,
  MarkInboxStaleInput,
  RecordInboxMessageInput
} from "../../repositories/inbox-repository.js";
import { parseMysqlJsonObject, toMysqlDateTime } from "./mapping.js";

type ExistingInboxRow = RowDataPacket & {
  readonly task_id: string | null;
  readonly source: string;
  readonly payload: unknown;
};

export class MysqlInboxRepository implements InboxRepository {
  constructor(private readonly connection: PoolConnection) {}

  async record(input: RecordInboxMessageInput): Promise<InboxReceipt> {
    const payload = liquidationCommandToPayload(input.command);
    const [result] = await this.connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO inbox_messages (
        message_id, source, correlation_id, command_type, decision_sequence,
        risk_unit_id, payload, received_at, disposition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED')`,
      [
        input.command.messageId,
        input.source,
        input.command.correlationId,
        input.command.commandType,
        input.command.decisionSequence.toString(),
        input.command.riskUnitId,
        stringifyJson(payload),
        toMysqlDateTime(input.receivedAt)
      ]
    );

    if (result.affectedRows === 1) {
      return {
        status: "RECORDED",
        messageId: input.command.messageId
      };
    }

    const [rows] = await this.connection.execute<ExistingInboxRow[]>(
      `SELECT task_id, source, payload
       FROM inbox_messages
       WHERE message_id = ?
       FOR UPDATE`,
      [input.command.messageId]
    );
    const existing = rows[0];

    if (existing === undefined) {
      throw new InvariantViolationError("Inbox duplicate was not readable after INSERT IGNORE", {
        messageId: input.command.messageId
      });
    }
    if (
      existing.source !== input.source ||
      !isDeepStrictEqual(parseMysqlJsonObject(existing.payload), payload)
    ) {
      throw new ConflictError("message_id was already used for a different command", {
        messageId: input.command.messageId
      });
    }

    return {
      status: "DUPLICATE",
      messageId: input.command.messageId,
      ...(existing.task_id === null
        ? {}
        : { existingTaskId: assertEntityId(existing.task_id, "task") })
    };
  }

  async markProcessed(input: MarkInboxProcessedInput): Promise<void> {
    await this.updateDisposition(
      input.messageId,
      input.taskId,
      "PROCESSED",
      toMysqlDateTime(input.processedAt)
    );
  }

  async markStale(input: MarkInboxStaleInput): Promise<void> {
    await this.updateDisposition(
      input.messageId,
      input.existingTaskId,
      "STALE_SEQUENCE",
      toMysqlDateTime(input.processedAt)
    );
  }

  private async updateDisposition(
    messageId: string,
    taskId: TaskId,
    disposition: "PROCESSED" | "STALE_SEQUENCE",
    processedAt: string
  ): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE inbox_messages
       SET task_id = ?, disposition = ?, processed_at = ?
       WHERE message_id = ? AND disposition = 'RECEIVED'`,
      [taskId, disposition, processedAt, messageId]
    );

    if (result.affectedRows !== 1) {
      throw new InvariantViolationError("Inbox message was not in RECEIVED disposition", {
        messageId,
        disposition
      });
    }
  }
}

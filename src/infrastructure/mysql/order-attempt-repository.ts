import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { assertDecimalString } from "../../domain/shared/decimal.js";
import { ConflictError, InvariantViolationError } from "../../domain/shared/errors.js";
import { assertEntityId } from "../../domain/shared/id.js";
import { stringifyJson } from "../../domain/shared/serialization.js";
import type {
  CreateOrderAttemptInput,
  OrderAttemptRecord,
  OrderAttemptRepository,
  OrderAttemptStatus
} from "../../repositories/order-attempt-repository.js";
import { parseMysqlJsonObject, toMysqlDateTime } from "./mapping.js";

type OrderAttemptRow = RowDataPacket & {
  readonly id: string;
  readonly task_id: string;
  readonly execution_step_id: string;
  readonly attempt_sequence: number;
  readonly client_order_id: string;
  readonly exchange_order_id: string | null;
  readonly status: string;
  readonly requested_quantity: string;
  readonly requested_price: string;
  readonly filled_quantity: string;
  readonly last_event_sequence: string | null;
  readonly request_payload: unknown;
};

export class MysqlOrderAttemptRepository implements OrderAttemptRepository {
  constructor(private readonly connection: PoolConnection) {}

  async create(input: CreateOrderAttemptInput): Promise<OrderAttemptRecord> {
    await this.connection.execute(
      `INSERT INTO order_attempts (
        task_id, execution_step_id, attempt_sequence, client_order_id, status,
        requested_quantity, requested_price, filled_quantity, request_payload, created_at
      ) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, '0', ?, ?)`,
      [
        input.taskId,
        input.executionStepId.toString(),
        input.attemptSequence,
        input.clientOrderId,
        input.requestedQuantity,
        input.requestedPrice,
        stringifyJson(input.requestPayload),
        toMysqlDateTime(input.createdAt)
      ]
    );

    const [rows] = await this.connection.execute<OrderAttemptRow[]>(
      `SELECT id, task_id, execution_step_id, attempt_sequence, client_order_id,
              exchange_order_id, status, requested_quantity, requested_price,
              filled_quantity, last_event_sequence, request_payload
       FROM order_attempts
       WHERE client_order_id = ?
       FOR UPDATE`,
      [input.clientOrderId]
    );
    const row = rows[0];
    if (row === undefined) {
      throw new InvariantViolationError("Order attempt was not readable after insert", {
        clientOrderId: input.clientOrderId
      });
    }
    return mapOrderAttempt(row);
  }

  async findByClientOrderId(
    clientOrderId: import("../../domain/shared/id.js").ClientOrderId
  ): Promise<OrderAttemptRecord | undefined> {
    const [rows] = await this.connection.execute<OrderAttemptRow[]>(
      `SELECT id, task_id, execution_step_id, attempt_sequence, client_order_id,
              exchange_order_id, status, requested_quantity, requested_price,
              filled_quantity, last_event_sequence, request_payload
       FROM order_attempts
       WHERE client_order_id = ?
       FOR UPDATE`,
      [clientOrderId]
    );
    return rows[0] === undefined ? undefined : mapOrderAttempt(rows[0]);
  }

  async findLatestForTask(
    taskId: import("../../domain/shared/id.js").TaskId
  ): Promise<OrderAttemptRecord | undefined> {
    const [rows] = await this.connection.execute<OrderAttemptRow[]>(
      `SELECT id, task_id, execution_step_id, attempt_sequence, client_order_id,
              exchange_order_id, status, requested_quantity, requested_price,
              filled_quantity, last_event_sequence, request_payload
       FROM order_attempts
       WHERE task_id = ?
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [taskId]
    );
    return rows[0] === undefined ? undefined : mapOrderAttempt(rows[0]);
  }

  async findLatestForStep(executionStepId: bigint): Promise<OrderAttemptRecord | undefined> {
    const [rows] = await this.connection.execute<OrderAttemptRow[]>(
      `SELECT id, task_id, execution_step_id, attempt_sequence, client_order_id,
              exchange_order_id, status, requested_quantity, requested_price,
              filled_quantity, last_event_sequence, request_payload
       FROM order_attempts
       WHERE execution_step_id = ?
       ORDER BY attempt_sequence DESC
       LIMIT 1
       FOR UPDATE`,
      [executionStepId.toString()]
    );
    return rows[0] === undefined ? undefined : mapOrderAttempt(rows[0]);
  }

  async applyEvent(
    input: Parameters<OrderAttemptRepository["applyEvent"]>[0]
  ): Promise<OrderAttemptRecord> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE order_attempts
       SET status = ?, exchange_order_id = ?, filled_quantity = ?,
           last_event_sequence = ?, terminal_at = ?
       WHERE id = ?
         AND (last_event_sequence IS NULL OR last_event_sequence < ?)`,
      [
        input.status,
        input.exchangeOrderId,
        input.filledQuantity,
        input.eventSequence.toString(),
        input.terminalAt === undefined ? null : toMysqlDateTime(input.terminalAt),
        input.id.toString(),
        input.eventSequence.toString()
      ]
    );
    if (result.affectedRows !== 1) {
      throw new ConflictError("Order event sequence is not newer than the stored sequence", {
        orderAttemptId: input.id.toString(),
        eventSequence: input.eventSequence.toString()
      });
    }

    const [rows] = await this.connection.execute<OrderAttemptRow[]>(
      `SELECT id, task_id, execution_step_id, attempt_sequence, client_order_id,
              exchange_order_id, status, requested_quantity, requested_price,
              filled_quantity, last_event_sequence, request_payload
       FROM order_attempts
       WHERE id = ?
       FOR UPDATE`,
      [input.id.toString()]
    );
    const row = rows[0];
    if (row === undefined) {
      throw new InvariantViolationError("Order attempt disappeared after event update", {
        orderAttemptId: input.id.toString()
      });
    }
    return mapOrderAttempt(row);
  }

  async markAccepted(
    id: bigint,
    exchangeOrderId: string,
    responsePayload: Record<string, unknown>,
    submittedAt: import("../../domain/shared/time.js").UtcIsoString
  ): Promise<void> {
    await this.updateTerminal(
      `UPDATE order_attempts
       SET status = 'ACCEPTED', exchange_order_id = ?, response_payload = ?, submitted_at = ?
       WHERE id = ? AND status = 'CREATED'`,
      [
        exchangeOrderId,
        stringifyJson(responsePayload),
        toMysqlDateTime(submittedAt),
        id.toString()
      ],
      id,
      "ACCEPTED"
    );
  }

  async markUnknown(
    id: bigint,
    lastError: string,
    submittedAt: import("../../domain/shared/time.js").UtcIsoString
  ): Promise<void> {
    await this.updateTerminal(
      `UPDATE order_attempts
       SET status = 'UNKNOWN', response_payload = ?, submitted_at = ?
       WHERE id = ? AND status = 'CREATED'`,
      [
        stringifyJson({ error: lastError }),
        toMysqlDateTime(submittedAt),
        id.toString()
      ],
      id,
      "UNKNOWN"
    );
  }

  async markRejected(
    id: bigint,
    reason: string,
    responsePayload: Record<string, unknown>,
    terminalAt: import("../../domain/shared/time.js").UtcIsoString
  ): Promise<void> {
    await this.updateTerminal(
      `UPDATE order_attempts
       SET status = 'REJECTED', response_payload = ?, terminal_at = ?
       WHERE id = ? AND status = 'CREATED'`,
      [
        stringifyJson({ reason, ...responsePayload }),
        toMysqlDateTime(terminalAt),
        id.toString()
      ],
      id,
      "REJECTED"
    );
  }

  private async updateTerminal(
    sql: string,
    values: (string | number | null)[],
    id: bigint,
    status: OrderAttemptStatus
  ): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(sql, values);
    if (result.affectedRows !== 1) {
      throw new ConflictError(`Order attempt could not enter ${status}`, {
        orderAttemptId: id.toString()
      });
    }
  }
}

function mapOrderAttempt(row: OrderAttemptRow): OrderAttemptRecord {
  return {
    id: BigInt(row.id),
    taskId: assertEntityId(row.task_id, "task"),
    executionStepId: BigInt(row.execution_step_id),
    attemptSequence: row.attempt_sequence,
    clientOrderId: assertEntityId(row.client_order_id, "coid"),
    exchangeOrderId: row.exchange_order_id ?? undefined,
    status: row.status as OrderAttemptStatus,
    requestedQuantity: assertDecimalString(row.requested_quantity),
    requestedPrice: assertDecimalString(row.requested_price),
    filledQuantity: assertDecimalString(row.filled_quantity),
    lastEventSequence:
      row.last_event_sequence === null ? undefined : BigInt(row.last_event_sequence),
    requestPayload: parseMysqlJsonObject(row.request_payload)
  };
}

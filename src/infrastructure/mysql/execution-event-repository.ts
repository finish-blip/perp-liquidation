import { isDeepStrictEqual } from "node:util";

import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { orderEventToPayload, type OrderEvent } from "../../domain/execution/order-event.js";
import {
  parseSettlementEvent,
  settlementEventToPayload,
  type SettlementEvent
} from "../../domain/execution/settlement-event.js";
import type { TaskId } from "../../domain/shared/id.js";
import { ConflictError, InvariantViolationError } from "../../domain/shared/errors.js";
import { stringifyJson } from "../../domain/shared/serialization.js";
import type { UtcIsoString } from "../../domain/shared/time.js";
import type {
  ExecutionEventDisposition,
  ExecutionEventReceipt,
  OrderEventRepository,
  SettlementEventRepository
} from "../../repositories/execution-event-repository.js";
import { parseMysqlJsonObject, toMysqlDateTime } from "./mapping.js";

type ExistingEventRow = RowDataPacket & {
  readonly event_id: string;
  readonly payload: unknown;
};

type StoredEventRow = RowDataPacket & {
  readonly payload: unknown;
};

export class MysqlOrderEventRepository implements OrderEventRepository {
  constructor(private readonly connection: PoolConnection) {}

  async record(event: OrderEvent, receivedAt: UtcIsoString): Promise<ExecutionEventReceipt> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO order_events (
        event_id, client_order_id, event_sequence, event_type, payload, received_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.eventId,
        event.clientOrderId,
        event.eventSequence.toString(),
        event.eventType,
        stringifyJson(orderEventToPayload(event)),
        toMysqlDateTime(receivedAt)
      ]
    );
    if (result.affectedRows !== 1) {
      await assertMatchingDuplicate(
        this.connection,
        "order_events",
        event.eventId,
        event.clientOrderId,
        event.eventSequence,
        orderEventToPayload(event)
      );
    }
    return { status: result.affectedRows === 1 ? "RECORDED" : "DUPLICATE", eventId: event.eventId };
  }

  async markDisposition(
    eventId: string,
    disposition: ExecutionEventDisposition,
    processedAt: UtcIsoString
  ): Promise<void> {
    await markDisposition(
      this.connection,
      "order_events",
      eventId,
      disposition,
      processedAt
    );
  }
}

export class MysqlSettlementEventRepository implements SettlementEventRepository {
  constructor(private readonly connection: PoolConnection) {}

  async record(
    event: SettlementEvent,
    receivedAt: UtcIsoString
  ): Promise<ExecutionEventReceipt> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO settlement_events (
        event_id, client_order_id, settlement_sequence, payload, received_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        event.eventId,
        event.clientOrderId,
        event.settlementSequence.toString(),
        stringifyJson(settlementEventToPayload(event)),
        toMysqlDateTime(receivedAt)
      ]
    );
    if (result.affectedRows !== 1) {
      await assertMatchingDuplicate(
        this.connection,
        "settlement_events",
        event.eventId,
        event.clientOrderId,
        event.settlementSequence,
        settlementEventToPayload(event)
      );
    }
    return { status: result.affectedRows === 1 ? "RECORDED" : "DUPLICATE", eventId: event.eventId };
  }

  async listForTask(taskId: TaskId): Promise<readonly SettlementEvent[]> {
    const [rows] = await this.connection.execute<StoredEventRow[]>(
      `SELECT settlement_events.payload
       FROM settlement_events
       INNER JOIN order_attempts
         ON order_attempts.client_order_id = settlement_events.client_order_id
       WHERE order_attempts.task_id = ?
       ORDER BY settlement_events.id ASC
       FOR UPDATE`,
      [taskId]
    );
    return rows.map((row) => parseSettlementEvent(parseMysqlJsonObject(row.payload)));
  }

  async markDisposition(
    eventId: string,
    disposition: ExecutionEventDisposition,
    processedAt: UtcIsoString
  ): Promise<void> {
    await markDisposition(
      this.connection,
      "settlement_events",
      eventId,
      disposition,
      processedAt
    );
  }
}

async function assertMatchingDuplicate(
  connection: PoolConnection,
  table: "order_events" | "settlement_events",
  eventId: string,
  clientOrderId: string,
  sequence: bigint,
  payload: Record<string, unknown>
): Promise<void> {
  const sequenceColumn = table === "order_events" ? "event_sequence" : "settlement_sequence";
  const [rows] = await connection.execute<ExistingEventRow[]>(
    `SELECT event_id, payload FROM ${table}
     WHERE event_id = ? OR (client_order_id = ? AND ${sequenceColumn} = ?)
     FOR UPDATE`,
    [eventId, clientOrderId, sequence.toString()]
  );
  const existing = rows[0];
  if (existing === undefined) {
    throw new InvariantViolationError("Ignored execution event was not readable", { eventId });
  }
  if (
    existing.event_id !== eventId ||
    !isDeepStrictEqual(parseMysqlJsonObject(existing.payload), payload)
  ) {
    throw new ConflictError("Execution event identity was reused with different content", {
      eventId,
      clientOrderId,
      sequence: sequence.toString()
    });
  }
}

async function markDisposition(
  connection: PoolConnection,
  table: "order_events" | "settlement_events",
  eventId: string,
  disposition: ExecutionEventDisposition,
  processedAt: UtcIsoString
): Promise<void> {
  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE ${table}
     SET disposition = ?, processed_at = ?
     WHERE event_id = ? AND disposition = 'RECEIVED'`,
    [disposition, toMysqlDateTime(processedAt), eventId]
  );
  if (result.affectedRows !== 1) {
    throw new ConflictError("Execution event was not in RECEIVED disposition", {
      table,
      eventId
    });
  }
}

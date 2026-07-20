import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type { LiquidationCommandType } from "../../domain/commands/liquidation-command.js";
import {
  transition as transitionTask,
  type TaskStatus,
  type TransitionContext
} from "../../domain/liquidation/task-state.js";
import {
  ConflictError,
  InvariantViolationError,
  ValidationError
} from "../../domain/shared/errors.js";
import { assertEntityId, type TaskId } from "../../domain/shared/id.js";
import { stringifyJson } from "../../domain/shared/serialization.js";
import type { UtcIsoString } from "../../domain/shared/time.js";
import type {
  ClaimTaskInput,
  CreateTaskInput,
  FindExpiredLeasedTasksInput,
  AttachTaskFencingTokenInput,
  RenewTaskLeaseInput,
  TaskRecord,
  TaskRepository
} from "../../repositories/task-repository.js";
import { fromMysqlDateTime, parseMysqlJsonObject, toMysqlDateTime } from "./mapping.js";

type TaskRow = RowDataPacket & {
  readonly id: string;
  readonly inbox_message_id: string;
  readonly correlation_id: string;
  readonly risk_unit_id: string;
  readonly command_type: string;
  readonly status: string;
  readonly status_reason: string | null;
  readonly priority: number;
  readonly decision_sequence: string;
  readonly fencing_token: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly version: string;
  readonly command_payload: unknown;
  readonly created_at: string;
  readonly updated_at: string;
};

const TASK_COLUMNS = `
  id, inbox_message_id, correlation_id, risk_unit_id, command_type, status,
  status_reason, priority, decision_sequence, fencing_token, lease_owner,
  lease_expires_at, version, command_payload, created_at, updated_at
`;

export class MysqlTaskRepository implements TaskRepository {
  constructor(private readonly connection: PoolConnection) {}

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const now = toMysqlDateTime(input.now);
    await this.connection.execute<ResultSetHeader>(
      `INSERT INTO tasks (
        id, inbox_message_id, correlation_id, risk_unit_id, command_type, status,
        priority, decision_sequence, version, command_payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'RECEIVED', ?, ?, 0, ?, ?, ?)`,
      [
        input.id,
        input.inboxMessageId,
        input.correlationId,
        input.riskUnitId,
        input.commandType,
        input.priority,
        input.decisionSequence.toString(),
        stringifyJson(input.commandPayload),
        now,
        now
      ]
    );

    return {
      id: input.id,
      inboxMessageId: input.inboxMessageId,
      correlationId: input.correlationId,
      riskUnitId: input.riskUnitId,
      commandType: input.commandType,
      status: "RECEIVED",
      priority: input.priority,
      decisionSequence: input.decisionSequence,
      fencingToken: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      version: 0,
      commandPayload: input.commandPayload,
      createdAt: input.now,
      updatedAt: input.now
    };
  }

  async findById(id: TaskId): Promise<TaskRecord | undefined> {
    const [rows] = await this.connection.execute<TaskRow[]>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`,
      [id]
    );
    return rows[0] === undefined ? undefined : mapTaskRow(rows[0]);
  }

  async findSupersedable(riskUnitId: string, beforeSequence: bigint): Promise<TaskRecord[]> {
    const [rows] = await this.connection.execute<TaskRow[]>(
      `SELECT ${TASK_COLUMNS}
       FROM tasks
       WHERE risk_unit_id = ?
         AND decision_sequence < ?
         AND status IN ('RECEIVED', 'READY')
       ORDER BY decision_sequence ASC
       FOR UPDATE`,
      [riskUnitId, beforeSequence.toString()]
    );
    return rows.map(mapTaskRow);
  }

  async findExpiredLeased(input: FindExpiredLeasedTasksInput): Promise<TaskRecord[]> {
    assertBatchLimit(input.limit);
    const [rows] = await this.connection.execute<TaskRow[]>(
      `SELECT ${TASK_COLUMNS}
       FROM tasks
       WHERE lease_owner IS NOT NULL
         AND lease_expires_at <= ?
         AND status IN (
           'CLAIMED', 'VALIDATING', 'PLANNING', 'ORDER_SUBMITTING',
           'WAITING_ORDER_EVENT', 'WAITING_SETTLEMENT', 'STEP_COMPLETED',
           'LOSS_MITIGATION', 'RESULT_PUBLISHING'
         )
       ORDER BY lease_expires_at ASC
       LIMIT ${input.limit}
       FOR UPDATE`,
      [toMysqlDateTime(input.now)]
    );
    return rows.map(mapTaskRow);
  }

  async transition(
    id: TaskId,
    to: TaskStatus,
    context: TransitionContext
  ): Promise<TaskRecord> {
    const current = await this.findByIdForUpdate(id);
    const next = transitionTask(current, to, context);

    await this.persistTransition(current, next.status, next.version, next.statusReason, context);

    return {
      ...current,
      ...next,
      ...(clearsLease(to)
        ? { leaseOwner: undefined, leaseExpiresAt: undefined }
        : {})
    };
  }

  async claimNext(input: ClaimTaskInput): Promise<TaskRecord | undefined> {
    if (input.statuses.length === 0) {
      return undefined;
    }

    assertPriorityAgingInterval(input.priorityAgingIntervalSeconds);
    assertFutureLease(input.leaseExpiresAt, input.now);
    const statusPlaceholders = input.statuses.map(() => "?").join(", ");
    const [rows] = await this.connection.execute<TaskRow[]>(
      `SELECT ${TASK_COLUMNS}
       FROM tasks AS candidate
       WHERE candidate.status IN (${statusPlaceholders})
         AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at <= ?)
         AND NOT EXISTS (
           SELECT 1
           FROM tasks AS predecessor
           WHERE predecessor.risk_unit_id = candidate.risk_unit_id
             AND predecessor.decision_sequence < candidate.decision_sequence
             AND predecessor.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
         )
       ORDER BY (
         candidate.priority + FLOOR(
           GREATEST(TIMESTAMPDIFF(SECOND, candidate.created_at, ?), 0) / ?
         )
       ) DESC, candidate.created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [
        ...input.statuses,
        toMysqlDateTime(input.now),
        toMysqlDateTime(input.now),
        input.priorityAgingIntervalSeconds
      ]
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }

    const current = mapTaskRow(row);
    const context: TransitionContext = {
      at: input.now,
      reason: `claimed by ${input.workerId}`
    };
    const next = transitionTask(current, "CLAIMED", context);
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE tasks
       SET status = ?, status_reason = ?, version = ?, updated_at = ?,
           lease_owner = ?, lease_expires_at = ?
       WHERE id = ? AND version = ?`,
      [
        next.status,
        next.statusReason ?? null,
        next.version,
        toMysqlDateTime(input.now),
        input.workerId,
        toMysqlDateTime(input.leaseExpiresAt),
        current.id,
        current.version
      ]
    );

    if (result.affectedRows !== 1) {
      throw new ConflictError("Task changed while being claimed", { taskId: current.id });
    }

    return {
      ...current,
      ...next,
      leaseOwner: input.workerId,
      leaseExpiresAt: input.leaseExpiresAt
    };
  }

  async attachFencingToken(input: AttachTaskFencingTokenInput): Promise<TaskRecord> {
    const current = await this.findByIdForUpdate(input.taskId);
    assertLeaseOwnership(current, input.workerId, input.now);

    if (
      current.fencingToken !== undefined &&
      current.fencingToken > input.fencingToken
    ) {
      throw new ConflictError("Task already has a newer fencing token", {
        taskId: current.id,
        currentFencingToken: current.fencingToken.toString(),
        attemptedFencingToken: input.fencingToken.toString()
      });
    }

    if (current.fencingToken !== input.fencingToken) {
      const [result] = await this.connection.execute<ResultSetHeader>(
        `UPDATE tasks
         SET fencing_token = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND version = ?`,
        [
          input.fencingToken.toString(),
          toMysqlDateTime(input.now),
          current.id,
          input.workerId,
          current.version
        ]
      );
      if (result.affectedRows !== 1) {
        throw new ConflictError("Task changed while attaching fencing token", {
          taskId: current.id
        });
      }
    }

    return {
      ...current,
      fencingToken: input.fencingToken,
      updatedAt: input.now
    };
  }

  async renewLease(input: RenewTaskLeaseInput): Promise<TaskRecord> {
    assertFutureLease(input.leaseExpiresAt, input.now);
    const current = await this.findByIdForUpdate(input.taskId);
    assertLeaseOwnership(current, input.workerId, input.now);

    if (current.fencingToken !== input.fencingToken) {
      throw new ConflictError("Task fencing token does not match during lease renewal", {
        taskId: current.id
      });
    }

    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE tasks
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND fencing_token = ? AND version = ?`,
      [
        toMysqlDateTime(input.leaseExpiresAt),
        toMysqlDateTime(input.now),
        current.id,
        input.workerId,
        input.fencingToken.toString(),
        current.version
      ]
    );
    if (result.affectedRows !== 1) {
      throw new ConflictError("Task changed during lease renewal", { taskId: current.id });
    }

    return {
      ...current,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.now
    };
  }

  private async findByIdForUpdate(id: TaskId): Promise<TaskRecord> {
    const [rows] = await this.connection.execute<TaskRow[]>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? FOR UPDATE`,
      [id]
    );
    const row = rows[0];

    if (row === undefined) {
      throw new InvariantViolationError("Task does not exist", { taskId: id });
    }

    return mapTaskRow(row);
  }

  private async persistTransition(
    current: TaskRecord,
    status: TaskStatus,
    version: number,
    statusReason: string | undefined,
    context: TransitionContext
  ): Promise<void> {
    const clearLease = clearsLease(status);
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE tasks
       SET status = ?, status_reason = ?, version = ?, updated_at = ?,
           lease_owner = ${clearLease ? "NULL" : "lease_owner"},
           lease_expires_at = ${clearLease ? "NULL" : "lease_expires_at"}
       WHERE id = ? AND version = ?`,
      [
        status,
        statusReason ?? null,
        version,
        toMysqlDateTime(context.at),
        current.id,
        current.version
      ]
    );

    if (result.affectedRows !== 1) {
      throw new ConflictError("Task changed during state transition", {
        taskId: current.id,
        expectedVersion: current.version
      });
    }
  }
}

function assertBatchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ValidationError("Task batch limit must be between 1 and 1000", { limit });
  }
}

function assertPriorityAgingInterval(intervalSeconds: number): void {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 86_400) {
    throw new ValidationError("Priority aging interval must be between 1 and 86400 seconds", {
      intervalSeconds
    });
  }
}

function assertLeaseOwnership(task: TaskRecord, workerId: string, now: UtcIsoString): void {
  if (task.leaseOwner !== workerId || task.leaseExpiresAt === undefined) {
    throw new ConflictError("Worker does not own the task lease", { taskId: task.id, workerId });
  }

  if (Date.parse(task.leaseExpiresAt) <= Date.parse(now)) {
    throw new ConflictError("Task lease has expired", { taskId: task.id, workerId });
  }
}

function assertFutureLease(leaseExpiresAt: UtcIsoString, now: UtcIsoString): void {
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new ValidationError("Task lease expiry must be in the future", {
      leaseExpiresAt,
      now
    });
  }
}

function clearsLease(status: TaskStatus): boolean {
  return (
    status === "READY" ||
    status === "NEEDS_RECONCILIATION" ||
    status === "RESULT_PUBLISHING" ||
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED"
  );
}

function mapTaskRow(row: TaskRow): TaskRecord {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version)) {
    throw new InvariantViolationError("Task version exceeds JavaScript safe integer", {
      taskId: row.id,
      version: row.version
    });
  }

  return {
    id: assertEntityId(row.id, "task"),
    inboxMessageId: row.inbox_message_id,
    correlationId: row.correlation_id,
    riskUnitId: row.risk_unit_id,
    commandType: row.command_type as LiquidationCommandType,
    status: row.status as TaskStatus,
    ...(row.status_reason === null ? {} : { statusReason: row.status_reason }),
    priority: row.priority,
    decisionSequence: BigInt(row.decision_sequence),
    fencingToken: row.fencing_token === null ? undefined : BigInt(row.fencing_token),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt:
      row.lease_expires_at === null ? undefined : fromMysqlDateTime(row.lease_expires_at),
    version,
    commandPayload: parseMysqlJsonObject(row.command_payload),
    createdAt: fromMysqlDateTime(row.created_at),
    updatedAt: fromMysqlDateTime(row.updated_at)
  };
}

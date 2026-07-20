import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type {
  ExecutionStrategy,
  QuantityMode
} from "../../domain/commands/liquidation-command.js";
import { assertDecimalString } from "../../domain/shared/decimal.js";
import { ConflictError, InvariantViolationError } from "../../domain/shared/errors.js";
import { assertEntityId } from "../../domain/shared/id.js";
import { stringifyJson } from "../../domain/shared/serialization.js";
import type {
  CreateExecutionStepInput,
  ExecutionStepRecord,
  ExecutionStepRepository,
  ExecutionStepStatus,
  MarkExecutionStepPlannedInput
} from "../../repositories/execution-step-repository.js";
import { fromMysqlDateTime, parseMysqlJsonObject, toMysqlDateTime } from "./mapping.js";

type ExecutionStepRow = RowDataPacket & {
  readonly id: string;
  readonly task_id: string;
  readonly step_sequence: number;
  readonly strategy: string;
  readonly quantity_mode: string;
  readonly requested_quantity: string;
  readonly remaining_quantity: string;
  readonly status: string;
  readonly plan_payload: unknown;
  readonly created_at: string;
};

export class MysqlExecutionStepRepository implements ExecutionStepRepository {
  constructor(private readonly connection: PoolConnection) {}

  async create(input: CreateExecutionStepInput): Promise<ExecutionStepRecord> {
    await this.connection.execute(
      `INSERT INTO execution_steps (
        task_id, step_sequence, strategy, quantity_mode, requested_quantity,
        remaining_quantity, status, plan_payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.stepSequence,
        input.strategy,
        input.quantityMode,
        input.requestedQuantity,
        input.remainingQuantity,
        input.status,
        stringifyJson(input.planPayload),
        toMysqlDateTime(input.createdAt),
        toMysqlDateTime(input.createdAt)
      ]
    );

    const [rows] = await this.connection.execute<ExecutionStepRow[]>(
      `SELECT id, task_id, step_sequence, strategy, quantity_mode,
              requested_quantity, remaining_quantity, status, plan_payload, created_at
       FROM execution_steps
       WHERE task_id = ? AND step_sequence = ?
       FOR UPDATE`,
      [input.taskId, input.stepSequence]
    );
    const row = rows[0];

    if (row === undefined) {
      throw new InvariantViolationError("Execution step was not readable after insert", {
        taskId: input.taskId,
        stepSequence: input.stepSequence
      });
    }

    return mapExecutionStepRow(row);
  }

  async findFirstPending(taskId: import("../../domain/shared/id.js").TaskId): Promise<ExecutionStepRecord | undefined> {
    const [rows] = await this.connection.execute<ExecutionStepRow[]>(
      `SELECT id, task_id, step_sequence, strategy, quantity_mode,
              requested_quantity, remaining_quantity, status, plan_payload, created_at
       FROM execution_steps
       WHERE task_id = ? AND status = 'PENDING'
       ORDER BY step_sequence ASC
       LIMIT 1
       FOR UPDATE`,
      [taskId]
    );
    return rows[0] === undefined ? undefined : mapExecutionStepRow(rows[0]);
  }

  async markPlanned(input: MarkExecutionStepPlannedInput): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE execution_steps
       SET requested_quantity = ?, remaining_quantity = ?, status = 'ACTIVE',
           plan_payload = ?, started_at = ?, updated_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      [
        input.requestedQuantity,
        input.requestedQuantity,
        stringifyJson(input.planPayload),
        toMysqlDateTime(input.updatedAt),
        toMysqlDateTime(input.updatedAt),
        input.id.toString()
      ]
    );
    assertUpdated(result, input.id, "plan");
  }

  async markWaitingOrder(
    id: bigint,
    updatedAt: import("../../domain/shared/time.js").UtcIsoString
  ): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE execution_steps
       SET status = 'WAITING_ORDER', updated_at = ?
       WHERE id = ? AND status = 'ACTIVE'`,
      [toMysqlDateTime(updatedAt), id.toString()]
    );
    assertUpdated(result, id, "waiting order");
  }

  async markFailed(
    id: bigint,
    reason: string,
    updatedAt: import("../../domain/shared/time.js").UtcIsoString
  ): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE execution_steps
       SET status = 'FAILED',
           plan_payload = JSON_SET(plan_payload, '$.failure_reason', ?),
           completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('PENDING', 'ACTIVE', 'WAITING_ORDER')`,
      [
        reason,
        toMysqlDateTime(updatedAt),
        toMysqlDateTime(updatedAt),
        id.toString()
      ]
    );
    assertUpdated(result, id, "failed");
  }

  async findById(id: bigint): Promise<ExecutionStepRecord | undefined> {
    const [rows] = await this.connection.execute<ExecutionStepRow[]>(
      `SELECT id, task_id, step_sequence, strategy, quantity_mode,
              requested_quantity, remaining_quantity, status, plan_payload, created_at
       FROM execution_steps
       WHERE id = ?
       FOR UPDATE`,
      [id.toString()]
    );
    return rows[0] === undefined ? undefined : mapExecutionStepRow(rows[0]);
  }

  async findNextPending(
    taskId: import("../../domain/shared/id.js").TaskId,
    afterStepSequence: number
  ): Promise<ExecutionStepRecord | undefined> {
    const [rows] = await this.connection.execute<ExecutionStepRow[]>(
      `SELECT id, task_id, step_sequence, strategy, quantity_mode,
              requested_quantity, remaining_quantity, status, plan_payload, created_at
       FROM execution_steps
       WHERE task_id = ? AND step_sequence > ? AND status = 'PENDING'
       ORDER BY step_sequence ASC
       LIMIT 1
       FOR UPDATE`,
      [taskId, afterStepSequence]
    );
    return rows[0] === undefined ? undefined : mapExecutionStepRow(rows[0]);
  }

  async markCompleted(id: bigint, completedAt: import("../../domain/shared/time.js").UtcIsoString): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE execution_steps
       SET status = 'COMPLETED', remaining_quantity = '0', completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'WAITING_ORDER'`,
      [toMysqlDateTime(completedAt), toMysqlDateTime(completedAt), id.toString()]
    );
    assertUpdated(result, id, "completed");
  }

  async requeueAfterPartialSettlement(
    input: Parameters<ExecutionStepRepository["requeueAfterPartialSettlement"]>[0]
  ): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE execution_steps
       SET requested_quantity = ?, remaining_quantity = ?, status = 'PENDING',
           plan_payload = JSON_SET(plan_payload, '$.expected_position_version', ?),
           completed_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'WAITING_ORDER'`,
      [
        input.remainingQuantity,
        input.remainingQuantity,
        input.positionVersion.toString(),
        toMysqlDateTime(input.updatedAt),
        input.id.toString()
      ]
    );
    assertUpdated(result, input.id, "requeued after partial settlement");
  }

  async setExpectedPositionVersion(
    id: bigint,
    positionVersion: bigint,
    updatedAt: import("../../domain/shared/time.js").UtcIsoString
  ): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE execution_steps
       SET plan_payload = JSON_SET(plan_payload, '$.expected_position_version', ?),
           updated_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      [positionVersion.toString(), toMysqlDateTime(updatedAt), id.toString()]
    );
    assertUpdated(result, id, "expected position version updated");
  }
}

function assertUpdated(result: ResultSetHeader, id: bigint, operation: string): void {
  if (result.affectedRows !== 1) {
    throw new ConflictError(`Execution step could not enter ${operation}`, {
      executionStepId: id.toString()
    });
  }
}

function mapExecutionStepRow(row: ExecutionStepRow): ExecutionStepRecord {
  return {
    id: BigInt(row.id),
    taskId: assertEntityId(row.task_id, "task"),
    stepSequence: row.step_sequence,
    strategy: row.strategy as ExecutionStrategy,
    quantityMode: row.quantity_mode as QuantityMode,
    requestedQuantity: assertDecimalString(row.requested_quantity),
    remainingQuantity: assertDecimalString(row.remaining_quantity),
    status: row.status as ExecutionStepStatus,
    planPayload: parseMysqlJsonObject(row.plan_payload),
    createdAt: fromMysqlDateTime(row.created_at)
  };
}

import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { ConflictError } from "../../domain/shared/errors.js";
import { assertEntityId } from "../../domain/shared/id.js";
import type {
  ApprovalActionType,
  ApprovalRecord,
  ApprovalRepository,
  ApprovalStatus,
  CreateApprovalInput
} from "../../repositories/approval-repository.js";
import { fromMysqlDateTime, toMysqlDateTime } from "./mapping.js";

type ApprovalRow = RowDataPacket & {
  readonly approval_id: string;
  readonly action_type: string;
  readonly target_id: string;
  readonly reason: string;
  readonly status: string;
  readonly requested_by: string;
  readonly decided_by: string | null;
  readonly decision_reason: string | null;
  readonly requested_at: string;
  readonly decided_at: string | null;
  readonly executed_at: string | null;
};

const APPROVAL_COLUMNS = `
  approval_id, action_type, target_id, reason, status, requested_by,
  decided_by, decision_reason, requested_at, decided_at, executed_at
`;

export class MysqlApprovalRepository implements ApprovalRepository {
  constructor(private readonly connection: PoolConnection) {}

  async create(input: CreateApprovalInput): ReturnType<ApprovalRepository["create"]> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO operation_approvals (
        approval_id, action_type, target_id, reason, status,
        requested_by, requested_at
      ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
      [
        input.id,
        input.actionType,
        input.targetId,
        input.reason,
        input.requestedBy,
        toMysqlDateTime(input.requestedAt)
      ]
    );
    const approval = await this.findByIdForUpdate(input.id);
    if (approval === undefined) {
      throw new ConflictError("Approval was not readable after creation", {
        approvalId: input.id
      });
    }
    return { created: result.affectedRows === 1, approval };
  }

  findById(id: Parameters<ApprovalRepository["findById"]>[0]): Promise<ApprovalRecord | undefined> {
    return this.find(id, false);
  }

  findByIdForUpdate(
    id: Parameters<ApprovalRepository["findByIdForUpdate"]>[0]
  ): Promise<ApprovalRecord | undefined> {
    return this.find(id, true);
  }

  async markExecuted(
    input: Parameters<ApprovalRepository["markExecuted"]>[0]
  ): Promise<void> {
    const at = toMysqlDateTime(input.decidedAt);
    await this.updateOne(
      `UPDATE operation_approvals
       SET status = 'EXECUTED', decided_by = ?, decided_at = ?, executed_at = ?
       WHERE approval_id = ? AND status = 'PENDING'`,
      [input.approvedBy, at, at, input.id],
      input.id
    );
  }

  async markRejected(
    input: Parameters<ApprovalRepository["markRejected"]>[0]
  ): Promise<void> {
    await this.updateOne(
      `UPDATE operation_approvals
       SET status = 'REJECTED', decided_by = ?, decision_reason = ?, decided_at = ?
       WHERE approval_id = ? AND status = 'PENDING'`,
      [input.rejectedBy, input.reason, toMysqlDateTime(input.decidedAt), input.id],
      input.id
    );
  }

  private async find(id: ApprovalRecord["id"], forUpdate: boolean): Promise<ApprovalRecord | undefined> {
    const [rows] = await this.connection.execute<ApprovalRow[]>(
      `SELECT ${APPROVAL_COLUMNS}
       FROM operation_approvals
       WHERE approval_id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [id]
    );
    return rows[0] === undefined ? undefined : mapApproval(rows[0]);
  }

  private async updateOne(
    sql: string,
    values: readonly string[],
    approvalId: ApprovalRecord["id"]
  ): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(sql, [...values]);
    if (result.affectedRows !== 1) {
      throw new ConflictError("Approval is not pending", { approvalId });
    }
  }
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: assertEntityId(row.approval_id, "approval"),
    actionType: row.action_type as ApprovalActionType,
    targetId: row.target_id,
    reason: row.reason,
    status: row.status as ApprovalStatus,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by ?? undefined,
    decisionReason: row.decision_reason ?? undefined,
    requestedAt: fromMysqlDateTime(row.requested_at),
    decidedAt: row.decided_at === null ? undefined : fromMysqlDateTime(row.decided_at),
    executedAt: row.executed_at === null ? undefined : fromMysqlDateTime(row.executed_at)
  };
}

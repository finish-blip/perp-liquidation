import { isFinalStatus } from "../domain/liquidation/task-state.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError
} from "../domain/shared/errors.js";
import { assertEntityId } from "../domain/shared/id.js";
import { nowUtcIso } from "../domain/shared/time.js";
import type {
  ApprovalActionType,
  ApprovalId,
  ApprovalRecord
} from "../repositories/approval-repository.js";
import type {
  ApprovalRepositories,
  ApprovalUnitOfWork
} from "../repositories/approval-unit-of-work.js";

export type RequestOperationApprovalInput = {
  readonly approvalId: string;
  readonly actionType: ApprovalActionType;
  readonly targetId: string;
  readonly reason: string;
  readonly requestedBy: string;
};

export type OperationApprovalOutcome = {
  readonly status: "CREATED" | "DUPLICATE" | "EXECUTED" | "REJECTED";
  readonly approval: ApprovalRecord;
};

export class OperationApprovals {
  private readonly clock: () => Date;

  constructor(
    private readonly unitOfWork: ApprovalUnitOfWork,
    clock: () => Date = () => new Date()
  ) {
    this.clock = clock;
  }

  async request(input: RequestOperationApprovalInput): Promise<OperationApprovalOutcome> {
    const approvalId = assertEntityId(input.approvalId, "approval");
    assertActionType(input.actionType);
    assertTarget(input.actionType, input.targetId);
    assertOperator(input.requestedBy, "requestedBy");
    assertReason(input.reason, "reason");
    const requestedAt = nowUtcIso(this.clock);

    return this.unitOfWork.execute(async (repositories) => {
      const result = await repositories.approvals.create({
        id: approvalId,
        actionType: input.actionType,
        targetId: input.targetId,
        reason: input.reason,
        requestedBy: input.requestedBy,
        requestedAt
      });
      if (!result.created) {
        assertSameRequest(result.approval, input);
      }
      return {
        status: result.created ? "CREATED" : "DUPLICATE",
        approval: result.approval
      };
    });
  }

  async get(approvalId: string): Promise<ApprovalRecord> {
    const id = assertEntityId(approvalId, "approval");
    return this.unitOfWork.execute(async (repositories) => {
      const approval = await repositories.approvals.findById(id);
      if (approval === undefined) {
        throw new NotFoundError("Approval does not exist", { approvalId: id });
      }
      return approval;
    });
  }

  async approve(approvalId: string, approvedBy: string): Promise<OperationApprovalOutcome> {
    const id = assertEntityId(approvalId, "approval");
    assertOperator(approvedBy, "approvedBy");
    const decidedAt = nowUtcIso(this.clock);

    return this.unitOfWork.execute(async (repositories) => {
      const approval = await requireApprovalForUpdate(repositories, id);
      assertDifferentOperator(approval, approvedBy);
      if (approval.status === "EXECUTED") {
        return { status: "DUPLICATE", approval };
      }
      if (approval.status !== "PENDING") {
        throw new ConflictError("Rejected approval cannot be executed", { approvalId: id });
      }

      await executeApprovedAction(repositories, approval, approvedBy, decidedAt);
      await repositories.approvals.markExecuted({ id, approvedBy, decidedAt });
      return {
        status: "EXECUTED",
        approval: {
          ...approval,
          status: "EXECUTED",
          decidedBy: approvedBy,
          decidedAt,
          executedAt: decidedAt
        }
      };
    });
  }

  async reject(
    approvalId: string,
    rejectedBy: string,
    reason: string
  ): Promise<OperationApprovalOutcome> {
    const id = assertEntityId(approvalId, "approval");
    assertOperator(rejectedBy, "rejectedBy");
    assertReason(reason, "decision reason");
    const decidedAt = nowUtcIso(this.clock);

    return this.unitOfWork.execute(async (repositories) => {
      const approval = await requireApprovalForUpdate(repositories, id);
      assertDifferentOperator(approval, rejectedBy);
      if (approval.status === "REJECTED") {
        return { status: "DUPLICATE", approval };
      }
      if (approval.status !== "PENDING") {
        throw new ConflictError("Executed approval cannot be rejected", { approvalId: id });
      }
      await repositories.approvals.markRejected({
        id,
        rejectedBy,
        reason,
        decidedAt
      });
      return {
        status: "REJECTED",
        approval: {
          ...approval,
          status: "REJECTED",
          decidedBy: rejectedBy,
          decisionReason: reason,
          decidedAt
        }
      };
    });
  }
}

async function executeApprovedAction(
  repositories: ApprovalRepositories,
  approval: ApprovalRecord,
  approvedBy: string,
  at: ReturnType<typeof nowUtcIso>
): Promise<void> {
  if (approval.actionType === "REPLAY_OUTBOX") {
    const outboxId = assertEntityId(approval.targetId, "outbox");
    const message = await repositories.outbox.findById(outboxId);
    if (message === undefined) {
      throw new NotFoundError("Outbox message does not exist", { outboxMessageId: outboxId });
    }
    if (message.status !== "DEAD") {
      throw new ConflictError("Only DEAD Outbox messages can be replayed", {
        outboxMessageId: outboxId,
        status: message.status
      });
    }
    await repositories.outbox.replayDead(outboxId, at);
    return;
  }

  const taskId = assertEntityId(approval.targetId, "task");
  const task = await repositories.tasks.findById(taskId);
  if (task === undefined) {
    throw new NotFoundError("Task does not exist", { taskId });
  }
  if (isFinalStatus(task.status)) {
    throw new ConflictError("Final task cannot be changed by an approval", {
      taskId,
      status: task.status
    });
  }

  if (approval.actionType === "CANCEL_TASK") {
    if (!["RECEIVED", "READY"].includes(task.status)) {
      throw new ConflictError("Task has progressed too far to cancel safely", {
        taskId,
        status: task.status
      });
    }
    await repositories.riskUnitFences.revoke(task.riskUnitId);
    const cancelled = await repositories.tasks.transition(task.id, "CANCELLED", {
      at,
      reason: `manual cancellation approved by ${approvedBy}`
    });
    await appendApprovalTaskEvent(
      repositories,
      cancelled,
      approval,
      approvedBy,
      at
    );
    return;
  }

  if (
    ![
      "RECEIVED",
      "READY",
      "CLAIMED",
      "VALIDATING",
      "PLANNING",
      "ORDER_SUBMITTING",
      "WAITING_ORDER_EVENT",
      "WAITING_SETTLEMENT",
      "NEEDS_RECONCILIATION"
    ].includes(task.status)
  ) {
    throw new ConflictError("Task has progressed beyond safe reconciliation", {
      taskId,
      status: task.status
    });
  }

  await repositories.riskUnitFences.revoke(task.riskUnitId);
  const reconciling = await repositories.tasks.transition(
    task.id,
    "NEEDS_RECONCILIATION",
    {
      at,
      reason: `manual reconciliation approved by ${approvedBy}`
    }
  );
  await appendApprovalTaskEvent(repositories, reconciling, approval, approvedBy, at);
}

async function appendApprovalTaskEvent(
  repositories: ApprovalRepositories,
  task: Awaited<ReturnType<ApprovalRepositories["tasks"]["transition"]>>,
  approval: ApprovalRecord,
  approvedBy: string,
  at: ReturnType<typeof nowUtcIso>
): Promise<void> {
  await repositories.taskEvents.append({
    taskId: task.id,
    eventType: `APPROVAL_${approval.actionType}`,
    eventSequence: BigInt(task.version + 1),
    payload: {
      status: task.status,
      approval_id: approval.id,
      requested_by: approval.requestedBy,
      approved_by: approvedBy
    },
    createdAt: at
  });
}

async function requireApprovalForUpdate(
  repositories: ApprovalRepositories,
  id: ApprovalId
): Promise<ApprovalRecord> {
  const approval = await repositories.approvals.findByIdForUpdate(id);
  if (approval === undefined) {
    throw new NotFoundError("Approval does not exist", { approvalId: id });
  }
  return approval;
}

function assertSameRequest(
  approval: ApprovalRecord,
  input: RequestOperationApprovalInput
): void {
  if (
    approval.actionType !== input.actionType ||
    approval.targetId !== input.targetId ||
    approval.reason !== input.reason ||
    approval.requestedBy !== input.requestedBy
  ) {
    throw new ConflictError("approval_id was already used for another request", {
      approvalId: approval.id
    });
  }
}

function assertDifferentOperator(approval: ApprovalRecord, operator: string): void {
  if (approval.requestedBy === operator) {
    throw new ValidationError("Requester and approver must be different operators");
  }
}

function assertActionType(value: string): asserts value is ApprovalActionType {
  if (!["CANCEL_TASK", "FORCE_RECONCILIATION", "REPLAY_OUTBOX"].includes(value)) {
    throw new ValidationError("Unsupported approval action_type", { value });
  }
}

function assertTarget(actionType: ApprovalActionType, targetId: string): void {
  assertEntityId(targetId, actionType === "REPLAY_OUTBOX" ? "outbox" : "task");
}

function assertOperator(value: string, field: string): void {
  if (value.length < 1 || value.length > 128 || value.trim() !== value) {
    throw new ValidationError(`${field} must be between 1 and 128 non-padded characters`);
  }
}

function assertReason(value: string, field: string): void {
  if (value.length < 1 || value.length > 512 || value.trim() !== value) {
    throw new ValidationError(`${field} must be between 1 and 512 non-padded characters`);
  }
}

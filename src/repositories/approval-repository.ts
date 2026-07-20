import type { EntityId } from "../domain/shared/id.js";
import type { UtcIsoString } from "../domain/shared/time.js";

export type ApprovalId = EntityId<"approval">;
export type ApprovalActionType =
  | "CANCEL_TASK"
  | "FORCE_RECONCILIATION"
  | "REPLAY_OUTBOX";
export type ApprovalStatus = "PENDING" | "EXECUTED" | "REJECTED";

export type ApprovalRecord = {
  readonly id: ApprovalId;
  readonly actionType: ApprovalActionType;
  readonly targetId: string;
  readonly reason: string;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly decidedBy: string | undefined;
  readonly decisionReason: string | undefined;
  readonly requestedAt: UtcIsoString;
  readonly decidedAt: UtcIsoString | undefined;
  readonly executedAt: UtcIsoString | undefined;
};

export type CreateApprovalInput = Pick<
  ApprovalRecord,
  "id" | "actionType" | "targetId" | "reason" | "requestedBy" | "requestedAt"
>;

export type ApprovalRepository = {
  create(input: CreateApprovalInput): Promise<{
    readonly created: boolean;
    readonly approval: ApprovalRecord;
  }>;
  findById(id: ApprovalId): Promise<ApprovalRecord | undefined>;
  findByIdForUpdate(id: ApprovalId): Promise<ApprovalRecord | undefined>;
  markExecuted(input: {
    readonly id: ApprovalId;
    readonly approvedBy: string;
    readonly decidedAt: UtcIsoString;
  }): Promise<void>;
  markRejected(input: {
    readonly id: ApprovalId;
    readonly rejectedBy: string;
    readonly reason: string;
    readonly decidedAt: UtcIsoString;
  }): Promise<void>;
};

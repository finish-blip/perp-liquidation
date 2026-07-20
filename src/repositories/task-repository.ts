import type { LiquidationCommandType } from "../domain/commands/liquidation-command.js";
import type {
  TaskState,
  TaskStatus,
  TransitionContext
} from "../domain/liquidation/task-state.js";
import type { TaskId } from "../domain/shared/id.js";
import type { UtcIsoString } from "../domain/shared/time.js";

export type TaskRecord = TaskState & {
  readonly inboxMessageId: string;
  readonly correlationId: string;
  readonly riskUnitId: string;
  readonly commandType: LiquidationCommandType;
  readonly priority: number;
  readonly decisionSequence: bigint;
  readonly fencingToken: bigint | undefined;
  readonly leaseOwner: string | undefined;
  readonly leaseExpiresAt: UtcIsoString | undefined;
  readonly commandPayload: Record<string, unknown>;
  readonly createdAt: UtcIsoString;
};

export type CreateTaskInput = {
  readonly id: TaskId;
  readonly inboxMessageId: string;
  readonly correlationId: string;
  readonly riskUnitId: string;
  readonly commandType: LiquidationCommandType;
  readonly priority: number;
  readonly decisionSequence: bigint;
  readonly commandPayload: Record<string, unknown>;
  readonly now: UtcIsoString;
};

export type ClaimTaskInput = {
  readonly workerId: string;
  readonly leaseExpiresAt: UtcIsoString;
  readonly statuses: readonly TaskStatus[];
  readonly now: UtcIsoString;
  readonly priorityAgingIntervalSeconds: number;
};

export type FindExpiredLeasedTasksInput = {
  readonly now: UtcIsoString;
  readonly limit: number;
};

export type AttachTaskFencingTokenInput = {
  readonly taskId: TaskId;
  readonly workerId: string;
  readonly fencingToken: bigint;
  readonly now: UtcIsoString;
};

export type RenewTaskLeaseInput = AttachTaskFencingTokenInput & {
  readonly leaseExpiresAt: UtcIsoString;
};

export type TaskRepository = {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  findById(id: TaskId): Promise<TaskRecord | undefined>;
  findSupersedable(riskUnitId: string, beforeSequence: bigint): Promise<TaskRecord[]>;
  findExpiredLeased(input: FindExpiredLeasedTasksInput): Promise<TaskRecord[]>;
  transition(id: TaskId, to: TaskStatus, context: TransitionContext): Promise<TaskRecord>;
  claimNext(input: ClaimTaskInput): Promise<TaskRecord | undefined>;
  attachFencingToken(input: AttachTaskFencingTokenInput): Promise<TaskRecord>;
  renewLease(input: RenewTaskLeaseInput): Promise<TaskRecord>;
};

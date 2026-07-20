import type {
  ExecutionStrategy,
  QuantityMode
} from "../domain/commands/liquidation-command.js";
import type { DecimalString } from "../domain/shared/decimal.js";
import type { TaskId } from "../domain/shared/id.js";
import type { UtcIsoString } from "../domain/shared/time.js";

export type ExecutionStepStatus =
  | "PENDING"
  | "ACTIVE"
  | "WAITING_ORDER"
  | "WAITING_SETTLEMENT"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type ExecutionStepRecord = {
  readonly id: bigint;
  readonly taskId: TaskId;
  readonly stepSequence: number;
  readonly strategy: ExecutionStrategy;
  readonly quantityMode: QuantityMode;
  readonly requestedQuantity: DecimalString;
  readonly remainingQuantity: DecimalString;
  readonly status: ExecutionStepStatus;
  readonly planPayload: Record<string, unknown>;
  readonly createdAt: UtcIsoString;
};

export type CreateExecutionStepInput = Omit<ExecutionStepRecord, "id" | "createdAt"> & {
  readonly createdAt: UtcIsoString;
};

export type MarkExecutionStepPlannedInput = {
  readonly id: bigint;
  readonly requestedQuantity: DecimalString;
  readonly planPayload: Record<string, unknown>;
  readonly updatedAt: UtcIsoString;
};

export type ExecutionStepRepository = {
  create(input: CreateExecutionStepInput): Promise<ExecutionStepRecord>;
  findFirstPending(taskId: TaskId): Promise<ExecutionStepRecord | undefined>;
  markPlanned(input: MarkExecutionStepPlannedInput): Promise<void>;
  markWaitingOrder(id: bigint, updatedAt: UtcIsoString): Promise<void>;
  markFailed(id: bigint, reason: string, updatedAt: UtcIsoString): Promise<void>;
  findById(id: bigint): Promise<ExecutionStepRecord | undefined>;
  findNextPending(
    taskId: TaskId,
    afterStepSequence: number
  ): Promise<ExecutionStepRecord | undefined>;
  markCompleted(id: bigint, completedAt: UtcIsoString): Promise<void>;
  requeueAfterPartialSettlement(input: {
    readonly id: bigint;
    readonly remainingQuantity: DecimalString;
    readonly positionVersion: bigint;
    readonly updatedAt: UtcIsoString;
  }): Promise<void>;
  setExpectedPositionVersion(
    id: bigint,
    positionVersion: bigint,
    updatedAt: UtcIsoString
  ): Promise<void>;
};

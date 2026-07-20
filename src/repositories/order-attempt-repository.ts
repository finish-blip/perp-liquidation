import type { DecimalString } from "../domain/shared/decimal.js";
import type { ClientOrderId, TaskId } from "../domain/shared/id.js";
import type { UtcIsoString } from "../domain/shared/time.js";

export type OrderAttemptStatus =
  | "CREATED"
  | "ACCEPTED"
  | "UNKNOWN"
  | "REJECTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED";

export type OrderAttemptRecord = {
  readonly id: bigint;
  readonly taskId: TaskId;
  readonly executionStepId: bigint;
  readonly attemptSequence: number;
  readonly clientOrderId: ClientOrderId;
  readonly exchangeOrderId: string | undefined;
  readonly status: OrderAttemptStatus;
  readonly requestedQuantity: DecimalString;
  readonly requestedPrice: DecimalString;
  readonly filledQuantity: DecimalString;
  readonly lastEventSequence: bigint | undefined;
  readonly requestPayload: Record<string, unknown>;
};

export type CreateOrderAttemptInput = Omit<
  OrderAttemptRecord,
  "id" | "exchangeOrderId" | "status" | "filledQuantity" | "lastEventSequence"
> & {
  readonly createdAt: UtcIsoString;
};

export type OrderAttemptRepository = {
  create(input: CreateOrderAttemptInput): Promise<OrderAttemptRecord>;
  markAccepted(
    id: bigint,
    exchangeOrderId: string,
    responsePayload: Record<string, unknown>,
    submittedAt: UtcIsoString
  ): Promise<void>;
  markUnknown(id: bigint, lastError: string, submittedAt: UtcIsoString): Promise<void>;
  markRejected(
    id: bigint,
    reason: string,
    responsePayload: Record<string, unknown>,
    terminalAt: UtcIsoString
  ): Promise<void>;
  findByClientOrderId(clientOrderId: ClientOrderId): Promise<OrderAttemptRecord | undefined>;
  findLatestForTask(taskId: TaskId): Promise<OrderAttemptRecord | undefined>;
  findLatestForStep(executionStepId: bigint): Promise<OrderAttemptRecord | undefined>;
  applyEvent(input: {
    readonly id: bigint;
    readonly status: OrderAttemptStatus;
    readonly exchangeOrderId: string;
    readonly filledQuantity: DecimalString;
    readonly eventSequence: bigint;
    readonly terminalAt: UtcIsoString | undefined;
  }): Promise<OrderAttemptRecord>;
};

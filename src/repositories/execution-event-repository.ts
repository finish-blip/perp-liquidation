import type { OrderEvent } from "../domain/execution/order-event.js";
import type { SettlementEvent } from "../domain/execution/settlement-event.js";
import type { UtcIsoString } from "../domain/shared/time.js";
import type { TaskId } from "../domain/shared/id.js";

export type ExecutionEventReceipt = {
  readonly status: "RECORDED" | "DUPLICATE";
  readonly eventId: string;
};

export type ExecutionEventDisposition =
  | "PROCESSED"
  | "OUT_OF_ORDER"
  | "IGNORED";

export type OrderEventRepository = {
  record(event: OrderEvent, receivedAt: UtcIsoString): Promise<ExecutionEventReceipt>;
  markDisposition(
    eventId: string,
    disposition: ExecutionEventDisposition,
    processedAt: UtcIsoString
  ): Promise<void>;
};

export type SettlementEventRepository = {
  record(event: SettlementEvent, receivedAt: UtcIsoString): Promise<ExecutionEventReceipt>;
  listForTask(taskId: TaskId): Promise<readonly SettlementEvent[]>;
  markDisposition(
    eventId: string,
    disposition: ExecutionEventDisposition,
    processedAt: UtcIsoString
  ): Promise<void>;
};

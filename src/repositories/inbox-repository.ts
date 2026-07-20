import type { LiquidationCommand } from "../domain/commands/liquidation-command.js";
import type { TaskId } from "../domain/shared/id.js";
import type { UtcIsoString } from "../domain/shared/time.js";

export type InboxReceiptStatus = "RECORDED" | "DUPLICATE" | "STALE_SEQUENCE";

export type InboxReceipt = {
  readonly status: InboxReceiptStatus;
  readonly messageId: string;
  readonly existingTaskId?: TaskId;
};

export type RecordInboxMessageInput = {
  readonly source: string;
  readonly command: LiquidationCommand;
  readonly receivedAt: UtcIsoString;
};

export type MarkInboxProcessedInput = {
  readonly messageId: string;
  readonly taskId: TaskId;
  readonly processedAt: UtcIsoString;
};

export type MarkInboxStaleInput = {
  readonly messageId: string;
  readonly existingTaskId: TaskId;
  readonly processedAt: UtcIsoString;
};

export type InboxRepository = {
  record(input: RecordInboxMessageInput): Promise<InboxReceipt>;
  markProcessed(input: MarkInboxProcessedInput): Promise<void>;
  markStale(input: MarkInboxStaleInput): Promise<void>;
};

import type { TaskId } from "../domain/shared/id.js";
import type { UtcIsoString } from "../domain/shared/time.js";

export type AppendTaskEventInput = {
  readonly taskId: TaskId;
  readonly eventType: string;
  readonly eventSequence: bigint;
  readonly payload: Record<string, unknown>;
  readonly createdAt: UtcIsoString;
};

export type TaskEventRepository = {
  append(input: AppendTaskEventInput): Promise<void>;
};

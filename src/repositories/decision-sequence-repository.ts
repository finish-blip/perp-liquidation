import type { TaskId } from "../domain/shared/id.js";
import type { UtcIsoString } from "../domain/shared/time.js";

export type ClaimDecisionSequenceInput = {
  readonly riskUnitId: string;
  readonly decisionSequence: bigint;
  readonly messageId: string;
  readonly taskId: TaskId;
  readonly claimedAt: UtcIsoString;
};

export type DecisionSequenceClaim =
  | {
      readonly status: "ACCEPTED";
      readonly supersededTaskId: TaskId | undefined;
    }
  | {
      readonly status: "STALE_SEQUENCE";
      readonly latestDecisionSequence: bigint;
      readonly existingTaskId: TaskId;
    };

export type DecisionSequenceRepository = {
  claim(input: ClaimDecisionSequenceInput): Promise<DecisionSequenceClaim>;
};

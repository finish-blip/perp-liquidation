import { AppError } from "../shared/errors.js";
import type { TaskId } from "../shared/id.js";
import type { UtcIsoString } from "../shared/time.js";

export type TaskStatus =
  | "RECEIVED"
  | "READY"
  | "CLAIMED"
  | "VALIDATING"
  | "PLANNING"
  | "ORDER_SUBMITTING"
  | "WAITING_ORDER_EVENT"
  | "WAITING_SETTLEMENT"
  | "STEP_COMPLETED"
  | "LOSS_MITIGATION"
  | "RESULT_PUBLISHING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "NEEDS_RECONCILIATION";

export type TaskState = {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly version: number;
  readonly updatedAt: UtcIsoString;
  readonly statusReason?: string;
};

export type TransitionContext = {
  readonly at: UtcIsoString;
  readonly reason?: string;
};

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  RECEIVED: ["READY", "FAILED", "CANCELLED", "NEEDS_RECONCILIATION"],
  READY: ["CLAIMED", "CANCELLED", "NEEDS_RECONCILIATION"],
  CLAIMED: [
    "VALIDATING",
    "READY",
    "WAITING_ORDER_EVENT",
    "WAITING_SETTLEMENT",
    "NEEDS_RECONCILIATION",
    "FAILED"
  ],
  VALIDATING: ["PLANNING", "FAILED", "NEEDS_RECONCILIATION"],
  PLANNING: ["ORDER_SUBMITTING", "FAILED", "NEEDS_RECONCILIATION"],
  ORDER_SUBMITTING: [
    "WAITING_ORDER_EVENT",
    "WAITING_SETTLEMENT",
    "NEEDS_RECONCILIATION",
    "FAILED"
  ],
  WAITING_ORDER_EVENT: [
    "WAITING_ORDER_EVENT",
    "WAITING_SETTLEMENT",
    "ORDER_SUBMITTING",
    "NEEDS_RECONCILIATION",
    "FAILED"
  ],
  WAITING_SETTLEMENT: [
    "STEP_COMPLETED",
    "LOSS_MITIGATION",
    "RESULT_PUBLISHING",
    "NEEDS_RECONCILIATION",
    "FAILED"
  ],
  STEP_COMPLETED: [
    "ORDER_SUBMITTING",
    "RESULT_PUBLISHING",
    "LOSS_MITIGATION",
    "NEEDS_RECONCILIATION",
    "READY"
  ],
  LOSS_MITIGATION: ["RESULT_PUBLISHING", "NEEDS_RECONCILIATION", "FAILED"],
  RESULT_PUBLISHING: ["COMPLETED", "NEEDS_RECONCILIATION", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  NEEDS_RECONCILIATION: [
    "NEEDS_RECONCILIATION",
    "CLAIMED",
    "WAITING_ORDER_EVENT",
    "WAITING_SETTLEMENT",
    "FAILED",
    "CANCELLED"
  ]
};

export class InvalidStateTransitionError extends AppError {
  constructor(from: TaskStatus, to: TaskStatus) {
    super({
      code: "STATE_TRANSITION_INVALID",
      message: `Cannot transition task from ${from} to ${to}`,
      details: { from, to }
    });
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transition(
  state: TaskState,
  to: TaskStatus,
  context: TransitionContext
): TaskState {
  if (!canTransition(state.status, to)) {
    throw new InvalidStateTransitionError(state.status, to);
  }

  return {
    ...state,
    status: to,
    version: state.version + 1,
    updatedAt: context.at,
    ...(context.reason === undefined ? {} : { statusReason: context.reason })
  };
}

export function isFinalStatus(status: TaskStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

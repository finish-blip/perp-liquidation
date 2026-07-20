import type { OutboxMessage } from "../../repositories/outbox-repository.js";
import { InvariantViolationError } from "../shared/errors.js";

export type LiquidationExecutionResultV1 = {
  readonly eventId: string;
  readonly eventType: "liquidation.execution.result.v1";
  readonly eventVersion: 1;
  readonly occurredAt: string;
  readonly producer: "liquidation-service";
  readonly data: {
    readonly riskDecisionId: string;
    readonly requestEventId: string;
    readonly taskId: string | null;
    readonly positionId: string;
    readonly positionVersion: string;
    readonly status: string;
    readonly requestedSize: string;
    readonly executedSize: string;
    readonly averagePrice: string | null;
    readonly remainingSize: string;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  };
};

export function isLiquidationResultMessage(message: OutboxMessage): boolean {
  return (
    message.eventType === "LIQUIDATION_EXECUTION_SETTLED" ||
    message.eventType === "LIQUIDATION_TASK_FAILED"
  );
}

export function liquidationResultEventFromOutbox(
  message: OutboxMessage
): LiquidationExecutionResultV1 {
  if (!isLiquidationResultMessage(message)) {
    throw new InvariantViolationError("Outbox message is not a liquidation result", {
      eventType: message.eventType
    });
  }
  const payload = message.payload;
  return {
    eventId: message.id,
    eventType: "liquidation.execution.result.v1",
    eventVersion: 1,
    occurredAt: message.nextAttemptAt,
    producer: "liquidation-service",
    data: {
      riskDecisionId: stringField(payload, "risk_decision_id"),
      requestEventId: stringField(payload, "request_event_id"),
      taskId: stringField(payload, "task_id"),
      positionId: stringField(payload, "position_id"),
      positionVersion: stringField(payload, "position_version"),
      status: stringField(payload, "status"),
      requestedSize: stringField(payload, "requested_size"),
      executedSize: stringField(payload, "executed_size"),
      averagePrice: nullableStringField(payload, "average_price"),
      remainingSize: stringField(payload, "remaining_size"),
      errorCode: nullableStringField(payload, "error_code"),
      errorMessage: nullableStringField(payload, "error_message")
    }
  };
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") {
    throw new InvariantViolationError(`Liquidation result payload is missing ${field}`);
  }
  return value;
}

function nullableStringField(
  payload: Record<string, unknown>,
  field: string
): string | null {
  const value = payload[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new InvariantViolationError(`Liquidation result payload has invalid ${field}`);
  }
  return value;
}

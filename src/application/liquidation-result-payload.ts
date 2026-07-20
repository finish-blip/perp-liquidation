import { parseLiquidationCommand } from "../domain/commands/liquidation-command-parser.js";
import {
  assertNonNegativeDecimal,
  maxDecimal,
  subtractDecimal,
  type DecimalString
} from "../domain/shared/decimal.js";
import type { TaskRecord } from "../repositories/task-repository.js";

export type LiquidationResultStatus =
  | "COMPLETED"
  | "PARTIALLY_COMPLETED"
  | "EXPIRED"
  | "SUPERSEDED"
  | "REJECTED"
  | "FAILED";

export function buildLiquidationResultOutboxPayload(input: {
  readonly task: TaskRecord;
  readonly status: LiquidationResultStatus;
  readonly executedSize: string;
  readonly finalPositionVersion?: bigint;
  readonly averagePrice?: DecimalString;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const command = parseLiquidationCommand(input.task.commandPayload);
  const executedSize = assertNonNegativeDecimal(input.executedSize, "executedSize");
  const remainingSize = maxDecimal(
    subtractDecimal(command.quantity, executedSize),
    "0"
  );

  return {
    risk_decision_id: command.correlationId,
    request_event_id: command.messageId,
    task_id: input.task.id,
    position_id: command.positionId,
    position_version: (input.finalPositionVersion ?? command.positionVersion).toString(),
    status: input.status,
    requested_size: command.quantity,
    executed_size: executedSize,
    average_price: input.averagePrice ?? null,
    remaining_size: remainingSize,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    ...(input.details === undefined ? {} : { details: input.details })
  };
}

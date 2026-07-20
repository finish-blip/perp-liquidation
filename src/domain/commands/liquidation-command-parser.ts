import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import liquidationCommandSchema from "../../../contracts/json-schema/liquidation-command.schema.json" with {
  type: "json"
};
import { assertPositiveDecimal } from "../shared/decimal.js";
import { ValidationError } from "../shared/errors.js";
import { assertUtcIsoString } from "../shared/time.js";
import type {
  ExecutionStrategy,
  LiquidationCommand,
  LiquidationCommandType,
  OrderSide,
  QuantityMode
} from "./liquidation-command.js";

export type LiquidationCommandPayload = {
  readonly message_id: string;
  readonly correlation_id: string;
  readonly command_type: LiquidationCommandType;
  readonly decision_sequence: string;
  readonly risk_unit_id: string;
  readonly account_id: string;
  readonly position_id: string;
  readonly position_version: string;
  readonly market: string;
  readonly side: OrderSide;
  readonly quantity: string;
  readonly quantity_mode: QuantityMode;
  readonly strategy: ExecutionStrategy;
  readonly max_slippage_bps?: number;
  readonly expires_at: string;
};

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: isUtcIsoString
});

const validatePayload = ajv.compile<LiquidationCommandPayload>(liquidationCommandSchema);

export function parseLiquidationCommand(input: unknown): LiquidationCommand {
  if (!validatePayload(input)) {
    throw new ValidationError("Liquidation command does not match its contract", {
      errors: formatValidationErrors(validatePayload.errors ?? [])
    });
  }

  const decisionSequence = parseUnsignedBigInt(input.decision_sequence, "decision_sequence");
  const positionVersion = parseUnsignedBigInt(input.position_version, "position_version");

  return {
    messageId: input.message_id,
    correlationId: input.correlation_id,
    commandType: input.command_type,
    decisionSequence,
    riskUnitId: input.risk_unit_id,
    accountId: input.account_id,
    positionId: input.position_id,
    positionVersion,
    market: input.market,
    side: input.side,
    quantity: assertPositiveDecimal(input.quantity, "quantity"),
    quantityMode: input.quantity_mode,
    strategy: input.strategy,
    ...(input.max_slippage_bps === undefined
      ? {}
      : { maxSlippageBps: input.max_slippage_bps }),
    expiresAt: assertUtcIsoString(input.expires_at, "expires_at")
  };
}

export function liquidationCommandToPayload(
  command: LiquidationCommand
): LiquidationCommandPayload {
  return {
    message_id: command.messageId,
    correlation_id: command.correlationId,
    command_type: command.commandType,
    decision_sequence: command.decisionSequence.toString(),
    risk_unit_id: command.riskUnitId,
    account_id: command.accountId,
    position_id: command.positionId,
    position_version: command.positionVersion.toString(),
    market: command.market,
    side: command.side,
    quantity: command.quantity,
    quantity_mode: command.quantityMode,
    strategy: command.strategy,
    ...(command.maxSlippageBps === undefined
      ? {}
      : { max_slippage_bps: command.maxSlippageBps }),
    expires_at: command.expiresAt
  };
}

function parseUnsignedBigInt(value: string, field: string): bigint {
  const parsed = BigInt(value);
  if (parsed > MAX_UNSIGNED_BIGINT) {
    throw new ValidationError(`${field} exceeds MySQL UNSIGNED BIGINT`, {
      [field]: value
    });
  }
  return parsed;
}

function isUtcIsoString(value: string): boolean {
  try {
    assertUtcIsoString(value);
    return true;
  } catch {
    return false;
  }
}

function formatValidationErrors(errors: readonly ErrorObject[]): Record<string, unknown>[] {
  return errors.map((error) => ({
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "validation failed",
    params: error.params
  }));
}

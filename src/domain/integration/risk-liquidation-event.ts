import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import riskLiquidationSchema from "../../../contracts/json-schema/risk-liquidation-requested-v1.schema.json" with {
  type: "json"
};
import type { LiquidationCommandPayload } from "../commands/liquidation-command-parser.js";
import {
  assertPositiveDecimal,
  compareDecimal,
  toDecimal
} from "../shared/decimal.js";
import { ValidationError } from "../shared/errors.js";
import { assertUtcIsoString, type UtcIsoString } from "../shared/time.js";

export type RiskPositionSide = "LONG" | "SHORT";
export type RiskLiquidationMode = "PARTIAL_LIQUIDATION" | "FULL_LIQUIDATION";

export type RiskLiquidationRequestedV1Payload = {
  readonly eventId: string;
  readonly eventType: "risk.liquidation.requested.v1";
  readonly eventVersion: 1;
  readonly occurredAt: string;
  readonly producer: "risk-control-service";
  readonly data: {
    readonly riskDecisionId: string;
    readonly decisionSequence?: string;
    readonly riskUnitId?: string;
    readonly source?: string;
    readonly userId: string;
    readonly accountId: string;
    readonly positionId: string;
    readonly symbol: string;
    readonly positionSide: RiskPositionSide;
    readonly positionVersion: string | number;
    readonly riskLevel: "LIQUIDATION_REQUIRED";
    readonly triggerReason: string;
    readonly riskSnapshot: Readonly<Record<string, unknown>>;
    readonly executionInstruction: {
      readonly action: "LIQUIDATE_POSITION";
      readonly mode: RiskLiquidationMode;
      readonly targetReduceSize: string;
      readonly maxReduceSize?: string;
      readonly orderType: "MARKET" | "LIMIT";
      readonly reduceOnly: true;
      readonly maxSlippage?: string;
      readonly maxSlippageBps?: number;
      readonly timeInForce?: string;
    };
    readonly expireAt: string;
  };
};

export type ParsedRiskLiquidationEvent = Omit<
  RiskLiquidationRequestedV1Payload,
  "occurredAt" | "data"
> & {
  readonly occurredAt: UtcIsoString;
  readonly data: Omit<RiskLiquidationRequestedV1Payload["data"], "expireAt"> & {
    readonly expireAt: UtcIsoString;
  };
};

export type MappedRiskLiquidationCommand = {
  readonly source: string;
  readonly payload: LiquidationCommandPayload;
  readonly usedDerivedDecisionSequence: boolean;
  readonly usedDerivedRiskUnitId: boolean;
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: isUtcIsoString
});
const validate = ajv.compile<RiskLiquidationRequestedV1Payload>(riskLiquidationSchema);

export function parseRiskLiquidationRequestedV1(
  input: unknown
): ParsedRiskLiquidationEvent {
  if (!validate(input)) {
    throw new ValidationError("Risk liquidation event does not match its contract", {
      errors: formatValidationErrors(validate.errors ?? [])
    });
  }

  return {
    ...input,
    occurredAt: assertUtcIsoString(input.occurredAt, "occurredAt"),
    data: {
      ...input.data,
      expireAt: assertUtcIsoString(input.data.expireAt, "data.expireAt")
    }
  };
}

export function mapRiskLiquidationEventToCommand(
  event: ParsedRiskLiquidationEvent
): MappedRiskLiquidationCommand {
  const positionVersion = normalizeUnsignedInteger(
    event.data.positionVersion,
    "data.positionVersion"
  );
  const decisionSequence = event.data.decisionSequence ?? positionVersion;
  if (!/^[1-9][0-9]{0,19}$/.test(decisionSequence)) {
    throw new ValidationError(
      "data.decisionSequence is required when positionVersion cannot be used as a positive sequence",
      { decisionSequence, positionVersion }
    );
  }

  const riskUnitId = event.data.riskUnitId ?? `${event.data.accountId}:${event.data.symbol}`;
  if (riskUnitId.length > 128) {
    throw new ValidationError("Derived riskUnitId exceeds 128 characters", { riskUnitId });
  }

  const instruction = event.data.executionInstruction;
  const targetReduceSize = assertPositiveDecimal(
    instruction.targetReduceSize,
    "data.executionInstruction.targetReduceSize"
  );
  if (
    instruction.maxReduceSize !== undefined &&
    compareDecimal(targetReduceSize, instruction.maxReduceSize) > 0
  ) {
    throw new ValidationError("targetReduceSize exceeds maxReduceSize");
  }
  const maxSlippageBps = resolveMaxSlippageBps(instruction);

  return {
    source: event.data.source ?? event.producer,
    payload: {
      message_id: event.eventId,
      correlation_id: event.data.riskDecisionId,
      command_type: instruction.action,
      decision_sequence: decisionSequence,
      risk_unit_id: riskUnitId,
      account_id: event.data.accountId,
      position_id: event.data.positionId,
      position_version: positionVersion,
      market: event.data.symbol,
      side: event.data.positionSide === "LONG" ? "SELL" : "BUY",
      quantity: targetReduceSize,
      quantity_mode: "UP_TO",
      strategy: "STATIC",
      expires_at: event.data.expireAt,
      ...(maxSlippageBps === undefined ? {} : { max_slippage_bps: maxSlippageBps })
    },
    usedDerivedDecisionSequence: event.data.decisionSequence === undefined,
    usedDerivedRiskUnitId: event.data.riskUnitId === undefined
  };
}

function resolveMaxSlippageBps(
  instruction: RiskLiquidationRequestedV1Payload["data"]["executionInstruction"]
): number | undefined {
  if (instruction.maxSlippageBps !== undefined) {
    return instruction.maxSlippageBps;
  }
  if (instruction.maxSlippage === undefined) {
    return undefined;
  }

  const bps = toDecimal(instruction.maxSlippage, "maxSlippage").mul(10_000);
  if (!bps.isInteger() || bps.lt(0) || bps.gt(5000)) {
    throw new ValidationError("maxSlippage must represent an integer number of basis points", {
      maxSlippage: instruction.maxSlippage,
      maxSlippageBps: bps.toFixed()
    });
  }
  return bps.toNumber();
}

function normalizeUnsignedInteger(value: string | number, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${field} must be a safe unsigned integer`, { value });
    }
    return value.toString();
  }
  return value;
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

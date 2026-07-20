import type { LiquidationCommand, OrderSide } from "../commands/liquidation-command.js";
import type { PositionSnapshot } from "../portfolio/position-snapshot.js";
import {
  compareDecimal,
  maxDecimal,
  minDecimal,
  quantizeDownToStep,
  quantizeUpToStep,
  toDecimal,
  type DecimalString
} from "../shared/decimal.js";
import { ValidationError } from "../shared/errors.js";
import { toEpochMillis, type UtcIsoString } from "../shared/time.js";
import type { MarketSnapshot } from "./market-snapshot.js";

export type StaticPlanOptions = {
  readonly maxMarketAgeMs: number;
  readonly maxFutureSkewMs: number;
  readonly maxPriceDeviationBps: number;
  readonly maxSlippageBps: number;
  readonly maxOrderQuantity: string;
  readonly maxSteps: number;
};

export type StaticExecutionPlan = {
  readonly side: OrderSide;
  readonly quantity: DecimalString;
  readonly stepQuantities: readonly DecimalString[];
  readonly limitPrice: DecimalString;
  readonly reduceOnly: true;
  readonly positionVersion: bigint;
  readonly marketObservedAt: UtcIsoString;
};

export function buildStaticExecutionPlan(input: {
  readonly command: LiquidationCommand;
  readonly position: PositionSnapshot;
  readonly market: MarketSnapshot;
  readonly now: UtcIsoString;
  readonly options: StaticPlanOptions;
}): StaticExecutionPlan {
  validateOptions(input.options);
  validateInstruction(input.command, input.position, input.market, input.now);
  validateMarket(input.market, input.now, input.options);

  const quantity = planQuantity(input.command, input.position, input.market.stepSize);
  const stepQuantities = splitQuantity(
    quantity,
    input.options.maxOrderQuantity,
    input.market.stepSize,
    input.options.maxSteps
  );
  const firstQuantity = stepQuantities[0];
  if (firstQuantity === undefined) {
    throw new ValidationError("STATIC plan produced no executable steps");
  }
  const limitPrice = planLimitPrice(
    input.command.side,
    input.position.bankruptcyPrice,
    input.market,
    Math.min(
      input.command.maxSlippageBps ?? input.options.maxSlippageBps,
      input.options.maxSlippageBps
    )
  );

  return {
    side: input.command.side,
    quantity: firstQuantity,
    stepQuantities,
    limitPrice,
    reduceOnly: true,
    positionVersion: input.position.version,
    marketObservedAt: input.market.observedAt
  };
}

function splitQuantity(
  totalQuantity: DecimalString,
  maxOrderQuantity: string,
  stepSize: DecimalString,
  maxSteps: number
): readonly DecimalString[] {
  const maximum = quantizeDownToStep(maxOrderQuantity, stepSize);
  if (compareDecimal(maximum, "0") <= 0) {
    throw new ValidationError("maxOrderQuantity is zero after step-size quantization");
  }

  const quantities: DecimalString[] = [];
  let remaining = totalQuantity;
  while (compareDecimal(remaining, "0") > 0) {
    if (quantities.length >= maxSteps) {
      throw new ValidationError("STATIC plan exceeds the configured maximum step count", {
        totalQuantity,
        maxOrderQuantity,
        maxSteps
      });
    }
    const quantity = minDecimal(remaining, maximum);
    quantities.push(quantity);
    remaining = toDecimal(remaining).minus(quantity).toFixed() as DecimalString;
  }
  return quantities;
}

function validateInstruction(
  command: LiquidationCommand,
  position: PositionSnapshot,
  market: MarketSnapshot,
  now: UtcIsoString
): void {
  if (command.strategy !== "STATIC") {
    throw new ValidationError("STATIC planner cannot execute an ADAPTIVE command");
  }
  if (command.commandType === "CANCEL_RISK_ORDERS") {
    throw new ValidationError("CANCEL_RISK_ORDERS does not create a reduce-only order");
  }
  if (toEpochMillis(command.expiresAt) <= toEpochMillis(now)) {
    throw new ValidationError("Liquidation command has expired");
  }
  if (
    position.positionId !== command.positionId ||
    position.accountId !== command.accountId ||
    position.riskUnitId !== command.riskUnitId ||
    position.market !== command.market ||
    market.market !== command.market
  ) {
    throw new ValidationError("Command ownership or market does not match current snapshots");
  }
  if (position.version !== command.positionVersion) {
    throw new ValidationError("Position version changed after the liquidation decision", {
      expected: command.positionVersion.toString(),
      actual: position.version.toString()
    });
  }

  const expectedSide: OrderSide = position.side === "LONG" ? "SELL" : "BUY";
  if (command.side !== expectedSide) {
    throw new ValidationError("Command side would increase rather than reduce the position", {
      positionSide: position.side,
      commandSide: command.side
    });
  }
}

function validateMarket(
  market: MarketSnapshot,
  now: UtcIsoString,
  options: StaticPlanOptions
): void {
  const ageMs = toEpochMillis(now) - toEpochMillis(market.observedAt);
  if (ageMs > options.maxMarketAgeMs || ageMs < -options.maxFutureSkewMs) {
    throw new ValidationError("Market snapshot is outside the allowed freshness window", {
      ageMs
    });
  }
  if (compareDecimal(market.bestBid, market.bestAsk) > 0) {
    throw new ValidationError("Market best bid exceeds best ask");
  }

  for (const [field, price] of [
    ["bestBid", market.bestBid],
    ["bestAsk", market.bestAsk]
  ] as const) {
    const deviationBps = toDecimal(price)
      .minus(toDecimal(market.markPrice))
      .abs()
      .div(market.markPrice)
      .mul(10_000);
    if (deviationBps.gt(options.maxPriceDeviationBps)) {
      throw new ValidationError(`${field} exceeds maximum mark-price deviation`, {
        deviationBps: deviationBps.toFixed()
      });
    }
  }
}

function planQuantity(
  command: LiquidationCommand,
  position: PositionSnapshot,
  stepSize: DecimalString
): DecimalString {
  if (
    command.quantityMode === "EXACT" &&
    compareDecimal(position.reducibleQuantity, command.quantity) < 0
  ) {
    throw new ValidationError("EXACT quantity exceeds currently reducible quantity");
  }

  const authorized =
    command.quantityMode === "EXACT"
      ? command.quantity
      : minDecimal(command.quantity, position.reducibleQuantity);
  const quantized = quantizeDownToStep(authorized, stepSize);

  if (compareDecimal(quantized, "0") <= 0) {
    throw new ValidationError("Executable quantity is zero after step-size quantization");
  }
  if (command.quantityMode === "EXACT" && compareDecimal(quantized, authorized) !== 0) {
    throw new ValidationError("EXACT quantity is not aligned to market stepSize", {
      quantity: authorized,
      stepSize
    });
  }
  return quantized;
}

function planLimitPrice(
  side: OrderSide,
  bankruptcyPrice: DecimalString,
  market: MarketSnapshot,
  maxSlippageBps: number
): DecimalString {
  const slippage = toDecimal(maxSlippageBps.toString()).div(10_000);

  if (side === "SELL") {
    const protectedPrice = toDecimal(market.bestBid).mul(toDecimal("1").minus(slippage));
    return quantizeUpToStep(
      maxDecimal(protectedPrice, bankruptcyPrice),
      market.tickSize
    );
  }

  const protectedPrice = toDecimal(market.bestAsk).mul(toDecimal("1").plus(slippage));
  return quantizeDownToStep(
    minDecimal(protectedPrice, bankruptcyPrice),
    market.tickSize
  );
}

function validateOptions(options: StaticPlanOptions): void {
  for (const [field, value, maximum] of [
    ["maxMarketAgeMs", options.maxMarketAgeMs, 60_000],
    ["maxFutureSkewMs", options.maxFutureSkewMs, 10_000],
    ["maxPriceDeviationBps", options.maxPriceDeviationBps, 10_000],
    ["maxSlippageBps", options.maxSlippageBps, 5000]
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      throw new ValidationError(`${field} must be an integer between 0 and ${maximum}`);
    }
  }
  if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 32) {
    throw new ValidationError("maxSteps must be between 1 and 32");
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(options.maxOrderQuantity)) {
    throw new ValidationError("maxOrderQuantity must be a non-negative decimal string");
  }
}

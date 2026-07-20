import type { DecimalString } from "../shared/decimal.js";
import type { UtcIsoString } from "../shared/time.js";

export type LiquidationCommandType =
  | "CANCEL_RISK_ORDERS"
  | "REDUCE_POSITION"
  | "LIQUIDATE_POSITION";

export type QuantityMode = "EXACT" | "UP_TO";
export type ExecutionStrategy = "STATIC" | "ADAPTIVE";
export type OrderSide = "BUY" | "SELL";

export type LiquidationCommand = {
  readonly messageId: string;
  readonly correlationId: string;
  readonly commandType: LiquidationCommandType;
  readonly decisionSequence: bigint;
  readonly riskUnitId: string;
  readonly accountId: string;
  readonly positionId: string;
  readonly positionVersion: bigint;
  readonly market: string;
  readonly side: OrderSide;
  readonly quantity: DecimalString;
  readonly quantityMode: QuantityMode;
  readonly strategy: ExecutionStrategy;
  readonly maxSlippageBps?: number;
  readonly expiresAt: UtcIsoString;
};

import type { UtcIsoString } from "../domain/shared/time.js";

export type RiskUnitFence = {
  readonly riskUnitId: string;
  readonly owner: string;
  readonly fencingToken: bigint;
  readonly expiresAt: UtcIsoString;
};

export type ActivateRiskUnitFenceInput = RiskUnitFence & {
  readonly now: UtcIsoString;
};

export type AssertRiskUnitFenceInput = {
  readonly riskUnitId: string;
  readonly owner: string;
  readonly fencingToken: bigint;
  readonly now: UtcIsoString;
};

export type RiskUnitFenceRepository = {
  activate(input: ActivateRiskUnitFenceInput): Promise<RiskUnitFence>;
  assertCurrent(input: AssertRiskUnitFenceInput): Promise<void>;
  revoke(riskUnitId: string): Promise<void>;
};

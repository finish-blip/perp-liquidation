export type RiskUnitLockLease = {
  readonly riskUnitId: string;
  readonly owner: string;
  readonly fencingToken: bigint;
};

export type AcquireRiskUnitLockInput = {
  readonly riskUnitId: string;
  readonly owner: string;
  readonly ttlMs: number;
};

export type RiskUnitLock = {
  acquire(input: AcquireRiskUnitLockInput): Promise<RiskUnitLockLease | undefined>;
  renew(lease: RiskUnitLockLease, ttlMs: number): Promise<boolean>;
  release(lease: RiskUnitLockLease): Promise<boolean>;
};

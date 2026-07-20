import { createHash } from "node:crypto";

import { InvariantViolationError, ValidationError } from "../../domain/shared/errors.js";
import type {
  AcquireRiskUnitLockInput,
  RiskUnitLock,
  RiskUnitLockLease
} from "../../repositories/risk-unit-lock.js";

const ACQUIRE_SCRIPT = `
local current_owner = redis.call('HGET', KEYS[1], 'owner')

if not current_owner then
  local token = redis.call('INCR', KEYS[2])
  redis.call('HSET', KEYS[1], 'owner', ARGV[1], 'token', token)
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return tostring(token)
end

if current_owner == ARGV[1] then
  local token = redis.call('HGET', KEYS[1], 'token')
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return token
end

return false
`;

const RENEW_SCRIPT = `
local current_owner = redis.call('HGET', KEYS[1], 'owner')
local current_token = redis.call('HGET', KEYS[1], 'token')

if current_owner == ARGV[1] and current_token == ARGV[2] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[3])
end

return 0
`;

const RELEASE_SCRIPT = `
local current_owner = redis.call('HGET', KEYS[1], 'owner')
local current_token = redis.call('HGET', KEYS[1], 'token')

if current_owner == ARGV[1] and current_token == ARGV[2] then
  return redis.call('DEL', KEYS[1])
end

return 0
`;

export type RedisScriptClient = {
  eval(script: string, numberOfKeys: number, ...arguments_: string[]): Promise<unknown>;
};

export class RedisRiskUnitLock implements RiskUnitLock {
  constructor(private readonly client: RedisScriptClient) {}

  async acquire(input: AcquireRiskUnitLockInput): Promise<RiskUnitLockLease | undefined> {
    assertRiskUnitId(input.riskUnitId);
    assertOwner(input.owner);
    assertTtl(input.ttlMs);
    const keys = riskUnitLockKeys(input.riskUnitId);
    const result = await this.client.eval(
      ACQUIRE_SCRIPT,
      2,
      keys.lease,
      keys.fencingCounter,
      input.owner,
      input.ttlMs.toString()
    );

    if (result === null) {
      return undefined;
    }

    return {
      riskUnitId: input.riskUnitId,
      owner: input.owner,
      fencingToken: parseFencingToken(result)
    };
  }

  async renew(lease: RiskUnitLockLease, ttlMs: number): Promise<boolean> {
    assertRiskUnitId(lease.riskUnitId);
    assertOwner(lease.owner);
    assertTtl(ttlMs);
    const keys = riskUnitLockKeys(lease.riskUnitId);
    const result = await this.client.eval(
      RENEW_SCRIPT,
      1,
      keys.lease,
      lease.owner,
      lease.fencingToken.toString(),
      ttlMs.toString()
    );
    return parseRedisBoolean(result);
  }

  async release(lease: RiskUnitLockLease): Promise<boolean> {
    assertRiskUnitId(lease.riskUnitId);
    assertOwner(lease.owner);
    const keys = riskUnitLockKeys(lease.riskUnitId);
    const result = await this.client.eval(
      RELEASE_SCRIPT,
      1,
      keys.lease,
      lease.owner,
      lease.fencingToken.toString()
    );
    return parseRedisBoolean(result);
  }
}

export function riskUnitLockKeys(riskUnitId: string): {
  readonly lease: string;
  readonly fencingCounter: string;
} {
  const digest = createHash("sha256").update(riskUnitId).digest("hex");
  const hashTag = `{${digest}}`;
  return {
    lease: `liquidation:risk-unit:${hashTag}:lease`,
    fencingCounter: `liquidation:risk-unit:${hashTag}:fencing-counter`
  };
}

function parseFencingToken(value: unknown): bigint {
  const text = redisScalarToString(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new InvariantViolationError("Redis returned an invalid fencing token", { value: text });
  }
  return BigInt(text);
}

function parseRedisBoolean(value: unknown): boolean {
  const text = redisScalarToString(value);
  if (text === "1") {
    return true;
  }
  if (text === "0") {
    return false;
  }
  throw new InvariantViolationError("Redis script returned an invalid boolean", { value: text });
}

function redisScalarToString(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  throw new InvariantViolationError("Redis script returned a non-scalar value");
}

function assertRiskUnitId(riskUnitId: string): void {
  if (riskUnitId.length < 1 || riskUnitId.length > 128) {
    throw new ValidationError("riskUnitId must be between 1 and 128 characters");
  }
}

function assertOwner(owner: string): void {
  if (owner.length < 1 || owner.length > 128) {
    throw new ValidationError("lock owner must be between 1 and 128 characters");
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) {
    throw new ValidationError("lock TTL must be between 1000 and 300000 milliseconds", {
      ttlMs
    });
  }
}

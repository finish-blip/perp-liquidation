import { describe, expect, it, vi } from "vitest";

import { InvariantViolationError } from "../../../../src/domain/shared/errors.js";
import {
  RedisRiskUnitLock,
  riskUnitLockKeys,
  type RedisScriptClient
} from "../../../../src/infrastructure/redis/risk-unit-lock.js";

describe("RedisRiskUnitLock", () => {
  it("preserves fencing tokens beyond Number.MAX_SAFE_INTEGER", async () => {
    const evaluate = vi.fn<RedisScriptClient["eval"]>(() =>
      Promise.resolve("9007199254740993")
    );
    const lock = new RedisRiskUnitLock({ eval: evaluate });

    const lease = await lock.acquire({
      riskUnitId: "account-1:BTCUSDT",
      owner: "worker-1/task-1",
      ttlMs: 30_000
    });

    expect(lease?.fencingToken).toBe(9_007_199_254_740_993n);
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(String),
      2,
      expect.stringContaining(":lease"),
      expect.stringContaining(":fencing-counter"),
      "worker-1/task-1",
      "30000"
    );
  });

  it("returns undefined when another owner holds the risk unit", async () => {
    const evaluate = vi.fn<RedisScriptClient["eval"]>(() => Promise.resolve(null));
    const lock = new RedisRiskUnitLock({ eval: evaluate });

    await expect(
      lock.acquire({ riskUnitId: "risk-1", owner: "worker-2/task-2", ttlMs: 5000 })
    ).resolves.toBeUndefined();
  });

  it("renews and releases only when Lua confirms owner and token", async () => {
    const evaluate = vi
      .fn<RedisScriptClient["eval"]>()
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce(0);
    const lock = new RedisRiskUnitLock({ eval: evaluate });
    const lease = {
      riskUnitId: "risk-1",
      owner: "worker-1/task-1",
      fencingToken: 7n
    };

    await expect(lock.renew(lease, 5000)).resolves.toBe(true);
    await expect(lock.release(lease)).resolves.toBe(false);
  });

  it("rejects malformed fencing tokens returned by Redis", async () => {
    const evaluate = vi.fn<RedisScriptClient["eval"]>(() => Promise.resolve("7.5"));
    const lock = new RedisRiskUnitLock({ eval: evaluate });

    await expect(
      lock.acquire({ riskUnitId: "risk-1", owner: "worker-1/task-1", ttlMs: 5000 })
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it("uses one Redis Cluster hash tag for the lease and counter keys", () => {
    const keys = riskUnitLockKeys("account:{untrusted}:BTCUSDT");
    const leaseHashTag = /\{([^}]+)\}/.exec(keys.lease)?.[1];
    const counterHashTag = /\{([^}]+)\}/.exec(keys.fencingCounter)?.[1];

    expect(leaseHashTag).toBeDefined();
    expect(leaseHashTag).toBe(counterHashTag);
    expect(leaseHashTag).toMatch(/^[a-f0-9]{64}$/);
  });
});

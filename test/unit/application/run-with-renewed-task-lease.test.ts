import { describe, expect, it, vi } from "vitest";

import { runWithRenewedTaskLease } from "../../../src/application/run-with-renewed-task-lease.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import type { ClaimedLiquidationTask } from "../../../src/application/claim-liquidation-task.js";

describe("runWithRenewedTaskLease", () => {
  it("renews the task lease while work is still running", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => Promise.resolve(true));

    try {
      const execution = runWithRenewedTaskLease({
        claim: claimedTask(),
        renewer: { execute },
        renewalIntervalMs: 10,
        action: async (signal) => {
          await delay(35);
          expect(signal.aborted).toBe(false);
          return "completed";
        }
      });

      await vi.advanceTimersByTimeAsync(35);
      const result = await execution;

      expect(result).toBe("completed");
      expect(execute.mock.calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts in-flight work when the lease is lost", async () => {
    const execute = vi.fn(() => Promise.resolve(false));

    await expect(
      runWithRenewedTaskLease({
        claim: claimedTask(),
        renewer: { execute },
        renewalIntervalMs: 10,
        action: waitForAbort
      })
    ).rejects.toMatchObject({ code: "CONFLICT", retryable: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates renewal failures after aborting in-flight work", async () => {
    const failure = new Error("redis unavailable");
    const execute = vi.fn(() => Promise.reject(failure));

    await expect(
      runWithRenewedTaskLease({
        claim: claimedTask(),
        renewer: { execute },
        renewalIntervalMs: 10,
        action: waitForAbort
      })
    ).rejects.toBe(failure);
  });
});

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("Task lease action aborted"));
      },
      { once: true }
    );
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function claimedTask(): ClaimedLiquidationTask {
  const now = assertUtcIsoString("2026-07-19T00:00:00.000Z");
  const taskId = assertEntityId("task_lease_heartbeat", "task");
  return {
    task: {
      id: taskId,
      inboxMessageId: "message-1",
      correlationId: "correlation-1",
      riskUnitId: "account-1:BTCUSDT",
      commandType: "LIQUIDATE_POSITION",
      status: "CLAIMED",
      priority: 100,
      decisionSequence: 1n,
      fencingToken: 1n,
      leaseOwner: "worker-1",
      leaseExpiresAt: assertUtcIsoString("2026-07-19T00:00:30.000Z"),
      version: 2,
      commandPayload: {},
      createdAt: now,
      updatedAt: now
    },
    riskUnitLease: {
      riskUnitId: "account-1:BTCUSDT",
      owner: `worker-1/${taskId}`,
      fencingToken: 1n
    }
  };
}

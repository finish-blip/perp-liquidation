import { describe, expect, it, vi } from "vitest";

import {
  ClaimLiquidationTask,
  RenewClaimedTaskLease,
  type ClaimedLiquidationTask
} from "../../../src/application/claim-liquidation-task.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import type { RiskUnitFenceRepository } from "../../../src/repositories/risk-unit-fence-repository.js";
import type { RiskUnitLock } from "../../../src/repositories/risk-unit-lock.js";
import type { TaskEventRepository } from "../../../src/repositories/task-event-repository.js";
import type { TaskRecord, TaskRepository } from "../../../src/repositories/task-repository.js";
import type {
  WorkerLeaseRepositories,
  WorkerLeaseUnitOfWork
} from "../../../src/repositories/worker-lease-unit-of-work.js";

const NOW = assertUtcIsoString("2026-07-18T03:00:00.000Z");
const TASK_ID = assertEntityId("task_claim", "task");
const LEASE = {
  riskUnitId: "account-1:BTCUSDT",
  owner: `worker-1/${TASK_ID}`,
  fencingToken: 17n
};

describe("ClaimLiquidationTask", () => {
  it("commits the task claim before Redis and registers fencing in a second transaction", async () => {
    const harness = createHarness();
    const useCase = new ClaimLiquidationTask(
      {
        unitOfWork: harness.unitOfWork,
        riskUnitLock: harness.riskUnitLock,
        clock: () => new Date(NOW)
      },
      defaultOptions()
    );

    const outcome = await useCase.execute();

    expect(outcome.status).toBe("CLAIMED");
    if (outcome.status !== "CLAIMED") {
      throw new Error("Expected claimed task");
    }
    expect(outcome.claim.task.fencingToken).toBe(17n);
    expect(harness.order).toEqual([
      "tx-begin",
      "find-expired",
      "claim-task",
      "append-event:TASK_CLAIMED",
      "tx-commit",
      "redis-acquire",
      "tx-begin",
      "activate-fence",
      "attach-fence",
      "tx-commit"
    ]);
  });

  it("returns the claimed task to READY when the Redis risk unit is busy", async () => {
    const harness = createHarness({ lockBusy: true });
    const useCase = new ClaimLiquidationTask(
      {
        unitOfWork: harness.unitOfWork,
        riskUnitLock: harness.riskUnitLock,
        clock: () => new Date(NOW)
      },
      defaultOptions()
    );

    await expect(useCase.execute()).resolves.toEqual({
      status: "RISK_UNIT_BUSY",
      taskId: TASK_ID
    });
    expect(harness.mocks.taskTransition).toHaveBeenCalledWith(
      TASK_ID,
      "READY",
      expect.objectContaining({ at: NOW })
    );
    expect(harness.mocks.fenceActivate).not.toHaveBeenCalled();
    expect(harness.mocks.taskEventAppend).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "TASK_LOCK_CONTENDED" })
    );
  });

  it("preserves reconciliation status when its Redis risk unit is busy", async () => {
    const harness = createHarness({ lockBusy: true });
    const useCase = new ClaimLiquidationTask(
      {
        unitOfWork: harness.unitOfWork,
        riskUnitLock: harness.riskUnitLock,
        clock: () => new Date(NOW)
      },
      { ...defaultOptions(), claimStatuses: ["NEEDS_RECONCILIATION"] }
    );

    await expect(useCase.execute()).resolves.toEqual({
      status: "RISK_UNIT_BUSY",
      taskId: TASK_ID
    });
    expect(harness.mocks.taskTransition).toHaveBeenCalledWith(
      TASK_ID,
      "NEEDS_RECONCILIATION",
      expect.objectContaining({ at: NOW })
    );
  });

  it("moves expired active work to reconciliation before looking for a new task", async () => {
    const expired = taskRecord({
      id: assertEntityId("task_expired", "task"),
      status: "VALIDATING",
      version: 3,
      leaseOwner: "dead-worker",
      leaseExpiresAt: assertUtcIsoString("2026-07-18T02:59:00.000Z")
    });
    const harness = createHarness({ expiredTasks: [expired], noTask: true });
    const useCase = new ClaimLiquidationTask(
      {
        unitOfWork: harness.unitOfWork,
        riskUnitLock: harness.riskUnitLock,
        clock: () => new Date(NOW)
      },
      defaultOptions()
    );

    await expect(useCase.execute()).resolves.toEqual({ status: "NO_TASK" });
    expect(harness.mocks.taskTransition).toHaveBeenCalledWith(
      expired.id,
      "NEEDS_RECONCILIATION",
      expect.objectContaining({ at: NOW })
    );
    expect(harness.mocks.taskEventAppend).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "TASK_LEASE_EXPIRED", eventSequence: 5n })
    );
    expect(harness.mocks.lockAcquire).not.toHaveBeenCalled();
  });
});

describe("RenewClaimedTaskLease", () => {
  it("does not touch MySQL after Redis reports that the lock was lost", async () => {
    const harness = createHarness({ renewResult: false });
    const renew = new RenewClaimedTaskLease(
      {
        unitOfWork: harness.unitOfWork,
        riskUnitLock: harness.riskUnitLock,
        clock: () => new Date(NOW)
      },
      {
        workerId: "worker-1",
        taskLeaseMs: 30_000,
        riskLockTtlMs: 20_000
      }
    );

    await expect(renew.execute(claimedTask())).resolves.toBe(false);
    expect(harness.mocks.fenceActivate).not.toHaveBeenCalled();
    expect(harness.mocks.taskRenewLease).not.toHaveBeenCalled();
  });

  it("renews Redis before extending the database fence and task lease", async () => {
    const harness = createHarness();
    const renew = new RenewClaimedTaskLease(
      {
        unitOfWork: harness.unitOfWork,
        riskUnitLock: harness.riskUnitLock,
        clock: () => new Date(NOW)
      },
      {
        workerId: "worker-1",
        taskLeaseMs: 30_000,
        riskLockTtlMs: 20_000
      }
    );

    await expect(renew.execute(claimedTask())).resolves.toBe(true);
    expect(harness.order).toEqual([
      "redis-renew",
      "tx-begin",
      "activate-fence",
      "renew-task-lease",
      "tx-commit"
    ]);
  });
});

type HarnessOptions = {
  readonly expiredTasks?: TaskRecord[];
  readonly lockBusy?: boolean;
  readonly noTask?: boolean;
  readonly renewResult?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const claimed = taskRecord({
    status: "CLAIMED",
    version: 2,
    leaseOwner: "worker-1",
    leaseExpiresAt: assertUtcIsoString("2026-07-18T03:00:30.000Z")
  });

  const taskFindExpired = vi.fn<TaskRepository["findExpiredLeased"]>(() => {
    order.push("find-expired");
    return Promise.resolve(options.expiredTasks ?? []);
  });
  const taskClaimNext = vi.fn<TaskRepository["claimNext"]>(() => {
    order.push("claim-task");
    return Promise.resolve(options.noTask === true ? undefined : claimed);
  });
  const taskTransition = vi.fn<TaskRepository["transition"]>((id, status, context) => {
    const current = options.expiredTasks?.find((task) => task.id === id) ?? claimed;
    return Promise.resolve({
      ...current,
      status,
      version: current.version + 1,
      updatedAt: context.at,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      ...(context.reason === undefined ? {} : { statusReason: context.reason })
    });
  });
  const taskAttachFence = vi.fn<TaskRepository["attachFencingToken"]>((input) => {
    order.push("attach-fence");
    return Promise.resolve({
      ...claimed,
      fencingToken: input.fencingToken,
      updatedAt: input.now
    });
  });
  const taskRenewLease = vi.fn<TaskRepository["renewLease"]>((input) => {
    order.push("renew-task-lease");
    return Promise.resolve({
      ...claimed,
      fencingToken: input.fencingToken,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.now
    });
  });
  const taskEventAppend = vi.fn<TaskEventRepository["append"]>((input) => {
    order.push(`append-event:${input.eventType}`);
    return Promise.resolve();
  });
  const fenceActivate = vi.fn<RiskUnitFenceRepository["activate"]>((input) => {
    order.push("activate-fence");
    return Promise.resolve(input);
  });
  const lockAcquire = vi.fn<RiskUnitLock["acquire"]>(() => {
    order.push("redis-acquire");
    return Promise.resolve(options.lockBusy === true ? undefined : LEASE);
  });
  const lockRenew = vi.fn<RiskUnitLock["renew"]>(() => {
    order.push("redis-renew");
    return Promise.resolve(options.renewResult ?? true);
  });

  const repositories: WorkerLeaseRepositories = {
    tasks: {
      create: vi.fn<TaskRepository["create"]>(() => {
        throw new Error("Not used by worker lease tests");
      }),
      findById: vi.fn<TaskRepository["findById"]>(() => Promise.resolve(undefined)),
      findSupersedable: vi.fn<TaskRepository["findSupersedable"]>(() => Promise.resolve([])),
      findExpiredLeased: taskFindExpired,
      transition: taskTransition,
      claimNext: taskClaimNext,
      attachFencingToken: taskAttachFence,
      renewLease: taskRenewLease
    },
    taskEvents: {
      append: taskEventAppend
    },
    riskUnitFences: {
      activate: fenceActivate,
      assertCurrent: vi.fn<RiskUnitFenceRepository["assertCurrent"]>(() => Promise.resolve()),
      revoke: vi.fn<RiskUnitFenceRepository["revoke"]>(() => Promise.resolve())
    }
  };
  const riskUnitLock: RiskUnitLock = {
    acquire: lockAcquire,
    renew: lockRenew,
    release: vi.fn<RiskUnitLock["release"]>(() => Promise.resolve(true))
  };

  return {
    order,
    unitOfWork: new RecordingUnitOfWork(repositories, order),
    riskUnitLock,
    mocks: {
      fenceActivate,
      lockAcquire,
      taskEventAppend,
      taskRenewLease,
      taskTransition
    }
  };
}

class RecordingUnitOfWork implements WorkerLeaseUnitOfWork {
  constructor(
    private readonly repositories: WorkerLeaseRepositories,
    private readonly order: string[]
  ) {}

  async execute<T>(handler: (repositories: WorkerLeaseRepositories) => Promise<T>): Promise<T> {
    this.order.push("tx-begin");
    const result = await handler(this.repositories);
    this.order.push("tx-commit");
    return result;
  }
}

function defaultOptions() {
  return {
    workerId: "worker-1",
    taskLeaseMs: 30_000,
    riskLockTtlMs: 20_000,
    priorityAgingIntervalSeconds: 60,
    recoveryBatchSize: 10
  } as const;
}

function claimedTask(): ClaimedLiquidationTask {
  return {
    task: taskRecord({
      status: "CLAIMED",
      version: 2,
      leaseOwner: "worker-1",
      leaseExpiresAt: assertUtcIsoString("2026-07-18T03:00:30.000Z"),
      fencingToken: 17n
    }),
    riskUnitLease: LEASE
  };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: TASK_ID,
    inboxMessageId: "message-1",
    correlationId: "correlation-1",
    riskUnitId: "account-1:BTCUSDT",
    commandType: "LIQUIDATE_POSITION",
    status: "READY",
    priority: 100,
    decisionSequence: 42n,
    fencingToken: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    version: 1,
    commandPayload: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

import { ValidationError } from "../domain/shared/errors.js";
import { addMillis, nowUtcIso, type UtcIsoString } from "../domain/shared/time.js";
import type { RiskUnitLock, RiskUnitLockLease } from "../repositories/risk-unit-lock.js";
import type { TaskRecord } from "../repositories/task-repository.js";
import type {
  WorkerLeaseRepositories,
  WorkerLeaseUnitOfWork
} from "../repositories/worker-lease-unit-of-work.js";

export type ClaimLiquidationTaskOptions = {
  readonly workerId: string;
  readonly taskLeaseMs: number;
  readonly riskLockTtlMs: number;
  readonly priorityAgingIntervalSeconds: number;
  readonly recoveryBatchSize: number;
  readonly claimStatuses?: readonly ("READY" | "NEEDS_RECONCILIATION")[];
};

export type ClaimedLiquidationTask = {
  readonly task: TaskRecord;
  readonly riskUnitLease: RiskUnitLockLease;
};

export type ClaimLiquidationTaskOutcome =
  | {
      readonly status: "CLAIMED";
      readonly claim: ClaimedLiquidationTask;
    }
  | {
      readonly status: "NO_TASK";
    }
  | {
      readonly status: "RISK_UNIT_BUSY";
      readonly taskId: TaskRecord["id"];
    };

export type ClaimLiquidationTaskDependencies = {
  readonly unitOfWork: WorkerLeaseUnitOfWork;
  readonly riskUnitLock: RiskUnitLock;
  readonly clock?: () => Date;
};

export class ClaimLiquidationTask {
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: ClaimLiquidationTaskDependencies,
    private readonly options: ClaimLiquidationTaskOptions
  ) {
    validateOptions(options);
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async execute(): Promise<ClaimLiquidationTaskOutcome> {
    const claimedAt = nowUtcIso(this.clock);
    const task = await this.dependencies.unitOfWork.execute(async (repositories) => {
      await recoverExpiredTasks(repositories, claimedAt, this.options.recoveryBatchSize);
      const claimed = await repositories.tasks.claimNext({
        workerId: this.options.workerId,
        leaseExpiresAt: addMillis(claimedAt, this.options.taskLeaseMs),
        statuses: this.options.claimStatuses ?? ["READY"],
        now: claimedAt,
        priorityAgingIntervalSeconds: this.options.priorityAgingIntervalSeconds
      });

      if (claimed !== undefined) {
        await repositories.taskEvents.append({
          taskId: claimed.id,
          eventType: "TASK_CLAIMED",
          eventSequence: eventSequenceFor(claimed.version),
          payload: {
            worker_id: this.options.workerId,
            lease_expires_at: claimed.leaseExpiresAt
          },
          createdAt: claimedAt
        });
      }

      return claimed;
    });

    if (task === undefined) {
      return { status: "NO_TASK" };
    }

    const lockOwner = `${this.options.workerId}/${task.id}`;
    const riskUnitLease = await this.dependencies.riskUnitLock.acquire({
      riskUnitId: task.riskUnitId,
      owner: lockOwner,
      ttlMs: this.options.riskLockTtlMs
    });

    if (riskUnitLease === undefined) {
      await this.returnTaskAfterContention(task, claimedAt);
      return {
        status: "RISK_UNIT_BUSY",
        taskId: task.id
      };
    }

    try {
      const fencedTask = await this.attachFence(task, riskUnitLease);
      return {
        status: "CLAIMED",
        claim: {
          task: fencedTask,
          riskUnitLease
        }
      };
    } catch (error) {
      try {
        await this.dependencies.riskUnitLock.release(riskUnitLease);
      } catch {
        // The Redis TTL remains the final cleanup path if release itself fails.
      }
      throw error;
    }
  }

  private async attachFence(
    task: TaskRecord,
    lease: RiskUnitLockLease
  ): Promise<TaskRecord> {
    const now = nowUtcIso(this.clock);
    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await repositories.riskUnitFences.activate({
        riskUnitId: task.riskUnitId,
        owner: lease.owner,
        fencingToken: lease.fencingToken,
        expiresAt: addMillis(now, this.options.riskLockTtlMs),
        now
      });
      return repositories.tasks.attachFencingToken({
        taskId: task.id,
        workerId: this.options.workerId,
        fencingToken: lease.fencingToken,
        now
      });
    });
  }

  private async returnTaskAfterContention(task: TaskRecord, at: UtcIsoString): Promise<void> {
    const status = contentionReturnStatus(this.options.claimStatuses);
    await this.dependencies.unitOfWork.execute(async (repositories) => {
      const ready = await repositories.tasks.transition(task.id, status, {
        at,
        reason: "risk unit lock is held by another worker"
      });
      await repositories.taskEvents.append({
        taskId: ready.id,
        eventType: "TASK_LOCK_CONTENDED",
        eventSequence: eventSequenceFor(ready.version),
        payload: {
          status: ready.status,
          risk_unit_id: ready.riskUnitId
        },
        createdAt: at
      });
    });
  }
}

function contentionReturnStatus(
  statuses: ClaimLiquidationTaskOptions["claimStatuses"]
): "READY" | "NEEDS_RECONCILIATION" {
  return statuses?.length === 1 && statuses[0] === "NEEDS_RECONCILIATION"
    ? "NEEDS_RECONCILIATION"
    : "READY";
}

export type RenewClaimedTaskLeaseOptions = Pick<
  ClaimLiquidationTaskOptions,
  "workerId" | "taskLeaseMs" | "riskLockTtlMs"
>;

export class RenewClaimedTaskLease {
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: ClaimLiquidationTaskDependencies,
    private readonly options: RenewClaimedTaskLeaseOptions
  ) {
    validateLeaseOptions(options);
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async execute(claim: ClaimedLiquidationTask): Promise<boolean> {
    const renewed = await this.dependencies.riskUnitLock.renew(
      claim.riskUnitLease,
      this.options.riskLockTtlMs
    );
    if (!renewed) {
      return false;
    }

    const now = nowUtcIso(this.clock);
    await this.dependencies.unitOfWork.execute(async (repositories) => {
      await repositories.riskUnitFences.activate({
        riskUnitId: claim.riskUnitLease.riskUnitId,
        owner: claim.riskUnitLease.owner,
        fencingToken: claim.riskUnitLease.fencingToken,
        expiresAt: addMillis(now, this.options.riskLockTtlMs),
        now
      });
      await repositories.tasks.renewLease({
        taskId: claim.task.id,
        workerId: this.options.workerId,
        fencingToken: claim.riskUnitLease.fencingToken,
        leaseExpiresAt: addMillis(now, this.options.taskLeaseMs),
        now
      });
    });
    return true;
  }
}

async function recoverExpiredTasks(
  repositories: WorkerLeaseRepositories,
  now: UtcIsoString,
  limit: number
): Promise<void> {
  const expired = await repositories.tasks.findExpiredLeased({ now, limit });

  for (const task of expired) {
    const recovered = await repositories.tasks.transition(task.id, "NEEDS_RECONCILIATION", {
      at: now,
      reason: `lease owned by ${task.leaseOwner ?? "unknown"} expired`
    });
    await repositories.taskEvents.append({
      taskId: recovered.id,
      eventType: "TASK_LEASE_EXPIRED",
      eventSequence: eventSequenceFor(recovered.version),
      payload: {
        previous_status: task.status,
        previous_owner: task.leaseOwner
      },
      createdAt: now
    });
  }
}

function eventSequenceFor(taskVersion: number): bigint {
  return BigInt(taskVersion + 1);
}

function validateOptions(options: ClaimLiquidationTaskOptions): void {
  validateLeaseOptions(options);
  if (
    !Number.isInteger(options.priorityAgingIntervalSeconds) ||
    options.priorityAgingIntervalSeconds < 1 ||
    options.priorityAgingIntervalSeconds > 86_400
  ) {
    throw new ValidationError("priorityAgingIntervalSeconds must be between 1 and 86400");
  }
  if (
    !Number.isInteger(options.recoveryBatchSize) ||
    options.recoveryBatchSize < 1 ||
    options.recoveryBatchSize > 1000
  ) {
    throw new ValidationError("recoveryBatchSize must be between 1 and 1000");
  }
  if (options.claimStatuses?.length === 0) {
    throw new ValidationError("claimStatuses must contain READY or NEEDS_RECONCILIATION");
  }
  if (options.claimStatuses !== undefined && new Set(options.claimStatuses).size !== 1) {
    throw new ValidationError("claimStatuses must select exactly one worker task class");
  }
}

function validateLeaseOptions(options: RenewClaimedTaskLeaseOptions): void {
  if (options.workerId.length < 1 || options.workerId.length > 64) {
    throw new ValidationError("workerId must be between 1 and 64 characters");
  }
  if (
    !Number.isInteger(options.taskLeaseMs) ||
    options.taskLeaseMs < 1000 ||
    options.taskLeaseMs > 300_000
  ) {
    throw new ValidationError("taskLeaseMs must be between 1000 and 300000");
  }
  if (
    !Number.isInteger(options.riskLockTtlMs) ||
    options.riskLockTtlMs < 1000 ||
    options.riskLockTtlMs > options.taskLeaseMs
  ) {
    throw new ValidationError("riskLockTtlMs must be between 1000 and taskLeaseMs");
  }
}

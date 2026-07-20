import { describe, expect, it, vi } from "vitest";

import { OperationApprovals } from "../../../src/application/operation-approvals.js";
import { ConflictError, ValidationError } from "../../../src/domain/shared/errors.js";
import { assertDecimalString } from "../../../src/domain/shared/decimal.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import type {
  ApprovalRecord,
  ApprovalRepository
} from "../../../src/repositories/approval-repository.js";
import type {
  ApprovalRepositories,
  ApprovalUnitOfWork
} from "../../../src/repositories/approval-unit-of-work.js";
import type { OutboxMessage, OutboxRepository } from "../../../src/repositories/outbox-repository.js";
import type { RiskUnitFenceRepository } from "../../../src/repositories/risk-unit-fence-repository.js";
import type { TaskEventRepository } from "../../../src/repositories/task-event-repository.js";
import type { TaskRecord, TaskRepository } from "../../../src/repositories/task-repository.js";

const NOW = assertUtcIsoString("2026-07-18T07:00:00.000Z");
const APPROVAL_ID = assertEntityId("approval_1", "approval");
const TASK_ID = assertEntityId("task_approval", "task");
const OUTBOX_ID = assertEntityId("outbox_approval", "outbox");

describe("OperationApprovals", () => {
  it("creates an idempotent approval request", async () => {
    const harness = createHarness();
    const service = createService(harness);

    await expect(service.request(forceRequest())).resolves.toEqual(
      expect.objectContaining({ status: "CREATED" })
    );
    await expect(service.request(forceRequest())).resolves.toEqual(
      expect.objectContaining({ status: "DUPLICATE" })
    );
    expect(harness.mocks.approvalCreate).toHaveBeenCalledTimes(2);
  });

  it("rejects self-approval before executing the operation", async () => {
    const harness = createHarness();
    const service = createService(harness);
    await service.request(forceRequest());

    await expect(service.approve(APPROVAL_ID, "operator-a")).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(harness.mocks.taskTransition).not.toHaveBeenCalled();
    expect(harness.mocks.approvalMarkExecuted).not.toHaveBeenCalled();
  });

  it("forces reconciliation by revoking the fence and transitioning atomically", async () => {
    const harness = createHarness();
    const service = createService(harness);
    await service.request(forceRequest());

    const outcome = await service.approve(APPROVAL_ID, "operator-b");

    expect(outcome.status).toBe("EXECUTED");
    expect(harness.mocks.fenceRevoke).toHaveBeenCalledWith("account-1:BTCUSDT");
    expect(harness.mocks.taskTransition).toHaveBeenCalledWith(
      TASK_ID,
      "NEEDS_RECONCILIATION",
      expect.objectContaining({ at: NOW })
    );
    expect(harness.mocks.taskEventAppend).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "APPROVAL_FORCE_RECONCILIATION" })
    );
    expect(harness.mocks.approvalMarkExecuted).toHaveBeenCalledWith({
      id: APPROVAL_ID,
      approvedBy: "operator-b",
      decidedAt: NOW
    });
  });

  it("does not allow cancellation after an order has filled", async () => {
    const harness = createHarness({ taskStatus: "WAITING_SETTLEMENT" });
    const service = createService(harness);
    await service.request({ ...forceRequest(), actionType: "CANCEL_TASK" });

    await expect(service.approve(APPROVAL_ID, "operator-b")).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(harness.mocks.fenceRevoke).not.toHaveBeenCalled();
    expect(harness.mocks.approvalMarkExecuted).not.toHaveBeenCalled();
  });

  it("does not cancel a task whose order state requires reconciliation", async () => {
    const harness = createHarness({ taskStatus: "NEEDS_RECONCILIATION" });
    const service = createService(harness);
    await service.request({ ...forceRequest(), actionType: "CANCEL_TASK" });

    await expect(service.approve(APPROVAL_ID, "operator-b")).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(harness.mocks.fenceRevoke).not.toHaveBeenCalled();
    expect(harness.mocks.taskTransition).not.toHaveBeenCalled();
  });

  it("does not force a settled task back out of result publishing", async () => {
    const harness = createHarness({ taskStatus: "RESULT_PUBLISHING" });
    const service = createService(harness);
    await service.request(forceRequest());

    await expect(service.approve(APPROVAL_ID, "operator-b")).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(harness.mocks.fenceRevoke).not.toHaveBeenCalled();
    expect(harness.mocks.taskTransition).not.toHaveBeenCalled();
  });

  it("replays only DEAD Outbox messages after approval", async () => {
    const harness = createHarness({ outboxStatus: "DEAD" });
    const service = createService(harness);
    await service.request({
      approvalId: APPROVAL_ID,
      actionType: "REPLAY_OUTBOX",
      targetId: OUTBOX_ID,
      reason: "manual replay after broker recovery",
      requestedBy: "operator-a"
    });

    await expect(service.approve(APPROVAL_ID, "operator-b")).resolves.toEqual(
      expect.objectContaining({ status: "EXECUTED" })
    );
    expect(harness.mocks.outboxReplay).toHaveBeenCalledWith(OUTBOX_ID, NOW);
  });

  it("records rejection without running the requested action", async () => {
    const harness = createHarness();
    const service = createService(harness);
    await service.request(forceRequest());

    const outcome = await service.reject(
      APPROVAL_ID,
      "operator-b",
      "insufficient evidence"
    );

    expect(outcome.status).toBe("REJECTED");
    expect(harness.mocks.approvalMarkRejected).toHaveBeenCalledWith({
      id: APPROVAL_ID,
      rejectedBy: "operator-b",
      reason: "insufficient evidence",
      decidedAt: NOW
    });
    expect(harness.mocks.taskTransition).not.toHaveBeenCalled();
  });
});

type HarnessOptions = {
  readonly taskStatus?: TaskRecord["status"];
  readonly outboxStatus?: OutboxMessage["status"];
};

function createHarness(options: HarnessOptions = {}) {
  let approval: ApprovalRecord | undefined;
  let task = taskRecord(options.taskStatus ?? "READY");
  const outbox = outboxMessage(options.outboxStatus ?? "PENDING");
  const approvalCreate = vi.fn<ApprovalRepository["create"]>((input) => {
    if (approval !== undefined) {
      return Promise.resolve({ created: false, approval });
    }
    approval = {
      ...input,
      status: "PENDING",
      decidedBy: undefined,
      decisionReason: undefined,
      decidedAt: undefined,
      executedAt: undefined
    };
    return Promise.resolve({ created: true, approval });
  });
  const approvalMarkExecuted = vi.fn<ApprovalRepository["markExecuted"]>((input) => {
    if (approval === undefined) {
      return Promise.reject(new Error("approval missing"));
    }
    approval = {
      ...approval,
      status: "EXECUTED",
      decidedBy: input.approvedBy,
      decidedAt: input.decidedAt,
      executedAt: input.decidedAt
    };
    return Promise.resolve();
  });
  const approvalMarkRejected = vi.fn<ApprovalRepository["markRejected"]>(() =>
    Promise.resolve()
  );
  const taskTransition = vi.fn<TaskRepository["transition"]>((_id, status, context) => {
    task = {
      ...task,
      status,
      version: task.version + 1,
      updatedAt: context.at,
      ...(context.reason === undefined ? {} : { statusReason: context.reason })
    };
    return Promise.resolve(task);
  });
  const fenceRevoke = vi.fn<RiskUnitFenceRepository["revoke"]>(() => Promise.resolve());
  const taskEventAppend = vi.fn<TaskEventRepository["append"]>(() => Promise.resolve());
  const outboxReplay = vi.fn<OutboxRepository["replayDead"]>(() => Promise.resolve());
  const repositories: ApprovalRepositories = {
    approvals: {
      create: approvalCreate,
      findById: vi.fn<ApprovalRepository["findById"]>(() => Promise.resolve(approval)),
      findByIdForUpdate: vi.fn<ApprovalRepository["findByIdForUpdate"]>(() =>
        Promise.resolve(approval)
      ),
      markExecuted: approvalMarkExecuted,
      markRejected: approvalMarkRejected
    },
    outbox: {
      create: unexpectedCall,
      findById: vi.fn<OutboxRepository["findById"]>(() => Promise.resolve(outbox)),
      claimDue: vi.fn<OutboxRepository["claimDue"]>(() => Promise.resolve([])),
      markPublished: unexpectedCall,
      markFailed: unexpectedCall,
      markDead: unexpectedCall,
      replayDead: outboxReplay
    },
    riskUnitFences: {
      activate: vi.fn<RiskUnitFenceRepository["activate"]>((input) =>
        Promise.resolve(input)
      ),
      assertCurrent: vi.fn<RiskUnitFenceRepository["assertCurrent"]>(() =>
        Promise.resolve()
      ),
      revoke: fenceRevoke
    },
    taskEvents: { append: taskEventAppend },
    tasks: {
      create: unexpectedCall,
      findById: vi.fn<TaskRepository["findById"]>(() => Promise.resolve(task)),
      findSupersedable: vi.fn<TaskRepository["findSupersedable"]>(() =>
        Promise.resolve([])
      ),
      findExpiredLeased: vi.fn<TaskRepository["findExpiredLeased"]>(() =>
        Promise.resolve([])
      ),
      transition: taskTransition,
      claimNext: vi.fn<TaskRepository["claimNext"]>(() => Promise.resolve(undefined)),
      attachFencingToken: unexpectedCall,
      renewLease: unexpectedCall
    }
  };
  return {
    unitOfWork: new FakeApprovalUnitOfWork(repositories),
    mocks: {
      approvalCreate,
      approvalMarkExecuted,
      approvalMarkRejected,
      fenceRevoke,
      outboxReplay,
      taskEventAppend,
      taskTransition
    }
  };
}

class FakeApprovalUnitOfWork implements ApprovalUnitOfWork {
  constructor(private readonly repositories: ApprovalRepositories) {}

  execute<T>(handler: (repositories: ApprovalRepositories) => Promise<T>): Promise<T> {
    return handler(this.repositories);
  }
}

function createService(harness: ReturnType<typeof createHarness>): OperationApprovals {
  return new OperationApprovals(harness.unitOfWork, () => new Date(NOW));
}

function forceRequest() {
  return {
    approvalId: APPROVAL_ID,
    actionType: "FORCE_RECONCILIATION" as const,
    targetId: TASK_ID,
    reason: "worker state requires manual reconciliation",
    requestedBy: "operator-a"
  };
}

function taskRecord(status: TaskRecord["status"]): TaskRecord {
  return {
    id: TASK_ID,
    inboxMessageId: "message-1",
    correlationId: "correlation-1",
    riskUnitId: "account-1:BTCUSDT",
    commandType: "LIQUIDATE_POSITION",
    status,
    priority: 100,
    decisionSequence: 10n,
    fencingToken: 7n,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    version: 4,
    commandPayload: {},
    createdAt: NOW,
    updatedAt: NOW
  };
}

function outboxMessage(status: OutboxMessage["status"]): OutboxMessage {
  return {
    id: OUTBOX_ID,
    aggregateType: "LIQUIDATION_TASK",
    aggregateId: TASK_ID,
    eventType: "LIQUIDATION_TASK_FAILED",
    payload: { quantity: assertDecimalString("0.1") },
    status,
    attempts: 5,
    nextAttemptAt: NOW,
    lockedBy: undefined,
    lockedUntil: undefined,
    publishedAt: undefined,
    lastError: "broker unavailable"
  };
}

function unexpectedCall(): Promise<never> {
  return Promise.reject(new Error("Unexpected repository method call"));
}

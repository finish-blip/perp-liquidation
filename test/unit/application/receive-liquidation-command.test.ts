import { describe, expect, it, vi } from "vitest";

import { ReceiveLiquidationCommand } from "../../../src/application/receive-liquidation-command.js";
import type { LiquidationCommandPayload } from "../../../src/domain/commands/liquidation-command-parser.js";
import { assertDecimalString } from "../../../src/domain/shared/decimal.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import type {
  CommandIntakeRepositories,
  CommandIntakeUnitOfWork
} from "../../../src/repositories/command-intake-unit-of-work.js";
import type {
  DecisionSequenceClaim,
  DecisionSequenceRepository
} from "../../../src/repositories/decision-sequence-repository.js";
import type { ExecutionStepRepository } from "../../../src/repositories/execution-step-repository.js";
import type {
  InboxReceipt,
  InboxRepository
} from "../../../src/repositories/inbox-repository.js";
import type { OutboxRepository } from "../../../src/repositories/outbox-repository.js";
import type { TaskEventRepository } from "../../../src/repositories/task-event-repository.js";
import type {
  TaskRecord,
  TaskRepository
} from "../../../src/repositories/task-repository.js";

const NOW = assertUtcIsoString("2026-07-18T03:00:00.000Z");
const EXISTING_TASK_ID = assertEntityId("task_existing", "task");

describe("ReceiveLiquidationCommand", () => {
  it("creates the complete initial task chain for an accepted command", async () => {
    const { mocks, unitOfWork } = createHarness();
    const useCase = new ReceiveLiquidationCommand({ unitOfWork });

    const outcome = await useCase.execute({
      source: "risk-engine",
      payload: validPayload(),
      receivedAt: NOW
    });

    expect(outcome.status).toBe("ACCEPTED");
    if (outcome.status !== "ACCEPTED") {
      throw new Error("Expected accepted outcome");
    }
    expect(outcome.task.status).toBe("READY");
    expect(outcome.task.version).toBe(1);
    expect(mocks.executionStepCreate).toHaveBeenCalledOnce();
    expect(mocks.taskEventAppend).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ eventType: "TASK_RECEIVED", eventSequence: 1n })
    );
    expect(mocks.taskEventAppend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ eventType: "TASK_READY", eventSequence: 2n })
    );
    expect(mocks.inboxMarkProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: outcome.task.id })
    );
    expect(mocks.outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "LIQUIDATION_TASK_ACCEPTED" })
    );
  });

  it("returns the existing task without touching sequence or task state for a duplicate", async () => {
    const { mocks, unitOfWork } = createHarness({
      inboxReceipt: {
        status: "DUPLICATE",
        messageId: "message-1",
        existingTaskId: EXISTING_TASK_ID
      }
    });
    const useCase = new ReceiveLiquidationCommand({ unitOfWork });

    const outcome = await useCase.execute({
      source: "risk-engine",
      payload: validPayload(),
      receivedAt: NOW
    });

    expect(outcome).toEqual({
      status: "DUPLICATE",
      messageId: "message-1",
      existingTaskId: EXISTING_TASK_ID
    });
    expect(mocks.decisionSequenceClaim).not.toHaveBeenCalled();
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("records a stale sequence without creating a task", async () => {
    const { mocks, unitOfWork } = createHarness({
      sequenceClaim: {
        status: "STALE_SEQUENCE",
        latestDecisionSequence: 43n,
        existingTaskId: EXISTING_TASK_ID
      }
    });
    const useCase = new ReceiveLiquidationCommand({ unitOfWork });

    const outcome = await useCase.execute({
      source: "risk-engine",
      payload: validPayload(),
      receivedAt: NOW
    });

    expect(outcome).toEqual({
      status: "STALE_SEQUENCE",
      messageId: "message-1",
      existingTaskId: EXISTING_TASK_ID,
      latestDecisionSequence: 43n
    });
    expect(mocks.inboxMarkStale).toHaveBeenCalledOnce();
    expect(mocks.taskCreate).not.toHaveBeenCalled();
  });

  it("cancels an older unstarted task before accepting the newer sequence", async () => {
    const superseded = taskRecord({
      id: EXISTING_TASK_ID,
      status: "READY",
      version: 1,
      decisionSequence: 41n
    });
    const { mocks, unitOfWork } = createHarness({ supersededTasks: [superseded] });
    const useCase = new ReceiveLiquidationCommand({ unitOfWork });

    const outcome = await useCase.execute({
      source: "risk-engine",
      payload: validPayload(),
      receivedAt: NOW
    });

    expect(outcome.status).toBe("ACCEPTED");
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      EXISTING_TASK_ID,
      "CANCELLED",
      expect.objectContaining({ at: NOW })
    );
    expect(mocks.taskEventAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: EXISTING_TASK_ID,
        eventType: "TASK_SUPERSEDED",
        eventSequence: 3n
      })
    );
  });

  it("rejects unsupported and expired commands before touching the Inbox", async () => {
    const { mocks, unitOfWork } = createHarness();
    const useCase = new ReceiveLiquidationCommand({ unitOfWork });

    await expect(
      useCase.execute({
        source: "risk-engine",
        payload: { ...validPayload(), strategy: "ADAPTIVE" },
        receivedAt: NOW
      })
    ).rejects.toThrow(/Only STATIC/);
    await expect(
      useCase.execute({
        source: "risk-engine",
        payload: { ...validPayload(), expires_at: NOW },
        receivedAt: NOW
      })
    ).rejects.toThrow(/expired/);
    expect(mocks.inboxRecord).not.toHaveBeenCalled();
  });
});

type HarnessOptions = {
  readonly inboxReceipt?: InboxReceipt;
  readonly sequenceClaim?: DecisionSequenceClaim;
  readonly supersededTasks?: TaskRecord[];
};

function createHarness(options: HarnessOptions = {}) {
  let createdTask: TaskRecord | undefined;

  const inboxReceipt: InboxReceipt = options.inboxReceipt ?? {
    status: "RECORDED",
    messageId: "message-1"
  };
  const sequenceClaim: DecisionSequenceClaim = options.sequenceClaim ?? {
    status: "ACCEPTED",
    supersededTaskId: undefined
  };

  const inboxRecord = vi.fn<InboxRepository["record"]>(() =>
    Promise.resolve(inboxReceipt)
  );
  const inboxMarkProcessed = vi.fn<InboxRepository["markProcessed"]>(() =>
    Promise.resolve()
  );
  const inboxMarkStale = vi.fn<InboxRepository["markStale"]>(() => Promise.resolve());
  const decisionSequenceClaim = vi.fn<DecisionSequenceRepository["claim"]>(() =>
    Promise.resolve(sequenceClaim)
  );
  const taskCreate = vi.fn<TaskRepository["create"]>((input) => {
    createdTask = taskRecord({
      id: input.id,
      inboxMessageId: input.inboxMessageId,
      correlationId: input.correlationId,
      riskUnitId: input.riskUnitId,
      commandType: input.commandType,
      priority: input.priority,
      decisionSequence: input.decisionSequence,
      commandPayload: input.commandPayload,
      createdAt: input.now,
      updatedAt: input.now
    });
    return Promise.resolve(createdTask);
  });
  const taskFindById = vi.fn<TaskRepository["findById"]>(() => Promise.resolve(undefined));
  const taskFindSupersedable = vi.fn<TaskRepository["findSupersedable"]>(() =>
    Promise.resolve(options.supersededTasks ?? [])
  );
  const taskFindExpiredLeased = vi.fn<TaskRepository["findExpiredLeased"]>(() =>
    Promise.resolve([])
  );
  const taskTransition = vi.fn<TaskRepository["transition"]>((id, status, context) => {
    const current = options.supersededTasks?.find((task) => task.id === id) ?? createdTask;
    if (current === undefined) {
      throw new Error("Task was not created before transition");
    }
    return Promise.resolve({
      ...current,
      status,
      version: current.version + 1,
      updatedAt: context.at,
      ...(context.reason === undefined ? {} : { statusReason: context.reason })
    });
  });
  const taskClaimNext = vi.fn<TaskRepository["claimNext"]>(() =>
    Promise.resolve(undefined)
  );
  const taskAttachFencingToken = vi.fn<TaskRepository["attachFencingToken"]>(() => {
    throw new Error("Not used by command intake tests");
  });
  const taskRenewLease = vi.fn<TaskRepository["renewLease"]>(() => {
    throw new Error("Not used by command intake tests");
  });
  const executionStepCreate = vi.fn<ExecutionStepRepository["create"]>((input) =>
    Promise.resolve({
      ...input,
      id: 1n
    })
  );
  const executionStepFindFirstPending = vi.fn<
    ExecutionStepRepository["findFirstPending"]
  >(() => Promise.resolve(undefined));
  const executionStepMarkPlanned = vi.fn<ExecutionStepRepository["markPlanned"]>(() =>
    Promise.resolve()
  );
  const executionStepMarkWaitingOrder = vi.fn<
    ExecutionStepRepository["markWaitingOrder"]
  >(() => Promise.resolve());
  const executionStepMarkFailed = vi.fn<ExecutionStepRepository["markFailed"]>(() =>
    Promise.resolve()
  );
  const executionStepFindById = vi.fn<ExecutionStepRepository["findById"]>(() =>
    Promise.resolve(undefined)
  );
  const executionStepFindNextPending = vi.fn<
    ExecutionStepRepository["findNextPending"]
  >(() => Promise.resolve(undefined));
  const executionStepMarkCompleted = vi.fn<ExecutionStepRepository["markCompleted"]>(() =>
    Promise.resolve()
  );
  const executionStepSetExpectedVersion = vi.fn<
    ExecutionStepRepository["setExpectedPositionVersion"]
  >(() => Promise.resolve());
  const taskEventAppend = vi.fn<TaskEventRepository["append"]>(() => Promise.resolve());
  const outboxCreate = vi.fn<OutboxRepository["create"]>((input) =>
    Promise.resolve({
      ...input,
      status: "PENDING",
      attempts: 0,
      lockedBy: undefined,
      lockedUntil: undefined,
      publishedAt: undefined,
      lastError: undefined
    })
  );
  const outboxClaimDue = vi.fn<OutboxRepository["claimDue"]>(() => Promise.resolve([]));
  const outboxMarkPublished = vi.fn<OutboxRepository["markPublished"]>(() =>
    Promise.resolve()
  );
  const outboxMarkFailed = vi.fn<OutboxRepository["markFailed"]>(() => Promise.resolve());
  const outboxMarkDead = vi.fn<OutboxRepository["markDead"]>(() => Promise.resolve());

  const repositories: CommandIntakeRepositories = {
    inbox: {
      record: inboxRecord,
      markProcessed: inboxMarkProcessed,
      markStale: inboxMarkStale
    },
    decisionSequences: {
      claim: decisionSequenceClaim
    },
    tasks: {
      create: taskCreate,
      findById: taskFindById,
      findSupersedable: taskFindSupersedable,
      findExpiredLeased: taskFindExpiredLeased,
      transition: taskTransition,
      claimNext: taskClaimNext,
      attachFencingToken: taskAttachFencingToken,
      renewLease: taskRenewLease
    },
    executionSteps: {
      create: executionStepCreate,
      findFirstPending: executionStepFindFirstPending,
      markPlanned: executionStepMarkPlanned,
      markWaitingOrder: executionStepMarkWaitingOrder,
      markFailed: executionStepMarkFailed,
      findById: executionStepFindById,
      findNextPending: executionStepFindNextPending,
      markCompleted: executionStepMarkCompleted,
      requeueAfterPartialSettlement: vi.fn<
        ExecutionStepRepository["requeueAfterPartialSettlement"]
      >(() => Promise.reject(new Error("Not used by command intake tests"))),
      setExpectedPositionVersion: executionStepSetExpectedVersion
    },
    taskEvents: {
      append: taskEventAppend
    },
    outbox: {
      create: outboxCreate,
      findById: vi.fn<OutboxRepository["findById"]>(() => Promise.resolve(undefined)),
      claimDue: outboxClaimDue,
      markPublished: outboxMarkPublished,
      markFailed: outboxMarkFailed,
      markDead: outboxMarkDead,
      replayDead: vi.fn<OutboxRepository["replayDead"]>(() => Promise.resolve())
    }
  };

  return {
    repositories,
    unitOfWork: new FakeUnitOfWork(repositories),
    mocks: {
      decisionSequenceClaim,
      executionStepCreate,
      inboxRecord,
      inboxMarkProcessed,
      inboxMarkStale,
      outboxCreate,
      taskCreate,
      taskEventAppend,
      taskTransition
    }
  };
}

class FakeUnitOfWork implements CommandIntakeUnitOfWork {
  constructor(private readonly repositories: CommandIntakeRepositories) {}

  execute<T>(handler: (repositories: CommandIntakeRepositories) => Promise<T>): Promise<T> {
    return handler(this.repositories);
  }
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: assertEntityId("task_default", "task"),
    inboxMessageId: "message-1",
    correlationId: "correlation-1",
    riskUnitId: "account-1:BTCUSDT",
    commandType: "LIQUIDATE_POSITION",
    status: "RECEIVED",
    priority: 100,
    decisionSequence: 42n,
    fencingToken: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    version: 0,
    commandPayload: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function validPayload(): LiquidationCommandPayload {
  return {
    message_id: "message-1",
    correlation_id: "correlation-1",
    command_type: "LIQUIDATE_POSITION",
    decision_sequence: "42",
    risk_unit_id: "account-1:BTCUSDT",
    account_id: "account-1",
    position_id: "position-1",
    position_version: "12",
    market: "BTCUSDT",
    side: "SELL",
    quantity: assertDecimalString("0.25"),
    quantity_mode: "UP_TO",
    strategy: "STATIC",
    expires_at: "2026-07-18T03:05:00.000Z"
  };
}

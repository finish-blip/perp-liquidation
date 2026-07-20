import { describe, expect, it, vi } from "vitest";

import { DispatchOutbox, type DispatchOutboxOptions } from "../../../src/application/dispatch-outbox.js";
import type { EventPublisher } from "../../../src/application/ports/event-publisher.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import type {
  OutboxMessage,
  OutboxRepository
} from "../../../src/repositories/outbox-repository.js";
import type {
  OutboxRepositories,
  OutboxUnitOfWork
} from "../../../src/repositories/outbox-unit-of-work.js";
import type { TaskEventRepository } from "../../../src/repositories/task-event-repository.js";
import type { TaskRecord, TaskRepository } from "../../../src/repositories/task-repository.js";

const NOW = assertUtcIsoString("2026-07-18T05:00:00.000Z");
const OPTIONS: DispatchOutboxOptions = {
  workerId: "outbox-worker-1",
  batchSize: 50,
  lockMs: 30_000,
  publishTimeoutMs: 1_000,
  maxAttempts: 3,
  baseRetryMs: 1_000,
  maxRetryMs: 60_000
};

describe("DispatchOutbox", () => {
  it("publishes outside transactions and marks success in a separate transaction", async () => {
    const harness = createHarness([outboxMessage(1)]);
    harness.mocks.publish.mockImplementation(() => {
      expect(harness.unitOfWork.active).toBe(false);
      return Promise.resolve();
    });
    const dispatcher = createDispatcher(harness);

    await expect(dispatcher.execute()).resolves.toEqual({
      claimed: 1,
      published: 1,
      deferred: 0,
      dead: 0
    });
    expect(harness.mocks.markPublished).toHaveBeenCalledWith(
      assertEntityId("outbox_1", "outbox"),
      OPTIONS.workerId,
      NOW
    );
    expect(harness.unitOfWork.transactionCount).toBe(2);
  });

  it("uses exponential backoff from the persisted attempt count", async () => {
    const harness = createHarness([outboxMessage(1, { attempts: 2 })]);
    harness.mocks.publish.mockRejectedValue(new Error("broker unavailable"));
    const dispatcher = createDispatcher(harness, { maxAttempts: 5 });

    await expect(dispatcher.execute()).resolves.toEqual({
      claimed: 1,
      published: 0,
      deferred: 1,
      dead: 0
    });
    expect(harness.mocks.markFailed).toHaveBeenCalledWith(
      assertEntityId("outbox_1", "outbox"),
      OPTIONS.workerId,
      assertUtcIsoString("2026-07-18T05:00:04.000Z"),
      "broker unavailable"
    );
  });

  it("marks a message DEAD when the maximum attempt is reached", async () => {
    const harness = createHarness([outboxMessage(1, { attempts: 2 })]);
    harness.mocks.publish.mockRejectedValue(new Error("permanent failure"));
    const dispatcher = createDispatcher(harness);

    await expect(dispatcher.execute()).resolves.toEqual({
      claimed: 1,
      published: 0,
      deferred: 0,
      dead: 1
    });
    expect(harness.mocks.markDead).toHaveBeenCalledWith(
      assertEntityId("outbox_1", "outbox"),
      OPTIONS.workerId,
      "permanent failure"
    );
    expect(harness.mocks.markFailed).not.toHaveBeenCalled();
  });

  it("continues through a batch with mixed publish outcomes", async () => {
    const messages = [
      outboxMessage(1),
      outboxMessage(2, { attempts: 2 }),
      outboxMessage(3, { attempts: 1 })
    ];
    const harness = createHarness(messages);
    harness.mocks.publish.mockImplementation((message) => {
      if (message.id === messages[0]?.id) {
        return Promise.resolve();
      }
      return Promise.reject(new Error(`failed ${message.id}`));
    });
    const dispatcher = createDispatcher(harness);

    await expect(dispatcher.execute()).resolves.toEqual({
      claimed: 3,
      published: 1,
      deferred: 1,
      dead: 1
    });
    expect(harness.mocks.publish).toHaveBeenCalledTimes(3);
    expect(harness.mocks.markPublished).toHaveBeenCalledTimes(1);
    expect(harness.mocks.markFailed).toHaveBeenCalledTimes(1);
    expect(harness.mocks.markDead).toHaveBeenCalledTimes(1);
  });

  it("completes the task atomically after publishing the settled result", async () => {
    const message = outboxMessage(1, { eventType: "LIQUIDATION_EXECUTION_SETTLED" });
    const harness = createHarness([message]);
    const dispatcher = createDispatcher(harness);

    await expect(dispatcher.execute()).resolves.toEqual({
      claimed: 1,
      published: 1,
      deferred: 0,
      dead: 0
    });
    expect(harness.mocks.taskTransition).toHaveBeenCalledWith(
      assertEntityId("task_1", "task"),
      "COMPLETED",
      expect.objectContaining({ at: NOW })
    );
    expect(harness.mocks.taskEventAppend).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "TASK_COMPLETED" })
    );
  });
});

function createDispatcher(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<DispatchOutboxOptions> = {}
): DispatchOutbox {
  return new DispatchOutbox(
    {
      unitOfWork: harness.unitOfWork,
      publisher: { publish: harness.mocks.publish },
      clock: () => new Date(NOW)
    },
    { ...OPTIONS, ...overrides }
  );
}

function createHarness(messages: readonly OutboxMessage[]) {
  const claimDue = vi.fn<OutboxRepository["claimDue"]>(() =>
    Promise.resolve([...messages])
  );
  const markPublished = vi.fn<OutboxRepository["markPublished"]>(() =>
    Promise.resolve()
  );
  const markFailed = vi.fn<OutboxRepository["markFailed"]>(() => Promise.resolve());
  const markDead = vi.fn<OutboxRepository["markDead"]>(() => Promise.resolve());
  const publish = vi.fn<EventPublisher["publish"]>(() => Promise.resolve());
  const task = taskRecord();
  const taskFind = vi.fn<TaskRepository["findById"]>(() => Promise.resolve(task));
  const taskTransition = vi.fn<TaskRepository["transition"]>((_id, status, context) =>
    Promise.resolve({ ...task, status, version: task.version + 1, updatedAt: context.at })
  );
  const taskEventAppend = vi.fn<TaskEventRepository["append"]>(() => Promise.resolve());
  const repository: OutboxRepository = {
    create: unexpectedCall,
    findById: vi.fn<OutboxRepository["findById"]>(() => Promise.resolve(undefined)),
    claimDue,
    markPublished,
    markFailed,
    markDead,
    replayDead: vi.fn<OutboxRepository["replayDead"]>(() => Promise.resolve())
  };
  const tasks: TaskRepository = {
    create: unexpectedCall,
    findById: taskFind,
    findSupersedable: vi.fn(() => Promise.resolve([])),
    findExpiredLeased: vi.fn(() => Promise.resolve([])),
    transition: taskTransition,
    claimNext: vi.fn(() => Promise.resolve(undefined)),
    attachFencingToken: unexpectedCall,
    renewLease: unexpectedCall
  };
  const unitOfWork = new TrackingOutboxUnitOfWork({
    outbox: repository,
    tasks,
    taskEvents: { append: taskEventAppend }
  });
  return {
    unitOfWork,
    mocks: {
      claimDue,
      markPublished,
      markFailed,
      markDead,
      publish,
      taskEventAppend,
      taskTransition
    }
  };
}

class TrackingOutboxUnitOfWork implements OutboxUnitOfWork {
  active = false;
  transactionCount = 0;

  constructor(private readonly repositories: OutboxRepositories) {}

  async execute<T>(handler: (repositories: OutboxRepositories) => Promise<T>): Promise<T> {
    if (this.active) {
      throw new Error("Nested Outbox transaction detected");
    }
    this.active = true;
    this.transactionCount += 1;
    try {
      return await handler(this.repositories);
    } finally {
      this.active = false;
    }
  }
}

function taskRecord(): TaskRecord {
  return {
    id: assertEntityId("task_1", "task"),
    inboxMessageId: "message-1",
    correlationId: "correlation-1",
    riskUnitId: "account-1:BTCUSDT",
    commandType: "LIQUIDATE_POSITION",
    status: "RESULT_PUBLISHING",
    priority: 100,
    decisionSequence: 1n,
    fencingToken: 1n,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    version: 5,
    commandPayload: {},
    createdAt: NOW,
    updatedAt: NOW
  };
}

function outboxMessage(
  sequence: number,
  overrides: Partial<OutboxMessage> = {}
): OutboxMessage {
  return {
    id: assertEntityId(`outbox_${sequence}`, "outbox"),
    aggregateType: "LIQUIDATION_TASK",
    aggregateId: `task_${sequence}`,
    eventType: "LIQUIDATION_TASK_COMPLETED",
    payload: { task_id: `task_${sequence}` },
    status: "PUBLISHING",
    attempts: 0,
    nextAttemptAt: NOW,
    lockedBy: OPTIONS.workerId,
    lockedUntil: assertUtcIsoString("2026-07-18T05:00:30.000Z"),
    publishedAt: undefined,
    lastError: undefined,
    ...overrides
  };
}

function unexpectedCall(): Promise<never> {
  return Promise.reject(new Error("Unexpected repository method call"));
}

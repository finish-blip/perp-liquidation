import { describe, expect, it, vi } from "vitest";

import { HandleOrderEvent } from "../../../src/application/handle-order-event.js";
import { HandleSettlementEvent } from "../../../src/application/handle-settlement-event.js";
import {
  liquidationCommandToPayload,
  parseLiquidationCommand
} from "../../../src/domain/commands/liquidation-command-parser.js";
import { assertDecimalString } from "../../../src/domain/shared/decimal.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import type {
  OrderEventRepository,
  SettlementEventRepository
} from "../../../src/repositories/execution-event-repository.js";
import type { SettlementEvent } from "../../../src/domain/execution/settlement-event.js";
import type {
  ExecutionEventRepositories,
  ExecutionEventUnitOfWork
} from "../../../src/repositories/execution-event-unit-of-work.js";
import type {
  ExecutionStepRecord,
  ExecutionStepRepository
} from "../../../src/repositories/execution-step-repository.js";
import type {
  OrderAttemptRecord,
  OrderAttemptRepository
} from "../../../src/repositories/order-attempt-repository.js";
import type { OutboxRepository } from "../../../src/repositories/outbox-repository.js";
import type { RiskUnitFenceRepository } from "../../../src/repositories/risk-unit-fence-repository.js";
import type { TaskEventRepository } from "../../../src/repositories/task-event-repository.js";
import type { TaskRecord, TaskRepository } from "../../../src/repositories/task-repository.js";

const NOW = assertUtcIsoString("2026-07-18T03:01:00.000Z");
const TASK_ID = assertEntityId("task_events", "task");
const CLIENT_ORDER_ID = assertEntityId("coid_events", "coid");

describe("HandleOrderEvent", () => {
  it("moves FILLED only to WAITING_SETTLEMENT", async () => {
    const harness = createHarness();
    const handler = new HandleOrderEvent(harness.unitOfWork, () => new Date(NOW));

    const outcome = await handler.execute(orderEvent());

    expect(outcome.status).toBe("PROCESSED");
    if (outcome.status !== "PROCESSED") {
      throw new Error("Expected processed order event");
    }
    expect(outcome.task.status).toBe("WAITING_SETTLEMENT");
    expect(outcome.orderAttempt.status).toBe("FILLED");
    expect(harness.transitions).toEqual(["WAITING_SETTLEMENT"]);
    expect(harness.transitions).not.toContain("COMPLETED");
    expect(harness.mocks.orderDisposition).toHaveBeenCalledWith(
      "order-event-1",
      "PROCESSED",
      NOW
    );
  });

  it("does not touch order state for duplicate and out-of-order events", async () => {
    const duplicateHarness = createHarness({ duplicateOrderEvent: true });
    const duplicateHandler = new HandleOrderEvent(
      duplicateHarness.unitOfWork,
      () => new Date(NOW)
    );
    await expect(duplicateHandler.execute(orderEvent())).resolves.toEqual({
      status: "DUPLICATE",
      eventId: "order-event-1"
    });
    expect(duplicateHarness.mocks.attemptApplyEvent).not.toHaveBeenCalled();

    const oldSequenceHarness = createHarness({ lastEventSequence: 5n });
    const oldSequenceHandler = new HandleOrderEvent(
      oldSequenceHarness.unitOfWork,
      () => new Date(NOW)
    );
    await expect(
      oldSequenceHandler.execute(orderEvent({ event_sequence: "4" }))
    ).resolves.toEqual({ status: "OUT_OF_ORDER", eventId: "order-event-1" });
    expect(oldSequenceHarness.mocks.attemptApplyEvent).not.toHaveBeenCalled();
    expect(oldSequenceHarness.mocks.orderDisposition).toHaveBeenCalledWith(
      "order-event-1",
      "OUT_OF_ORDER",
      NOW
    );
  });

  it("waits for settlement after a partially filled cancellation", async () => {
    const harness = createHarness();
    const handler = new HandleOrderEvent(harness.unitOfWork, () => new Date(NOW));

    const outcome = await handler.execute(
      orderEvent({ event_type: "CANCELLED", cumulative_filled_quantity: "0.05" })
    );

    expect(outcome.status).toBe("PROCESSED");
    expect(harness.transitions).toEqual(["WAITING_SETTLEMENT"]);
  });
});

describe("HandleSettlementEvent", () => {
  it("finishes the current step and publishes the result only when no next step exists", async () => {
    const harness = createHarness({
      taskStatus: "WAITING_SETTLEMENT",
      attemptStatus: "FILLED",
      filledQuantity: "0.1"
    });
    const handler = new HandleSettlementEvent(harness.unitOfWork, () => new Date(NOW));

    const outcome = await handler.execute(settlementEvent());

    expect(outcome.status).toBe("RESULT_PUBLISHING");
    expect(harness.transitions).toEqual(["STEP_COMPLETED", "RESULT_PUBLISHING"]);
    expect(harness.mocks.stepMarkCompleted).toHaveBeenCalledWith(1n, NOW);
    const outboxInput = harness.mocks.outboxCreate.mock.calls[0]?.[0];
    expect(outboxInput?.eventType).toBe("LIQUIDATION_EXECUTION_SETTLED");
    expect(outboxInput?.payload).toEqual(
      expect.objectContaining({
        status: "PARTIALLY_COMPLETED",
        requested_size: "0.2",
        executed_size: "0.1",
        remaining_size: "0.1"
      })
    );
  });

  it("writes the new position version into the next step and returns the task to READY", async () => {
    const nextStep = executionStep({
      id: 2n,
      stepSequence: 2,
      status: "PENDING",
      planPayload: { slice_planned: true, expected_position_version: null }
    });
    const harness = createHarness({
      taskStatus: "WAITING_SETTLEMENT",
      attemptStatus: "FILLED",
      filledQuantity: "0.1",
      nextStep
    });
    const handler = new HandleSettlementEvent(harness.unitOfWork, () => new Date(NOW));

    const outcome = await handler.execute(settlementEvent());

    expect(outcome.status).toBe("NEXT_STEP_READY");
    expect(harness.mocks.stepSetExpectedVersion).toHaveBeenCalledWith(2n, 13n, NOW);
    expect(harness.transitions).toEqual(["STEP_COMPLETED", "READY"]);
    expect(harness.mocks.outboxCreate).not.toHaveBeenCalled();
  });

  it("rejects settlement with a mismatched previous position version", async () => {
    const harness = createHarness({
      taskStatus: "WAITING_SETTLEMENT",
      attemptStatus: "FILLED",
      filledQuantity: "0.1"
    });
    const handler = new HandleSettlementEvent(harness.unitOfWork, () => new Date(NOW));

    await expect(
      handler.execute(settlementEvent({ previous_position_version: "11" }))
    ).rejects.toThrow(/previous position version/);
    expect(harness.mocks.stepMarkCompleted).not.toHaveBeenCalled();
  });

  it("requeues the unfilled remainder after a partially filled cancellation settles", async () => {
    const harness = createHarness({
      taskStatus: "WAITING_SETTLEMENT",
      attemptStatus: "CANCELLED",
      requestedQuantity: "0.2",
      filledQuantity: "0.1"
    });
    const handler = new HandleSettlementEvent(harness.unitOfWork, () => new Date(NOW));

    const outcome = await handler.execute(settlementEvent());

    expect(outcome.status).toBe("NEXT_STEP_READY");
    expect(harness.mocks.stepRequeue).toHaveBeenCalledWith({
      id: 1n,
      remainingQuantity: "0.1",
      positionVersion: 13n,
      updatedAt: NOW
    });
    expect(harness.transitions).toEqual(["STEP_COMPLETED", "READY"]);
  });

  it("treats a settlement that arrives before FILLED as retryable", async () => {
    const harness = createHarness({ taskStatus: "WAITING_ORDER_EVENT" });
    const handler = new HandleSettlementEvent(harness.unitOfWork, () => new Date(NOW));

    await expect(handler.execute(settlementEvent())).rejects.toMatchObject({
      code: "CONFLICT",
      retryable: true
    });
  });
});

type HarnessOptions = {
  readonly attemptStatus?: OrderAttemptRecord["status"];
  readonly duplicateOrderEvent?: boolean;
  readonly filledQuantity?: string;
  readonly lastEventSequence?: bigint;
  readonly requestedQuantity?: string;
  readonly nextStep?: ExecutionStepRecord;
  readonly taskStatus?: TaskRecord["status"];
};

function createHarness(options: HarnessOptions = {}) {
  const transitions: string[] = [];
  let task = taskRecord(options.taskStatus ?? "WAITING_ORDER_EVENT");
  let attempt = orderAttempt({
    status: options.attemptStatus ?? "ACCEPTED",
    requestedQuantity: assertDecimalString(options.requestedQuantity ?? "0.1"),
    filledQuantity: assertDecimalString(options.filledQuantity ?? "0"),
    lastEventSequence: options.lastEventSequence
  });
  const currentStep = executionStep();
  const recordedSettlements: SettlementEvent[] = [];

  const orderRecord = vi.fn<OrderEventRepository["record"]>((event) =>
    Promise.resolve({
      status: options.duplicateOrderEvent === true ? "DUPLICATE" : "RECORDED",
      eventId: event.eventId
    })
  );
  const orderDisposition = vi.fn<OrderEventRepository["markDisposition"]>(() =>
    Promise.resolve()
  );
  const settlementRecord = vi.fn<SettlementEventRepository["record"]>((event) => {
    recordedSettlements.push(event);
    return Promise.resolve({ status: "RECORDED", eventId: event.eventId });
  });
  const settlementListForTask = vi.fn<SettlementEventRepository["listForTask"]>(() =>
    Promise.resolve(recordedSettlements)
  );
  const settlementDisposition = vi.fn<SettlementEventRepository["markDisposition"]>(() =>
    Promise.resolve()
  );
  const attemptFind = vi.fn<OrderAttemptRepository["findByClientOrderId"]>(() =>
    Promise.resolve(attempt)
  );
  const attemptApplyEvent = vi.fn<OrderAttemptRepository["applyEvent"]>((input) => {
    attempt = {
      ...attempt,
      status: input.status,
      exchangeOrderId: input.exchangeOrderId,
      filledQuantity: input.filledQuantity,
      lastEventSequence: input.eventSequence
    };
    return Promise.resolve(attempt);
  });
  const taskTransition = vi.fn<TaskRepository["transition"]>((_id, status, context) => {
    transitions.push(status);
    task = {
      ...task,
      status,
      version: task.version + 1,
      updatedAt: context.at,
      ...(context.reason === undefined ? {} : { statusReason: context.reason })
    };
    return Promise.resolve(task);
  });
  const stepMarkCompleted = vi.fn<ExecutionStepRepository["markCompleted"]>(() =>
    Promise.resolve()
  );
  const stepRequeue = vi.fn<ExecutionStepRepository["requeueAfterPartialSettlement"]>(() =>
    Promise.resolve()
  );
  const stepSetExpectedVersion = vi.fn<
    ExecutionStepRepository["setExpectedPositionVersion"]
  >(() => Promise.resolve());
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

  const repositories: ExecutionEventRepositories = {
    orderEvents: { record: orderRecord, markDisposition: orderDisposition },
    settlementEvents: {
      record: settlementRecord,
      listForTask: settlementListForTask,
      markDisposition: settlementDisposition
    },
    orderAttempts: {
      create: unexpectedCall,
      markAccepted: unexpectedCall,
      markUnknown: unexpectedCall,
      markRejected: unexpectedCall,
      findByClientOrderId: attemptFind,
      findLatestForTask: vi.fn<OrderAttemptRepository["findLatestForTask"]>(() =>
        Promise.resolve(attempt)
      ),
      findLatestForStep: vi.fn<OrderAttemptRepository["findLatestForStep"]>(() =>
        Promise.resolve(attempt)
      ),
      applyEvent: attemptApplyEvent
    },
    tasks: {
      create: unexpectedCall,
      findById: vi.fn<TaskRepository["findById"]>(() => Promise.resolve(task)),
      findSupersedable: vi.fn<TaskRepository["findSupersedable"]>(() => Promise.resolve([])),
      findExpiredLeased: vi.fn<TaskRepository["findExpiredLeased"]>(() => Promise.resolve([])),
      transition: taskTransition,
      claimNext: vi.fn<TaskRepository["claimNext"]>(() => Promise.resolve(undefined)),
      attachFencingToken: unexpectedCall,
      renewLease: unexpectedCall
    },
    executionSteps: {
      create: unexpectedCall,
      findFirstPending: vi.fn<ExecutionStepRepository["findFirstPending"]>(() =>
        Promise.resolve(undefined)
      ),
      markPlanned: unexpectedCall,
      markWaitingOrder: unexpectedCall,
      markFailed: unexpectedCall,
      findById: vi.fn<ExecutionStepRepository["findById"]>(() =>
        Promise.resolve(currentStep)
      ),
      findNextPending: vi.fn<ExecutionStepRepository["findNextPending"]>(() =>
        Promise.resolve(options.nextStep)
      ),
      markCompleted: stepMarkCompleted,
      requeueAfterPartialSettlement: stepRequeue,
      setExpectedPositionVersion: stepSetExpectedVersion
    },
    outbox: {
      create: outboxCreate,
      findById: vi.fn<OutboxRepository["findById"]>(() => Promise.resolve(undefined)),
      claimDue: vi.fn<OutboxRepository["claimDue"]>(() => Promise.resolve([])),
      markPublished: vi.fn<OutboxRepository["markPublished"]>(() => Promise.resolve()),
      markFailed: vi.fn<OutboxRepository["markFailed"]>(() => Promise.resolve()),
      markDead: vi.fn<OutboxRepository["markDead"]>(() => Promise.resolve()),
      replayDead: vi.fn<OutboxRepository["replayDead"]>(() => Promise.resolve())
    },
    riskUnitFences: {
      activate: vi.fn<RiskUnitFenceRepository["activate"]>((input) =>
        Promise.resolve(input)
      ),
      assertCurrent: vi.fn<RiskUnitFenceRepository["assertCurrent"]>(() =>
        Promise.resolve()
      ),
      revoke: vi.fn<RiskUnitFenceRepository["revoke"]>(() => Promise.resolve())
    },
    taskEvents: {
      append: vi.fn<TaskEventRepository["append"]>(() => Promise.resolve())
    }
  };

  return {
    transitions,
    unitOfWork: new FakeExecutionEventUnitOfWork(repositories),
    mocks: {
      attemptApplyEvent,
      orderDisposition,
      outboxCreate,
      stepMarkCompleted,
      stepRequeue,
      stepSetExpectedVersion
    }
  };
}

class FakeExecutionEventUnitOfWork implements ExecutionEventUnitOfWork {
  constructor(private readonly repositories: ExecutionEventRepositories) {}

  execute<T>(handler: (repositories: ExecutionEventRepositories) => Promise<T>): Promise<T> {
    return handler(this.repositories);
  }
}

function unexpectedCall(): Promise<never> {
  return Promise.reject(new Error("Unexpected repository method call"));
}

function orderEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "order-event-1",
    correlation_id: "correlation-1",
    client_order_id: CLIENT_ORDER_ID,
    exchange_order_id: "exchange-1",
    event_sequence: "2",
    event_type: "FILLED",
    cumulative_filled_quantity: "0.1",
    occurred_at: NOW,
    ...overrides
  };
}

function settlementEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "settlement-event-1",
    correlation_id: "correlation-1",
    client_order_id: CLIENT_ORDER_ID,
    exchange_order_id: "exchange-1",
    settlement_sequence: "1",
    position_id: "position-1",
    previous_position_version: "12",
    new_position_version: "13",
    settled_quantity: "0.1",
    occurred_at: NOW,
    ...overrides
  };
}

function taskRecord(status: TaskRecord["status"]): TaskRecord {
  const command = parseLiquidationCommand({
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
    quantity: "0.2",
    quantity_mode: "UP_TO",
    strategy: "STATIC",
    expires_at: "2026-07-18T03:05:00.000Z"
  });
  return {
    id: TASK_ID,
    inboxMessageId: command.messageId,
    correlationId: command.correlationId,
    riskUnitId: command.riskUnitId,
    commandType: command.commandType,
    status,
    priority: 100,
    decisionSequence: command.decisionSequence,
    fencingToken: 17n,
    leaseOwner: "worker-1",
    leaseExpiresAt: assertUtcIsoString("2026-07-18T03:02:00.000Z"),
    version: 6,
    commandPayload: { ...liquidationCommandToPayload(command) },
    createdAt: NOW,
    updatedAt: NOW
  };
}

function orderAttempt(overrides: Partial<OrderAttemptRecord> = {}): OrderAttemptRecord {
  return {
    id: 10n,
    taskId: TASK_ID,
    executionStepId: 1n,
    attemptSequence: 1,
    clientOrderId: CLIENT_ORDER_ID,
    exchangeOrderId: "exchange-1",
    status: "ACCEPTED",
    requestedQuantity: assertDecimalString("0.1"),
    requestedPrice: assertDecimalString("99"),
    filledQuantity: assertDecimalString("0"),
    lastEventSequence: undefined,
    requestPayload: {},
    ...overrides
  };
}

function executionStep(overrides: Partial<ExecutionStepRecord> = {}): ExecutionStepRecord {
  return {
    id: 1n,
    taskId: TASK_ID,
    stepSequence: 1,
    strategy: "STATIC",
    quantityMode: "UP_TO",
    requestedQuantity: assertDecimalString("0.1"),
    remainingQuantity: assertDecimalString("0.1"),
    status: "WAITING_ORDER",
    planPayload: { position_version: "12", slice_planned: true },
    createdAt: NOW,
    ...overrides
  };
}

import { describe, expect, it, vi } from "vitest";

import type { HandleOrderEvent } from "../../../src/application/handle-order-event.js";
import type { ClaimedLiquidationTask } from "../../../src/application/claim-liquidation-task.js";
import { ReconcileUnknownOrder } from "../../../src/application/reconcile-unknown-order.js";
import type { OrderGateway } from "../../../src/application/ports/order-gateway.js";
import { assertDecimalString } from "../../../src/domain/shared/decimal.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import type {
  OrderAttemptRecord,
  OrderAttemptRepository
} from "../../../src/repositories/order-attempt-repository.js";
import type { ExecutionStepRepository } from "../../../src/repositories/execution-step-repository.js";
import type { OutboxRepository } from "../../../src/repositories/outbox-repository.js";
import type { RiskUnitFenceRepository } from "../../../src/repositories/risk-unit-fence-repository.js";
import type {
  StaticExecutionRepositories,
  StaticExecutionUnitOfWork
} from "../../../src/repositories/static-execution-unit-of-work.js";
import type { TaskEventRepository } from "../../../src/repositories/task-event-repository.js";
import type { TaskRecord, TaskRepository } from "../../../src/repositories/task-repository.js";

const NOW = assertUtcIsoString("2026-07-18T04:00:00.000Z");
const TASK_ID = assertEntityId("task_recovery", "task");
const CLIENT_ORDER_ID = assertEntityId("coid_recovery", "coid");

describe("ReconcileUnknownOrder", () => {
  it("returns a task with no order attempt to READY", async () => {
    const harness = createHarness(undefined);
    const service = createService(harness);

    const outcome = await service.execute(harness.claim);

    expect(outcome.status).toBe("READY");
    expect(harness.transitions).toEqual(["READY"]);
    expect(harness.mocks.assertFence).toHaveBeenCalledTimes(2);
    expect(harness.mocks.queryOrder).not.toHaveBeenCalled();
  });

  it("defers a NOT_FOUND order without placing another order", async () => {
    const harness = createHarness(orderAttempt({ status: "UNKNOWN" }));
    harness.mocks.queryOrder.mockResolvedValue({ found: false });
    const service = createService(harness);

    const outcome = await service.execute(harness.claim);

    expect(outcome.status).toBe("DEFERRED");
    expect(harness.transitions).toEqual(["NEEDS_RECONCILIATION"]);
    expect(harness.mocks.placeOrder).not.toHaveBeenCalled();
  });

  it("feeds a recovered FILLED state through the normal event handler with fencing", async () => {
    const attempt = orderAttempt({ status: "UNKNOWN", exchangeOrderId: undefined });
    const harness = createHarness(attempt);
    harness.mocks.queryOrder.mockResolvedValue({
      found: true,
      exchangeOrderId: "exchange-recovered",
      eventSequence: 7n,
      eventType: "FILLED",
      cumulativeFilledQuantity: attempt.requestedQuantity,
      occurredAt: NOW
    });
    const service = createService(harness);

    const outcome = await service.execute(harness.claim);

    expect(outcome.status).toBe("ORDER_STATE_RECOVERED");
    expect(harness.mocks.handleOrderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        client_order_id: CLIENT_ORDER_ID,
        event_sequence: "7",
        event_type: "FILLED"
      }),
      harness.claim.riskUnitLease
    );
    expect(harness.mocks.placeOrder).not.toHaveBeenCalled();
  });

  it("defers a failed order query and never re-places", async () => {
    const harness = createHarness(orderAttempt({ status: "UNKNOWN" }));
    harness.mocks.queryOrder.mockRejectedValue(new Error("gateway unavailable"));
    const service = createService(harness);

    const outcome = await service.execute(harness.claim);

    expect(outcome).toEqual(
      expect.objectContaining({ status: "DEFERRED", reason: "gateway unavailable" })
    );
    expect(harness.transitions).toEqual(["NEEDS_RECONCILIATION"]);
    expect(harness.mocks.placeOrder).not.toHaveBeenCalled();
  });

  it("restores an already FILLED attempt to WAITING_SETTLEMENT without querying", async () => {
    const harness = createHarness(
      orderAttempt({ status: "FILLED", filledQuantity: assertDecimalString("0.1") })
    );
    const service = createService(harness);

    const outcome = await service.execute(harness.claim);

    expect(outcome.status).toBe("SETTLEMENT_PENDING");
    if (outcome.status !== "SETTLEMENT_PENDING") {
      throw new Error("Expected settlement-pending recovery");
    }
    expect(outcome.task.status).toBe("WAITING_SETTLEMENT");
    expect(harness.transitions).toEqual(["WAITING_SETTLEMENT"]);
    expect(harness.mocks.queryOrder).not.toHaveBeenCalled();
  });

  it("fails an already REJECTED attempt atomically without querying", async () => {
    const harness = createHarness(orderAttempt({ status: "REJECTED" }));
    const service = createService(harness);

    const outcome = await service.execute(harness.claim);

    expect(outcome.status).toBe("FAILED");
    expect(harness.transitions).toEqual(["FAILED"]);
    expect(harness.mocks.stepMarkFailed).toHaveBeenCalledWith(
      1n,
      "recovered rejected order attempt",
      NOW
    );
    expect(harness.mocks.outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "LIQUIDATION_TASK_FAILED" })
    );
    expect(harness.mocks.queryOrder).not.toHaveBeenCalled();
  });

  it("moves a partially filled CANCELLED attempt to settlement", async () => {
    const harness = createHarness(
      orderAttempt({
        status: "CANCELLED",
        requestedQuantity: assertDecimalString("0.2"),
        filledQuantity: assertDecimalString("0.1")
      })
    );
    const service = createService(harness);

    const outcome = await service.execute(harness.claim);

    expect(outcome.status).toBe("SETTLEMENT_PENDING");
    expect(harness.transitions).toEqual(["WAITING_SETTLEMENT"]);
    expect(harness.mocks.stepMarkFailed).not.toHaveBeenCalled();
    expect(harness.mocks.queryOrder).not.toHaveBeenCalled();
  });
});

function createService(harness: ReturnType<typeof createHarness>): ReconcileUnknownOrder {
  return new ReconcileUnknownOrder(
    {
      unitOfWork: harness.unitOfWork,
      orderGateway: {
        placeReduceOnly: harness.mocks.placeOrder,
        getByClientOrderId: harness.mocks.queryOrder
      },
      orderEventHandler: { execute: harness.mocks.handleOrderEvent },
      clock: () => new Date(NOW)
    },
    1_000
  );
}

function createHarness(initialAttempt: OrderAttemptRecord | undefined) {
  const transitions: string[] = [];
  let task = taskRecord("CLAIMED");
  const claim: ClaimedLiquidationTask = {
    task,
    riskUnitLease: {
      riskUnitId: task.riskUnitId,
      owner: "recovery-worker/task_recovery",
      fencingToken: 23n
    }
  };
  const queryOrder = vi.fn<OrderGateway["getByClientOrderId"]>(() =>
    Promise.resolve({ found: false })
  );
  const placeOrder = vi.fn<OrderGateway["placeReduceOnly"]>(() =>
    Promise.reject(new Error("Recovery must never place an order"))
  );
  const handleOrderEvent = vi.fn<HandleOrderEvent["execute"]>(() =>
    Promise.resolve({
      status: "PROCESSED",
      eventId: "recovery-event",
      task: { ...task, status: "WAITING_SETTLEMENT" },
      orderAttempt: orderAttempt({
        status: "FILLED",
        filledQuantity: assertDecimalString("0.1")
      })
    })
  );
  const assertFence = vi.fn<RiskUnitFenceRepository["assertCurrent"]>(() =>
    Promise.resolve()
  );
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
  const stepMarkFailed = vi.fn<ExecutionStepRepository["markFailed"]>(() =>
    Promise.resolve()
  );
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

  const repositories: StaticExecutionRepositories = {
    executionSteps: {
      create: unexpectedCall,
      findFirstPending: vi.fn<ExecutionStepRepository["findFirstPending"]>(() =>
        Promise.resolve(undefined)
      ),
      markPlanned: unexpectedCall,
      markWaitingOrder: unexpectedCall,
      markFailed: stepMarkFailed,
      findById: vi.fn<ExecutionStepRepository["findById"]>(() =>
        Promise.resolve(undefined)
      ),
      findNextPending: vi.fn<ExecutionStepRepository["findNextPending"]>(() =>
        Promise.resolve(undefined)
      ),
      markCompleted: unexpectedCall,
      requeueAfterPartialSettlement: unexpectedCall,
      setExpectedPositionVersion: unexpectedCall
    },
    orderAttempts: {
      create: unexpectedCall,
      markAccepted: unexpectedCall,
      markUnknown: unexpectedCall,
      markRejected: unexpectedCall,
      findByClientOrderId: vi.fn<OrderAttemptRepository["findByClientOrderId"]>(() =>
        Promise.resolve(initialAttempt)
      ),
      findLatestForTask: vi.fn<OrderAttemptRepository["findLatestForTask"]>(() =>
        Promise.resolve(initialAttempt)
      ),
      findLatestForStep: vi.fn<OrderAttemptRepository["findLatestForStep"]>(() =>
        Promise.resolve(initialAttempt)
      ),
      applyEvent: unexpectedCall
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
      assertCurrent: assertFence,
      revoke: vi.fn<RiskUnitFenceRepository["revoke"]>(() => Promise.resolve())
    },
    taskEvents: {
      append: vi.fn<TaskEventRepository["append"]>(() => Promise.resolve())
    },
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
    claim,
    transitions,
    unitOfWork: new FakeStaticExecutionUnitOfWork(repositories),
    mocks: {
      assertFence,
      handleOrderEvent,
      outboxCreate,
      placeOrder,
      queryOrder,
      stepMarkFailed
    }
  };
}

class FakeStaticExecutionUnitOfWork implements StaticExecutionUnitOfWork {
  constructor(private readonly repositories: StaticExecutionRepositories) {}

  execute<T>(handler: (repositories: StaticExecutionRepositories) => Promise<T>): Promise<T> {
    return handler(this.repositories);
  }
}

function taskRecord(status: TaskRecord["status"]): TaskRecord {
  return {
    id: TASK_ID,
    inboxMessageId: "message-recovery",
    correlationId: "correlation-recovery",
    riskUnitId: "account-1:BTCUSDT",
    commandType: "LIQUIDATE_POSITION",
    status,
    priority: 100,
    decisionSequence: 42n,
    fencingToken: 23n,
    leaseOwner: "recovery-worker",
    leaseExpiresAt: assertUtcIsoString("2026-07-18T04:01:00.000Z"),
    version: 4,
    commandPayload: {
      message_id: "message-recovery",
      correlation_id: "correlation-recovery",
      command_type: "LIQUIDATE_POSITION",
      decision_sequence: "42",
      risk_unit_id: "account-1:BTCUSDT",
      account_id: "account-1",
      position_id: "position-1",
      position_version: "12",
      market: "BTCUSDT",
      side: "SELL",
      quantity: "0.1",
      quantity_mode: "UP_TO",
      strategy: "STATIC",
      expires_at: "2026-07-18T04:05:00.000Z"
    },
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
    status: "UNKNOWN",
    requestedQuantity: assertDecimalString("0.1"),
    requestedPrice: assertDecimalString("99"),
    filledQuantity: assertDecimalString("0"),
    lastEventSequence: undefined,
    requestPayload: {},
    ...overrides
  };
}

function unexpectedCall(): Promise<never> {
  return Promise.reject(new Error("Unexpected repository method call"));
}

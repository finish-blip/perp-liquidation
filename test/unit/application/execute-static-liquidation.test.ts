import { describe, expect, it, vi } from "vitest";

import type { MarketDataClient } from "../../../src/application/ports/market-data-client.js";
import type { OrderGateway } from "../../../src/application/ports/order-gateway.js";
import type { PortfolioClient } from "../../../src/application/ports/portfolio-client.js";
import { ExecuteStaticLiquidation } from "../../../src/application/execute-static-liquidation.js";
import type { ClaimedLiquidationTask } from "../../../src/application/claim-liquidation-task.js";
import {
  liquidationCommandToPayload,
  parseLiquidationCommand
} from "../../../src/domain/commands/liquidation-command-parser.js";
import { parseMarketSnapshot } from "../../../src/domain/execution/market-snapshot.js";
import type { PlaceOrderResult } from "../../../src/domain/execution/order.js";
import { parsePositionSnapshot } from "../../../src/domain/portfolio/position-snapshot.js";
import { assertDecimalString } from "../../../src/domain/shared/decimal.js";
import { ExternalTimeoutError } from "../../../src/domain/shared/errors.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import type { ExecutionStepRepository } from "../../../src/repositories/execution-step-repository.js";
import type { OrderAttemptRepository } from "../../../src/repositories/order-attempt-repository.js";
import type { OutboxRepository } from "../../../src/repositories/outbox-repository.js";
import type { RiskUnitFenceRepository } from "../../../src/repositories/risk-unit-fence-repository.js";
import type {
  StaticExecutionRepositories,
  StaticExecutionUnitOfWork
} from "../../../src/repositories/static-execution-unit-of-work.js";
import type { TaskEventRepository } from "../../../src/repositories/task-event-repository.js";
import type { TaskRecord, TaskRepository } from "../../../src/repositories/task-repository.js";

const NOW = assertUtcIsoString("2026-07-18T03:00:00.000Z");
const TASK_ID = assertEntityId("task_static", "task");

describe("ExecuteStaticLiquidation", () => {
  it("persists one deterministic reduce-only order and waits for order events", async () => {
    const harness = createHarness();
    const outcome = await createUseCase(harness).execute(harness.claim);

    expect(outcome.status).toBe("WAITING_ORDER_EVENT");
    expect(harness.mocks.orderPlace).toHaveBeenCalledOnce();
    const placed = harness.mocks.orderPlace.mock.calls[0]?.[0];
    expect(placed?.order.reduceOnly).toBe(true);
    expect(placed?.order.quantity).toBe("0.25");
    expect(placed?.order.limitPrice).toBe("99");
    expect(placed?.order.fencingToken).toBe(17n);
    expect(harness.mocks.attemptMarkAccepted).toHaveBeenCalledOnce();
    expect(harness.mocks.stepMarkWaitingOrder).toHaveBeenCalledOnce();
    expect(harness.transitions).toEqual([
      "VALIDATING",
      "PLANNING",
      "ORDER_SUBMITTING",
      "WAITING_ORDER_EVENT"
    ]);
    expect(harness.transitions).not.toContain("COMPLETED");
  });

  it("persists remaining STATIC slices as sequential pending steps", async () => {
    const harness = createHarness();
    const outcome = await createUseCase(harness, {
      maxOrderQuantity: "0.1"
    }).execute(harness.claim);

    expect(outcome.status).toBe("WAITING_ORDER_EVENT");
    expect(harness.mocks.stepCreate).toHaveBeenCalledTimes(2);
    expect(harness.mocks.stepCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ stepSequence: 2, requestedQuantity: "0.1" })
    );
    expect(harness.mocks.stepCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ stepSequence: 3, requestedQuantity: "0.05" })
    );
    const placed = harness.mocks.orderPlace.mock.calls[0]?.[0];
    expect(placed?.order.quantity).toBe("0.1");
  });

  it("increments the attempt sequence when a partially settled step is retried", async () => {
    const harness = createHarness({ latestAttemptSequence: 1 });

    await createUseCase(harness).execute(harness.claim);

    expect(harness.mocks.attemptCreate).toHaveBeenCalledWith(
      expect.objectContaining({ attemptSequence: 2 })
    );
  });

  it("records UNKNOWN and reconciles after an order timeout without retrying", async () => {
    const harness = createHarness({
      orderError: new ExternalTimeoutError("order timed out")
    });
    const outcome = await createUseCase(harness).execute(harness.claim);

    expect(outcome.status).toBe("NEEDS_RECONCILIATION");
    expect(harness.mocks.orderPlace).toHaveBeenCalledOnce();
    expect(harness.mocks.attemptMarkUnknown).toHaveBeenCalledWith(
      10n,
      "order timed out",
      NOW
    );
    expect(harness.transitions.at(-1)).toBe("NEEDS_RECONCILIATION");
    expect(harness.mocks.attemptMarkAccepted).not.toHaveBeenCalled();
  });

  it("records a known gateway rejection as a failed task and Outbox result", async () => {
    const harness = createHarness({
      orderResult: { accepted: false, reason: "reduce quantity no longer available" }
    });
    const outcome = await createUseCase(harness).execute(harness.claim);

    expect(outcome.status).toBe("FAILED");
    expect(harness.mocks.attemptMarkRejected).toHaveBeenCalledOnce();
    expect(harness.mocks.outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "LIQUIDATION_TASK_FAILED" })
    );
  });

  it("fails before order creation when the position version changed", async () => {
    const harness = createHarness({ positionVersion: "13" });
    const outcome = await createUseCase(harness).execute(harness.claim);

    expect(outcome.status).toBe("FAILED");
    expect(harness.mocks.orderPlace).not.toHaveBeenCalled();
    expect(harness.mocks.attemptCreate).not.toHaveBeenCalled();
    expect(harness.mocks.outboxCreate).toHaveBeenCalledOnce();
  });
});

type HarnessOptions = {
  readonly latestAttemptSequence?: number;
  readonly orderError?: Error;
  readonly orderResult?: PlaceOrderResult;
  readonly positionVersion?: string;
};

function createHarness(options: HarnessOptions = {}) {
  const transitions: string[] = [];
  let currentTask = claimedTaskRecord();
  const step = {
    id: 1n,
    taskId: TASK_ID,
    stepSequence: 1,
    strategy: "STATIC" as const,
    quantityMode: "UP_TO" as const,
    requestedQuantity: assertDecimalString("0.25"),
    remainingQuantity: assertDecimalString("0.25"),
    status: "PENDING" as const,
    planPayload: { position_version: "12" },
    createdAt: NOW
  };

  const taskTransition = vi.fn<TaskRepository["transition"]>((_id, status, context) => {
    transitions.push(status);
    currentTask = {
      ...currentTask,
      status,
      version: currentTask.version + 1,
      updatedAt: context.at,
      ...(context.reason === undefined ? {} : { statusReason: context.reason })
    };
    return Promise.resolve(currentTask);
  });
  const stepFind = vi.fn<ExecutionStepRepository["findFirstPending"]>(() =>
    Promise.resolve(step)
  );
  const stepMarkPlanned = vi.fn<ExecutionStepRepository["markPlanned"]>(() =>
    Promise.resolve()
  );
  const stepMarkWaitingOrder = vi.fn<ExecutionStepRepository["markWaitingOrder"]>(() =>
    Promise.resolve()
  );
  const stepMarkFailed = vi.fn<ExecutionStepRepository["markFailed"]>(() =>
    Promise.resolve()
  );
  const stepCreate = vi.fn<ExecutionStepRepository["create"]>((input) =>
    Promise.resolve({ ...input, id: BigInt(100 + input.stepSequence) })
  );
  const attemptCreate = vi.fn<OrderAttemptRepository["create"]>((input) =>
    Promise.resolve({
      id: 10n,
      taskId: input.taskId,
      executionStepId: input.executionStepId,
      attemptSequence: input.attemptSequence,
      clientOrderId: input.clientOrderId,
      exchangeOrderId: undefined,
      status: "CREATED",
      requestedQuantity: input.requestedQuantity,
      requestedPrice: input.requestedPrice,
      filledQuantity: assertDecimalString("0"),
      lastEventSequence: undefined,
      requestPayload: input.requestPayload
    })
  );
  const attemptMarkAccepted = vi.fn<OrderAttemptRepository["markAccepted"]>(() =>
    Promise.resolve()
  );
  const attemptMarkUnknown = vi.fn<OrderAttemptRepository["markUnknown"]>(() =>
    Promise.resolve()
  );
  const attemptMarkRejected = vi.fn<OrderAttemptRepository["markRejected"]>(() =>
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
  const taskEventAppend = vi.fn<TaskEventRepository["append"]>(() => Promise.resolve());
  const fenceAssert = vi.fn<RiskUnitFenceRepository["assertCurrent"]>(() =>
    Promise.resolve()
  );

  const repositories: StaticExecutionRepositories = {
    tasks: {
      create: vi.fn<TaskRepository["create"]>(() => {
        throw new Error("Not used by STATIC execution tests");
      }),
      findById: vi.fn<TaskRepository["findById"]>(() => Promise.resolve(currentTask)),
      findSupersedable: vi.fn<TaskRepository["findSupersedable"]>(() => Promise.resolve([])),
      findExpiredLeased: vi.fn<TaskRepository["findExpiredLeased"]>(() => Promise.resolve([])),
      transition: taskTransition,
      claimNext: vi.fn<TaskRepository["claimNext"]>(() => Promise.resolve(undefined)),
      attachFencingToken: vi.fn<TaskRepository["attachFencingToken"]>(() => {
        throw new Error("Not used by STATIC execution tests");
      }),
      renewLease: vi.fn<TaskRepository["renewLease"]>(() => {
        throw new Error("Not used by STATIC execution tests");
      })
    },
    executionSteps: {
      create: stepCreate,
      findFirstPending: stepFind,
      markPlanned: stepMarkPlanned,
      markWaitingOrder: stepMarkWaitingOrder,
      markFailed: stepMarkFailed,
      findById: vi.fn<ExecutionStepRepository["findById"]>(() => Promise.resolve(step)),
      findNextPending: vi.fn<ExecutionStepRepository["findNextPending"]>(() =>
        Promise.resolve(undefined)
      ),
      markCompleted: vi.fn<ExecutionStepRepository["markCompleted"]>(() =>
        Promise.resolve()
      ),
      requeueAfterPartialSettlement: vi.fn<
        ExecutionStepRepository["requeueAfterPartialSettlement"]
      >(() => Promise.reject(new Error("Not used by STATIC submission tests"))),
      setExpectedPositionVersion: vi.fn<
        ExecutionStepRepository["setExpectedPositionVersion"]
      >(() => Promise.resolve())
    },
    orderAttempts: {
      create: attemptCreate,
      markAccepted: attemptMarkAccepted,
      markUnknown: attemptMarkUnknown,
      markRejected: attemptMarkRejected,
      findByClientOrderId: vi.fn<OrderAttemptRepository["findByClientOrderId"]>(() =>
        Promise.resolve(undefined)
      ),
      findLatestForTask: vi.fn<OrderAttemptRepository["findLatestForTask"]>(() =>
        Promise.resolve(undefined)
      ),
      findLatestForStep: vi.fn<OrderAttemptRepository["findLatestForStep"]>(() =>
        Promise.resolve(
          options.latestAttemptSequence === undefined
            ? undefined
            : {
                id: 9n,
                taskId: TASK_ID,
                executionStepId: 1n,
                attemptSequence: options.latestAttemptSequence,
                clientOrderId: assertEntityId("coid_previous", "coid"),
                exchangeOrderId: "exchange-previous",
                status: "CANCELLED",
                requestedQuantity: assertDecimalString("0.25"),
                requestedPrice: assertDecimalString("99"),
                filledQuantity: assertDecimalString("0.1"),
                lastEventSequence: 3n,
                requestPayload: {}
              }
        )
      ),
      applyEvent: vi.fn<OrderAttemptRepository["applyEvent"]>(() => {
        throw new Error("Not used by STATIC submission tests");
      })
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
      activate: vi.fn<RiskUnitFenceRepository["activate"]>((input) => Promise.resolve(input)),
      assertCurrent: fenceAssert,
      revoke: vi.fn<RiskUnitFenceRepository["revoke"]>(() => Promise.resolve())
    },
    taskEvents: {
      append: taskEventAppend
    }
  };

  const portfolioGet = vi.fn<PortfolioClient["getPosition"]>(() =>
    Promise.resolve(
      parsePositionSnapshot({
        position_id: "position-1",
        account_id: "account-1",
        risk_unit_id: "account-1:BTCUSDT",
        market: "BTCUSDT",
        side: "LONG",
        version: options.positionVersion ?? "12",
        quantity: "1",
        reducible_quantity: "0.25",
        bankruptcy_price: "80"
      })
    )
  );
  const marketGet = vi.fn<MarketDataClient["getSnapshot"]>(() =>
    Promise.resolve(
      parseMarketSnapshot({
        market: "BTCUSDT",
        best_bid: "100",
        best_ask: "100.2",
        mark_price: "100",
        tick_size: "0.1",
        step_size: "0.01",
        observed_at: "2026-07-18T02:59:59.500Z"
      })
    )
  );
  const orderPlace = vi.fn<OrderGateway["placeReduceOnly"]>(() => {
    if (options.orderError !== undefined) {
      return Promise.reject(options.orderError);
    }
    return Promise.resolve(
      options.orderResult ?? { accepted: true, exchangeOrderId: "exchange-1" }
    );
  });
  const orderLookup = vi.fn<OrderGateway["getByClientOrderId"]>(() =>
    Promise.resolve({ found: false })
  );

  return {
    claim: claimedTask(),
    transitions,
    unitOfWork: new FakeStaticExecutionUnitOfWork(repositories),
    portfolioClient: { getPosition: portfolioGet } satisfies PortfolioClient,
    marketDataClient: { getSnapshot: marketGet } satisfies MarketDataClient,
    orderGateway: {
      placeReduceOnly: orderPlace,
      getByClientOrderId: orderLookup
    } satisfies OrderGateway,
    mocks: {
      attemptCreate,
      attemptMarkAccepted,
      attemptMarkRejected,
      attemptMarkUnknown,
      orderPlace,
      outboxCreate,
      stepCreate,
      stepMarkWaitingOrder
    }
  };
}

function createUseCase(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<ConstructorParameters<typeof ExecuteStaticLiquidation>[1]> = {}
): ExecuteStaticLiquidation {
  return new ExecuteStaticLiquidation(
    {
      unitOfWork: harness.unitOfWork,
      portfolioClient: harness.portfolioClient,
      marketDataClient: harness.marketDataClient,
      orderGateway: harness.orderGateway,
      clock: () => new Date(NOW)
    },
    {
      maxMarketAgeMs: 2000,
      maxFutureSkewMs: 100,
      maxPriceDeviationBps: 500,
      maxSlippageBps: 100,
      maxOrderQuantity: "1",
      maxSteps: 32,
      snapshotTimeoutMs: 1000,
      orderTimeoutMs: 1000,
      ...overrides
    }
  );
}

class FakeStaticExecutionUnitOfWork implements StaticExecutionUnitOfWork {
  constructor(private readonly repositories: StaticExecutionRepositories) {}

  execute<T>(handler: (repositories: StaticExecutionRepositories) => Promise<T>): Promise<T> {
    return handler(this.repositories);
  }
}

function claimedTask(): ClaimedLiquidationTask {
  return {
    task: claimedTaskRecord(),
    riskUnitLease: {
      riskUnitId: "account-1:BTCUSDT",
      owner: `worker-1/${TASK_ID}`,
      fencingToken: 17n
    }
  };
}

function claimedTaskRecord(): TaskRecord {
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
    quantity: "0.25",
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
    status: "CLAIMED",
    priority: 100,
    decisionSequence: command.decisionSequence,
    fencingToken: 17n,
    leaseOwner: "worker-1",
    leaseExpiresAt: assertUtcIsoString("2026-07-18T03:00:30.000Z"),
    version: 2,
    commandPayload: { ...liquidationCommandToPayload(command) },
    createdAt: NOW,
    updatedAt: NOW
  };
}

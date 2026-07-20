import { parseLiquidationCommand } from "../domain/commands/liquidation-command-parser.js";
import type { LiquidationCommand } from "../domain/commands/liquidation-command.js";
import {
  buildStaticExecutionPlan,
  type StaticExecutionPlan,
  type StaticPlanOptions
} from "../domain/execution/static-plan.js";
import type { PlaceReduceOnlyOrderRequest } from "../domain/execution/order.js";
import {
  AppError,
  InvariantViolationError,
  ValidationError
} from "../domain/shared/errors.js";
import {
  deterministicClientOrderId,
  deterministicEntityId
} from "../domain/shared/id.js";
import { nowUtcIso, type UtcIsoString } from "../domain/shared/time.js";
import type { OrderAttemptRecord } from "../repositories/order-attempt-repository.js";
import type { ExecutionStepRecord } from "../repositories/execution-step-repository.js";
import type { StaticExecutionRepositories, StaticExecutionUnitOfWork } from "../repositories/static-execution-unit-of-work.js";
import type { TaskRecord } from "../repositories/task-repository.js";
import type { ClaimedLiquidationTask } from "./claim-liquidation-task.js";
import type { MarketDataClient } from "./ports/market-data-client.js";
import type { OrderGateway } from "./ports/order-gateway.js";
import type { PortfolioClient } from "./ports/portfolio-client.js";
import { buildLiquidationResultOutboxPayload } from "./liquidation-result-payload.js";

export type ExecuteStaticLiquidationDependencies = {
  readonly unitOfWork: StaticExecutionUnitOfWork;
  readonly portfolioClient: PortfolioClient;
  readonly marketDataClient: MarketDataClient;
  readonly orderGateway: OrderGateway;
  readonly clock?: () => Date;
};

export type ExecuteStaticLiquidationOptions = StaticPlanOptions & {
  readonly snapshotTimeoutMs: number;
  readonly orderTimeoutMs: number;
};

export type ExecuteStaticLiquidationOutcome =
  | {
      readonly status: "WAITING_ORDER_EVENT";
      readonly task: TaskRecord;
      readonly orderAttempt: OrderAttemptRecord;
    }
  | {
      readonly status: "NEEDS_RECONCILIATION" | "FAILED";
      readonly task: TaskRecord;
      readonly reason: string;
    };

export class ExecuteStaticLiquidation {
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: ExecuteStaticLiquidationDependencies,
    private readonly options: ExecuteStaticLiquidationOptions
  ) {
    validateTimeout(options.snapshotTimeoutMs, "snapshotTimeoutMs");
    validateTimeout(options.orderTimeoutMs, "orderTimeoutMs");
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async execute(
    claim: ClaimedLiquidationTask,
    executionSignal?: AbortSignal
  ): Promise<ExecuteStaticLiquidationOutcome> {
    const command = parseLiquidationCommand(claim.task.commandPayload);
    const validationContext = await this.enterValidating(claim);
    const validating = validationContext.task;
    const effectiveCommand = commandForStep(command, validationContext.step);

    let plan: StaticExecutionPlan;
    try {
      const signal = timeoutSignal(this.options.snapshotTimeoutMs, executionSignal);
      const [position, market] = await Promise.all([
        this.dependencies.portfolioClient.getPosition({
          positionId: effectiveCommand.positionId,
          correlationId: effectiveCommand.correlationId,
          signal
        }),
        this.dependencies.marketDataClient.getSnapshot({
          market: effectiveCommand.market,
          correlationId: effectiveCommand.correlationId,
          signal
        })
      ]);
      plan = buildStaticExecutionPlan({
        command: effectiveCommand,
        position,
        market,
        now: nowUtcIso(this.clock),
        options: this.options
      });
    } catch (error) {
      return this.handlePreOrderFailure(validating, claim, error);
    }

    const submission = await this.prepareSubmission(
      validating,
      validationContext.step,
      claim,
      effectiveCommand,
      plan
    );
    let result: Awaited<ReturnType<OrderGateway["placeReduceOnly"]>>;
    try {
      result = await this.dependencies.orderGateway.placeReduceOnly({
        order: submission.order,
        signal: timeoutSignal(this.options.orderTimeoutMs, executionSignal)
      });
    } catch (error) {
      return this.recordUnknownSubmission(
        submission,
        claim,
        errorMessage(error),
        nowUtcIso(this.clock)
      );
    }

    const completedAt = nowUtcIso(this.clock);
    if (!result.accepted) {
      return this.recordKnownRejection(
        submission,
        claim,
        result.reason,
        completedAt
      );
    }

    return this.recordAcceptedOrder(
      submission,
      claim,
      result.exchangeOrderId,
      completedAt
    );
  }

  private async enterValidating(claim: ClaimedLiquidationTask): Promise<{
    readonly task: TaskRecord;
    readonly step: ExecutionStepRecord;
  }> {
    const now = nowUtcIso(this.clock);
    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, now);
      const step = await repositories.executionSteps.findFirstPending(claim.task.id);
      if (step === undefined) {
        throw new InvariantViolationError("STATIC task has no pending execution step", {
          taskId: claim.task.id
        });
      }
      const task = await repositories.tasks.transition(claim.task.id, "VALIDATING", {
        at: now,
        reason: "fencing token verified"
      });
      await appendStateEvent(repositories, task, "TASK_VALIDATING", now);
      return { task, step };
    });
  }

  private async prepareSubmission(
    validating: TaskRecord,
    selectedStep: ExecutionStepRecord,
    claim: ClaimedLiquidationTask,
    command: ReturnType<typeof parseLiquidationCommand>,
    plan: StaticExecutionPlan
  ): Promise<{
    readonly task: TaskRecord;
    readonly orderAttempt: OrderAttemptRecord;
    readonly executionStepId: bigint;
    readonly order: PlaceReduceOnlyOrderRequest;
  }> {
    const now = nowUtcIso(this.clock);
    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, now);
      const step = await repositories.executionSteps.findById(selectedStep.id);
      if (step === undefined) {
        throw new InvariantViolationError("STATIC execution step disappeared before planning", {
          taskId: validating.id
        });
      }

      const isSliced = step.planPayload.slice_planned === true;
      const firstQuantity = plan.quantity;

      await repositories.executionSteps.markPlanned({
        id: step.id,
        requestedQuantity: firstQuantity,
        planPayload: {
          ...step.planPayload,
          slice_planned: true,
          limit_price: plan.limitPrice,
          position_version: plan.positionVersion.toString(),
          market_observed_at: plan.marketObservedAt,
          reduce_only: true
        },
        updatedAt: now
      });

      if (!isSliced) {
        for (const [index, quantity] of plan.stepQuantities.slice(1).entries()) {
          await repositories.executionSteps.create({
            taskId: validating.id,
            stepSequence: step.stepSequence + index + 1,
            strategy: "STATIC",
            quantityMode: command.quantityMode,
            requestedQuantity: quantity,
            remainingQuantity: quantity,
            status: "PENDING",
            planPayload: {
              ...step.planPayload,
              slice_planned: true,
              expected_position_version: null
            },
            createdAt: now
          });
        }
      }

      const planning = await repositories.tasks.transition(validating.id, "PLANNING", {
        at: now,
        reason: "STATIC quantity and protected price calculated"
      });
      await appendStateEvent(repositories, planning, "TASK_PLANNED", now);
      const submitting = await repositories.tasks.transition(
        validating.id,
        "ORDER_SUBMITTING",
        {
          at: now,
          reason: "order attempt persisted before submission"
        }
      );
      await appendStateEvent(repositories, submitting, "ORDER_SUBMITTING", now);

      const latestAttempt = await repositories.orderAttempts.findLatestForStep(step.id);
      const attemptSequence = (latestAttempt?.attemptSequence ?? 0) + 1;
      const clientOrderId = deterministicClientOrderId({
        taskId: validating.id,
        stepSequence: step.stepSequence,
        attemptSequence
      });
      const order: PlaceReduceOnlyOrderRequest = {
        clientOrderId,
        correlationId: command.correlationId,
        accountId: command.accountId,
        positionId: command.positionId,
        market: command.market,
        side: plan.side,
        quantity: firstQuantity,
        limitPrice: plan.limitPrice,
        reduceOnly: true,
        timeInForce: "IOC",
        fencingToken: claim.riskUnitLease.fencingToken
      };
      const orderAttempt = await repositories.orderAttempts.create({
        taskId: validating.id,
        executionStepId: step.id,
        attemptSequence,
        clientOrderId,
        requestedQuantity: firstQuantity,
        requestedPrice: plan.limitPrice,
        requestPayload: orderToPayload(order),
        createdAt: now
      });

      return {
        task: submitting,
        orderAttempt,
        executionStepId: step.id,
        order
      };
    });
  }

  private async recordAcceptedOrder(
    submission: Submission,
    claim: ClaimedLiquidationTask,
    exchangeOrderId: string,
    at: UtcIsoString
  ): Promise<ExecuteStaticLiquidationOutcome> {
    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, at);
      await repositories.orderAttempts.markAccepted(
        submission.orderAttempt.id,
        exchangeOrderId,
        { accepted: true, exchange_order_id: exchangeOrderId },
        at
      );
      await repositories.executionSteps.markWaitingOrder(submission.executionStepId, at);
      const waiting = await repositories.tasks.transition(
        submission.task.id,
        "WAITING_ORDER_EVENT",
        {
          at,
          reason: "order accepted; waiting for sequenced order events"
        }
      );
      await appendStateEvent(repositories, waiting, "ORDER_ACCEPTED", at, {
        client_order_id: submission.order.clientOrderId,
        exchange_order_id: exchangeOrderId
      });
      return {
        status: "WAITING_ORDER_EVENT",
        task: waiting,
        orderAttempt: {
          ...submission.orderAttempt,
          status: "ACCEPTED",
          exchangeOrderId
        }
      };
    });
  }

  private async recordUnknownSubmission(
    submission: Submission,
    claim: ClaimedLiquidationTask,
    reason: string,
    at: UtcIsoString
  ): Promise<ExecuteStaticLiquidationOutcome> {
    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, at);
      await repositories.orderAttempts.markUnknown(submission.orderAttempt.id, reason, at);
      const task = await repositories.tasks.transition(
        submission.task.id,
        "NEEDS_RECONCILIATION",
        {
          at,
          reason: "order submission result is unknown"
        }
      );
      await appendStateEvent(repositories, task, "ORDER_SUBMISSION_UNKNOWN", at, {
        client_order_id: submission.order.clientOrderId,
        error: reason
      });
      return {
        status: "NEEDS_RECONCILIATION",
        task,
        reason
      };
    });
  }

  private async recordKnownRejection(
    submission: Submission,
    claim: ClaimedLiquidationTask,
    reason: string,
    at: UtcIsoString
  ): Promise<ExecuteStaticLiquidationOutcome> {
    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, at);
      await repositories.orderAttempts.markRejected(
        submission.orderAttempt.id,
        reason,
        { accepted: false, reason },
        at
      );
      await repositories.executionSteps.markFailed(
        submission.executionStepId,
        reason,
        at
      );
      const task = await repositories.tasks.transition(submission.task.id, "FAILED", {
        at,
        reason: `order rejected: ${reason}`
      });
      await appendStateEvent(repositories, task, "ORDER_REJECTED", at, { reason });
      await createFailureOutbox(repositories, task, reason, at);
      return { status: "FAILED", task, reason };
    });
  }

  private async handlePreOrderFailure(
    validating: TaskRecord,
    claim: ClaimedLiquidationTask,
    error: unknown
  ): Promise<ExecuteStaticLiquidationOutcome> {
    const at = nowUtcIso(this.clock);
    const retryable = error instanceof AppError && error.retryable;
    const status = retryable ? "NEEDS_RECONCILIATION" : "FAILED";
    const reason = errorMessage(error);

    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, at);
      if (!retryable) {
        const pendingStep = await repositories.executionSteps.findFirstPending(validating.id);
        if (pendingStep !== undefined) {
          await repositories.executionSteps.markFailed(pendingStep.id, reason, at);
        }
      }
      const task = await repositories.tasks.transition(validating.id, status, {
        at,
        reason
      });
      await appendStateEvent(
        repositories,
        task,
        retryable ? "SNAPSHOT_FETCH_DEFERRED" : "VALIDATION_FAILED",
        at,
        { error: reason }
      );
      if (!retryable) {
        await createFailureOutbox(repositories, task, reason, at);
      }
      return { status, task, reason };
    });
  }
}

type Submission = Awaited<ReturnType<ExecuteStaticLiquidation["prepareSubmission"]>>;

async function assertFence(
  repositories: StaticExecutionRepositories,
  claim: ClaimedLiquidationTask,
  now: UtcIsoString
): Promise<void> {
  await repositories.riskUnitFences.assertCurrent({
    riskUnitId: claim.riskUnitLease.riskUnitId,
    owner: claim.riskUnitLease.owner,
    fencingToken: claim.riskUnitLease.fencingToken,
    now
  });
}

async function appendStateEvent(
  repositories: StaticExecutionRepositories,
  task: TaskRecord,
  eventType: string,
  at: UtcIsoString,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await repositories.taskEvents.append({
    taskId: task.id,
    eventType,
    eventSequence: BigInt(task.version + 1),
    payload: { status: task.status, ...payload },
    createdAt: at
  });
}

async function createFailureOutbox(
  repositories: StaticExecutionRepositories,
  task: TaskRecord,
  reason: string,
  at: UtcIsoString
): Promise<void> {
  await repositories.outbox.create({
    id: deterministicEntityId("outbox", [task.id, "LIQUIDATION_TASK_FAILED", task.version.toString()]),
    aggregateType: "LIQUIDATION_TASK",
    aggregateId: task.id,
    eventType: "LIQUIDATION_TASK_FAILED",
    payload: buildLiquidationResultOutboxPayload({
      task,
      status: "FAILED",
      executedSize: "0",
      errorCode: "LIQUIDATION_EXECUTION_FAILED",
      errorMessage: reason
    }),
    nextAttemptAt: at
  });
}

function orderToPayload(order: PlaceReduceOnlyOrderRequest): Record<string, unknown> {
  return {
    client_order_id: order.clientOrderId,
    correlation_id: order.correlationId,
    account_id: order.accountId,
    position_id: order.positionId,
    market: order.market,
    side: order.side,
    quantity: order.quantity,
    limit_price: order.limitPrice,
    reduce_only: order.reduceOnly,
    time_in_force: order.timeInForce,
    fencing_token: order.fencingToken.toString()
  };
}

function commandForStep(
  command: LiquidationCommand,
  step: ExecutionStepRecord
): LiquidationCommand {
  const expectedVersion =
    step.planPayload.expected_position_version ?? step.planPayload.position_version;
  if (typeof expectedVersion !== "string" || !/^\d+$/.test(expectedVersion)) {
    throw new InvariantViolationError("Execution step is missing its expected position version", {
      executionStepId: step.id.toString()
    });
  }

  return {
    ...command,
    positionVersion: BigInt(expectedVersion),
    quantity: step.requestedQuantity
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown external error";
}

function validateTimeout(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 100 || value > 30_000) {
    throw new ValidationError(`${field} must be between 100 and 30000 milliseconds`);
  }
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

import type { ClaimedLiquidationTask } from "./claim-liquidation-task.js";
import type { HandleOrderEvent, HandleOrderEventOutcome } from "./handle-order-event.js";
import type { OrderGateway } from "./ports/order-gateway.js";
import { compareDecimal } from "../domain/shared/decimal.js";
import { ValidationError } from "../domain/shared/errors.js";
import { deterministicEntityId } from "../domain/shared/id.js";
import { nowUtcIso, type UtcIsoString } from "../domain/shared/time.js";
import type { OrderAttemptRecord } from "../repositories/order-attempt-repository.js";
import type {
  StaticExecutionRepositories,
  StaticExecutionUnitOfWork
} from "../repositories/static-execution-unit-of-work.js";
import type { TaskRecord } from "../repositories/task-repository.js";
import { buildLiquidationResultOutboxPayload } from "./liquidation-result-payload.js";

export type ReconcileUnknownOrderDependencies = {
  readonly unitOfWork: StaticExecutionUnitOfWork;
  readonly orderGateway: OrderGateway;
  readonly orderEventHandler: Pick<HandleOrderEvent, "execute">;
  readonly clock?: () => Date;
};

export type ReconcileUnknownOrderOutcome =
  | { readonly status: "READY"; readonly task: TaskRecord }
  | {
      readonly status: "DEFERRED" | "SETTLEMENT_PENDING";
      readonly task: TaskRecord;
      readonly reason: string;
    }
  | { readonly status: "FAILED"; readonly task: TaskRecord; readonly reason: string }
  | {
      readonly status: "ORDER_STATE_RECOVERED";
      readonly orderEventOutcome: HandleOrderEventOutcome;
    };

export class ReconcileUnknownOrder {
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: ReconcileUnknownOrderDependencies,
    private readonly queryTimeoutMs: number
  ) {
    if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 100 || queryTimeoutMs > 30_000) {
      throw new ValidationError("queryTimeoutMs must be between 100 and 30000");
    }
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async execute(
    claim: ClaimedLiquidationTask,
    executionSignal?: AbortSignal
  ): Promise<ReconcileUnknownOrderOutcome> {
    const attempt = await this.loadLatestAttempt(claim);
    if (attempt === undefined) {
      const task = await this.returnToReady(
        claim,
        "no order attempt exists; external submission never started"
      );
      return { status: "READY", task };
    }
    if (attempt.status === "FILLED") {
      const reason = "filled order is waiting for settlement reconciliation";
      const task = await this.transitionAfterRecovery(
        claim,
        "WAITING_SETTLEMENT",
        reason,
        "RECOVERY_SETTLEMENT_PENDING"
      );
      return { status: "SETTLEMENT_PENDING", task, reason };
    }
    if (attempt.status === "REJECTED") {
      return this.failTerminalAttempt(claim, attempt, "recovered rejected order attempt");
    }
    if (attempt.status === "CANCELLED") {
      if (compareDecimal(attempt.filledQuantity, "0") === 0) {
        return this.failTerminalAttempt(
          claim,
          attempt,
          "recovered cancelled order attempt with no fill"
        );
      }
      const reason = "cancelled order has a partial fill requiring settlement reconciliation";
      const task = await this.transitionAfterRecovery(
        claim,
        "WAITING_SETTLEMENT",
        reason,
        "RECOVERY_PARTIAL_SETTLEMENT_PENDING"
      );
      return { status: "SETTLEMENT_PENDING", task, reason };
    }

    let lookup: Awaited<ReturnType<OrderGateway["getByClientOrderId"]>>;
    try {
      lookup = await this.dependencies.orderGateway.getByClientOrderId({
        clientOrderId: attempt.clientOrderId,
        correlationId: claim.task.correlationId,
        signal: timeoutSignal(this.queryTimeoutMs, executionSignal)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "order query failed";
      const task = await this.defer(claim, reason);
      return { status: "DEFERRED", task, reason };
    }

    if (!lookup.found) {
      const reason = "order gateway confirmed NOT_FOUND; awaiting another reconciliation pass";
      const task = await this.defer(claim, reason);
      return { status: "DEFERRED", task, reason };
    }

    const eventId = deterministicEntityId("recovery_event", [
      attempt.clientOrderId,
      lookup.eventSequence.toString()
    ]);
    const orderEventOutcome = await this.dependencies.orderEventHandler.execute(
      {
        event_id: eventId,
        correlation_id: claim.task.correlationId,
        client_order_id: attempt.clientOrderId,
        exchange_order_id: lookup.exchangeOrderId,
        event_sequence: lookup.eventSequence.toString(),
        event_type: lookup.eventType,
        cumulative_filled_quantity: lookup.cumulativeFilledQuantity,
        occurred_at: lookup.occurredAt
      },
      claim.riskUnitLease
    );
    if (
      orderEventOutcome.status !== "PROCESSED" &&
      (attempt.status === "ACCEPTED" || attempt.status === "PARTIALLY_FILLED")
    ) {
      await this.transitionAfterRecovery(
        claim,
        "WAITING_ORDER_EVENT",
        `order remains ${attempt.status.toLowerCase()} after reconciliation`,
        "RECOVERY_ORDER_STILL_OPEN"
      );
    }
    return { status: "ORDER_STATE_RECOVERED", orderEventOutcome };
  }

  private async loadLatestAttempt(
    claim: ClaimedLiquidationTask
  ): Promise<OrderAttemptRecord | undefined> {
    const now = nowUtcIso(this.clock);
    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, now);
      return repositories.orderAttempts.findLatestForTask(claim.task.id);
    });
  }

  private async returnToReady(
    claim: ClaimedLiquidationTask,
    reason: string
  ): Promise<TaskRecord> {
    return this.transitionAfterRecovery(claim, "READY", reason, "RECOVERY_SAFE_TO_RETRY");
  }

  private async defer(
    claim: ClaimedLiquidationTask,
    reason: string
  ): Promise<TaskRecord> {
    return this.transitionAfterRecovery(
      claim,
      "NEEDS_RECONCILIATION",
      reason,
      "RECOVERY_DEFERRED"
    );
  }

  private async failTerminalAttempt(
    claim: ClaimedLiquidationTask,
    attempt: OrderAttemptRecord,
    reason: string
  ): Promise<ReconcileUnknownOrderOutcome> {
    const now = nowUtcIso(this.clock);
    const task = await this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, now);
      await repositories.executionSteps.markFailed(attempt.executionStepId, reason, now);
      const failed = await repositories.tasks.transition(claim.task.id, "FAILED", {
        at: now,
        reason
      });
      await repositories.taskEvents.append({
        taskId: failed.id,
        eventType: `RECOVERY_ORDER_${attempt.status}`,
        eventSequence: BigInt(failed.version + 1),
        payload: {
          status: failed.status,
          client_order_id: attempt.clientOrderId,
          filled_quantity: attempt.filledQuantity,
          reason
        },
        createdAt: now
      });
      await repositories.outbox.create({
        id: deterministicEntityId("outbox", [
          failed.id,
          "RECOVERY_ORDER_TERMINAL_FAILURE",
          failed.version.toString()
        ]),
        aggregateType: "LIQUIDATION_TASK",
        aggregateId: failed.id,
        eventType: "LIQUIDATION_TASK_FAILED",
        payload: buildLiquidationResultOutboxPayload({
          task: failed,
          status: attempt.status === "REJECTED" ? "REJECTED" : "FAILED",
          executedSize: attempt.filledQuantity,
          errorCode: `ORDER_${attempt.status}`,
          errorMessage: reason,
          details: { client_order_id: attempt.clientOrderId }
        }),
        nextAttemptAt: now
      });
      return failed;
    });
    return { status: "FAILED", task, reason };
  }

  private async transitionAfterRecovery(
    claim: ClaimedLiquidationTask,
    status: "READY" | "WAITING_ORDER_EVENT" | "WAITING_SETTLEMENT" | "NEEDS_RECONCILIATION",
    reason: string,
    eventType: string
  ): Promise<TaskRecord> {
    const now = nowUtcIso(this.clock);
    return this.dependencies.unitOfWork.execute(async (repositories) => {
      await assertFence(repositories, claim, now);
      const task = await repositories.tasks.transition(claim.task.id, status, {
        at: now,
        reason
      });
      await repositories.taskEvents.append({
        taskId: task.id,
        eventType,
        eventSequence: BigInt(task.version + 1),
        payload: { status: task.status, reason },
        createdAt: now
      });
      return task;
    });
  }
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

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

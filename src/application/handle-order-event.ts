import { parseOrderEvent, type OrderEvent, type OrderEventType } from "../domain/execution/order-event.js";
import { compareDecimal } from "../domain/shared/decimal.js";
import { InvariantViolationError, ValidationError } from "../domain/shared/errors.js";
import { deterministicEntityId } from "../domain/shared/id.js";
import { nowUtcIso, type UtcIsoString } from "../domain/shared/time.js";
import type { OrderAttemptRecord, OrderAttemptStatus } from "../repositories/order-attempt-repository.js";
import type { ExecutionEventRepositories, ExecutionEventUnitOfWork } from "../repositories/execution-event-unit-of-work.js";
import type { TaskRecord } from "../repositories/task-repository.js";
import type { RiskUnitLockLease } from "../repositories/risk-unit-lock.js";
import { buildLiquidationResultOutboxPayload } from "./liquidation-result-payload.js";

export type HandleOrderEventOutcome =
  | { readonly status: "DUPLICATE" | "OUT_OF_ORDER"; readonly eventId: string }
  | {
      readonly status: "PROCESSED";
      readonly eventId: string;
      readonly task: TaskRecord;
      readonly orderAttempt: OrderAttemptRecord;
    };

export class HandleOrderEvent {
  private readonly clock: () => Date;

  constructor(
    private readonly unitOfWork: ExecutionEventUnitOfWork,
    clock: () => Date = () => new Date()
  ) {
    this.clock = clock;
  }

  async execute(
    payload: unknown,
    recoveryFence?: RiskUnitLockLease
  ): Promise<HandleOrderEventOutcome> {
    const event = parseOrderEvent(payload);
    const receivedAt = nowUtcIso(this.clock);

    return this.unitOfWork.execute(async (repositories) => {
      if (recoveryFence !== undefined) {
        await repositories.riskUnitFences.assertCurrent({
          riskUnitId: recoveryFence.riskUnitId,
          owner: recoveryFence.owner,
          fencingToken: recoveryFence.fencingToken,
          now: receivedAt
        });
      }
      const receipt = await repositories.orderEvents.record(event, receivedAt);
      if (receipt.status === "DUPLICATE") {
        return { status: "DUPLICATE", eventId: event.eventId };
      }

      const attempt = await repositories.orderAttempts.findByClientOrderId(
        event.clientOrderId
      );
      if (attempt === undefined) {
        throw new InvariantViolationError("Order event references an unknown client_order_id", {
          clientOrderId: event.clientOrderId
        });
      }
      if (
        attempt.lastEventSequence !== undefined &&
        event.eventSequence <= attempt.lastEventSequence
      ) {
        await repositories.orderEvents.markDisposition(
          event.eventId,
          "OUT_OF_ORDER",
          receivedAt
        );
        return { status: "OUT_OF_ORDER", eventId: event.eventId };
      }

      validateOrderEvent(attempt, event);
      const nextAttempt = await repositories.orderAttempts.applyEvent({
        id: attempt.id,
        status: eventTypeToAttemptStatus(event.eventType),
        exchangeOrderId: event.exchangeOrderId,
        filledQuantity: event.cumulativeFilledQuantity,
        eventSequence: event.eventSequence,
        terminalAt: isTerminalEvent(event.eventType) ? event.occurredAt : undefined
      });
      const currentTask = await repositories.tasks.findById(attempt.taskId);
      if (currentTask === undefined) {
        throw new InvariantViolationError("Order attempt references an unknown task", {
          taskId: attempt.taskId
        });
      }
      if (currentTask.correlationId !== event.correlationId) {
        throw new ValidationError("Order event correlation_id does not match the task");
      }

      if (
        event.eventType === "REJECTED" ||
        (event.eventType === "CANCELLED" &&
          compareDecimal(event.cumulativeFilledQuantity, "0") === 0)
      ) {
        await repositories.executionSteps.markFailed(
          attempt.executionStepId,
          `order event ${event.eventType}`,
          receivedAt
        );
      }

      const task = await advanceTask(repositories, currentTask, event, receivedAt);
      await repositories.orderEvents.markDisposition(
        event.eventId,
        "PROCESSED",
        receivedAt
      );
      return {
        status: "PROCESSED",
        eventId: event.eventId,
        task,
        orderAttempt: nextAttempt
      };
    });
  }
}

function validateOrderEvent(attempt: OrderAttemptRecord, event: OrderEvent): void {
  if (
    attempt.exchangeOrderId !== undefined &&
    attempt.exchangeOrderId !== event.exchangeOrderId
  ) {
    throw new ValidationError("Order event exchange_order_id does not match the attempt");
  }
  if (compareDecimal(event.cumulativeFilledQuantity, attempt.filledQuantity) < 0) {
    throw new ValidationError("Order event cumulative fill moved backwards");
  }
  if (compareDecimal(event.cumulativeFilledQuantity, attempt.requestedQuantity) > 0) {
    throw new ValidationError("Order event cumulative fill exceeds requested quantity");
  }

  const filledComparison = compareDecimal(
    event.cumulativeFilledQuantity,
    attempt.requestedQuantity
  );
  if (
    (event.eventType === "ACCEPTED" || event.eventType === "REJECTED") &&
    compareDecimal(event.cumulativeFilledQuantity, "0") !== 0
  ) {
    throw new ValidationError(`${event.eventType} event must have zero cumulative fill`);
  }
  if (event.eventType === "PARTIALLY_FILLED" && filledComparison >= 0) {
    throw new ValidationError("PARTIALLY_FILLED must remain below requested quantity");
  }
  if (event.eventType === "FILLED" && filledComparison !== 0) {
    throw new ValidationError("FILLED cumulative quantity must equal requested quantity");
  }
  if (!allowedEvents(attempt.status).includes(event.eventType)) {
    throw new ValidationError("Order event is invalid for the current attempt status", {
      attemptStatus: attempt.status,
      eventType: event.eventType
    });
  }
}

function allowedEvents(status: OrderAttemptStatus): readonly OrderEventType[] {
  switch (status) {
    case "CREATED":
    case "UNKNOWN":
    case "ACCEPTED":
      return ["ACCEPTED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED"];
    case "PARTIALLY_FILLED":
      return ["PARTIALLY_FILLED", "FILLED", "CANCELLED"];
    case "FILLED":
    case "REJECTED":
    case "CANCELLED":
      return [];
  }
}

function eventTypeToAttemptStatus(eventType: OrderEventType): OrderAttemptStatus {
  return eventType;
}

function isTerminalEvent(eventType: OrderEventType): boolean {
  return eventType === "FILLED" || eventType === "REJECTED" || eventType === "CANCELLED";
}

async function advanceTask(
  repositories: ExecutionEventRepositories,
  current: TaskRecord,
  event: OrderEvent,
  at: UtcIsoString
): Promise<TaskRecord> {
  let target: "WAITING_ORDER_EVENT" | "WAITING_SETTLEMENT" | "NEEDS_RECONCILIATION" | "FAILED";
  if (event.eventType === "FILLED") {
    target = "WAITING_SETTLEMENT";
  } else if (event.eventType === "REJECTED") {
    target = "FAILED";
  } else if (event.eventType === "CANCELLED") {
    target =
      compareDecimal(event.cumulativeFilledQuantity, "0") === 0
        ? "FAILED"
        : "WAITING_SETTLEMENT";
  } else {
    target = "WAITING_ORDER_EVENT";
  }

  const task = await repositories.tasks.transition(current.id, target, {
    at,
    reason: `order event ${event.eventType} sequence ${event.eventSequence.toString()}`
  });
  await repositories.taskEvents.append({
    taskId: task.id,
    eventType: `ORDER_${event.eventType}`,
    eventSequence: BigInt(task.version + 1),
    payload: {
      status: task.status,
      client_order_id: event.clientOrderId,
      exchange_order_id: event.exchangeOrderId,
      order_event_sequence: event.eventSequence.toString(),
      cumulative_filled_quantity: event.cumulativeFilledQuantity
    },
    createdAt: at
  });

  if (target === "FAILED") {
    await repositories.outbox.create({
      id: deterministicEntityId("outbox", [task.id, "ORDER_TERMINAL_FAILURE", task.version.toString()]),
      aggregateType: "LIQUIDATION_TASK",
      aggregateId: task.id,
      eventType: "LIQUIDATION_TASK_FAILED",
      payload: buildLiquidationResultOutboxPayload({
        task,
        status: event.eventType === "REJECTED" ? "REJECTED" : "FAILED",
        executedSize: event.cumulativeFilledQuantity,
        errorCode: `ORDER_${event.eventType}`,
        errorMessage: `Order reached terminal state ${event.eventType}`,
        details: { client_order_id: event.clientOrderId }
      }),
      nextAttemptAt: at
    });
  }
  return task;
}

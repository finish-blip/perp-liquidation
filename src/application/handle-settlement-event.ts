import { parseLiquidationCommand } from "../domain/commands/liquidation-command-parser.js";
import { buildLiquidationResultOutboxPayload } from "./liquidation-result-payload.js";
import { parseSettlementEvent } from "../domain/execution/settlement-event.js";
import {
  addDecimal,
  compareDecimal,
  subtractDecimal,
  type DecimalString
} from "../domain/shared/decimal.js";
import { ConflictError, InvariantViolationError, ValidationError } from "../domain/shared/errors.js";
import { deterministicEntityId } from "../domain/shared/id.js";
import { nowUtcIso, type UtcIsoString } from "../domain/shared/time.js";
import type { ExecutionEventRepositories, ExecutionEventUnitOfWork } from "../repositories/execution-event-unit-of-work.js";
import type { ExecutionStepRecord } from "../repositories/execution-step-repository.js";
import type { OrderAttemptRecord } from "../repositories/order-attempt-repository.js";
import type { TaskRecord } from "../repositories/task-repository.js";

export type HandleSettlementEventOutcome =
  | { readonly status: "DUPLICATE"; readonly eventId: string }
  | {
      readonly status: "NEXT_STEP_READY" | "RESULT_PUBLISHING";
      readonly eventId: string;
      readonly task: TaskRecord;
    };

export class HandleSettlementEvent {
  private readonly clock: () => Date;

  constructor(
    private readonly unitOfWork: ExecutionEventUnitOfWork,
    clock: () => Date = () => new Date()
  ) {
    this.clock = clock;
  }

  async execute(payload: unknown): Promise<HandleSettlementEventOutcome> {
    const event = parseSettlementEvent(payload);
    const receivedAt = nowUtcIso(this.clock);

    return this.unitOfWork.execute(async (repositories) => {
      const receipt = await repositories.settlementEvents.record(event, receivedAt);
      if (receipt.status === "DUPLICATE") {
        return { status: "DUPLICATE", eventId: event.eventId };
      }

      const attempt = await repositories.orderAttempts.findByClientOrderId(
        event.clientOrderId
      );
      if (attempt === undefined) {
        throw new InvariantViolationError("Settlement references an unknown client_order_id");
      }
      const task = await repositories.tasks.findById(attempt.taskId);
      const step = await repositories.executionSteps.findById(attempt.executionStepId);
      if (task === undefined || step === undefined) {
        throw new InvariantViolationError("Settlement references missing task or execution step");
      }
      validateSettlement(event, attempt, task, step);

      const partialCancellation = attempt.status === "CANCELLED";
      if (partialCancellation) {
        await repositories.executionSteps.requeueAfterPartialSettlement({
          id: step.id,
          remainingQuantity: subtractDecimal(
            attempt.requestedQuantity,
            attempt.filledQuantity
          ),
          positionVersion: event.newPositionVersion,
          updatedAt: receivedAt
        });
      } else {
        await repositories.executionSteps.markCompleted(step.id, receivedAt);
      }
      const completed = await repositories.tasks.transition(task.id, "STEP_COMPLETED", {
        at: receivedAt,
        reason: `settlement ${event.eventId} confirmed`
      });
      await appendSettlementEvent(
        repositories,
        completed,
        event.eventId,
        receivedAt,
        partialCancellation
      );

      const nextStep = partialCancellation
        ? step
        : await repositories.executionSteps.findNextPending(task.id, step.stepSequence);
      let nextTask: TaskRecord;
      let status: "NEXT_STEP_READY" | "RESULT_PUBLISHING";
      if (nextStep !== undefined) {
        if (!partialCancellation) {
          await repositories.executionSteps.setExpectedPositionVersion(
            nextStep.id,
            event.newPositionVersion,
            receivedAt
          );
        }
        nextTask = await repositories.tasks.transition(task.id, "READY", {
          at: receivedAt,
          reason: `execution step ${nextStep.stepSequence} is ready`
        });
        status = "NEXT_STEP_READY";
      } else {
        const command = parseLiquidationCommand(task.commandPayload);
        const settledEvents = await repositories.settlementEvents.listForTask(task.id);
        const executedSize = settledEvents.reduce<DecimalString>(
          (total, settledEvent) => addDecimal(total, settledEvent.settledQuantity),
          "0" as DecimalString
        );
        nextTask = await repositories.tasks.transition(task.id, "RESULT_PUBLISHING", {
          at: receivedAt,
          reason: "all STATIC execution steps settled"
        });
        await repositories.outbox.create({
          id: deterministicEntityId("outbox", [task.id, "EXECUTION_SETTLED"]),
          aggregateType: "LIQUIDATION_TASK",
          aggregateId: task.id,
          eventType: "LIQUIDATION_EXECUTION_SETTLED",
          payload: buildLiquidationResultOutboxPayload({
            task: nextTask,
            status:
              compareDecimal(executedSize, command.quantity) >= 0
                ? "COMPLETED"
                : "PARTIALLY_COMPLETED",
            executedSize,
            finalPositionVersion: event.newPositionVersion,
            details: { client_order_id: event.clientOrderId }
          }),
          nextAttemptAt: receivedAt
        });
        status = "RESULT_PUBLISHING";
      }

      await repositories.taskEvents.append({
        taskId: nextTask.id,
        eventType: status,
        eventSequence: BigInt(nextTask.version + 1),
        payload: { status: nextTask.status },
        createdAt: receivedAt
      });
      await repositories.settlementEvents.markDisposition(
        event.eventId,
        "PROCESSED",
        receivedAt
      );
      return { status, eventId: event.eventId, task: nextTask };
    });
  }
}

function validateSettlement(
  event: ReturnType<typeof parseSettlementEvent>,
  attempt: OrderAttemptRecord,
  task: TaskRecord,
  step: ExecutionStepRecord
): void {
  if (task.status !== "WAITING_SETTLEMENT") {
    throw new ConflictError("Settlement arrived before the task was ready for settlement");
  }
  if (attempt.status !== "FILLED" && attempt.status !== "CANCELLED") {
    throw new ConflictError("Settlement arrived before the order reached a terminal fill state");
  }
  if (
    attempt.exchangeOrderId !== event.exchangeOrderId ||
    task.correlationId !== event.correlationId
  ) {
    throw new ValidationError("Settlement order or correlation identity does not match");
  }
  const command = parseLiquidationCommand(task.commandPayload);
  if (command.positionId !== event.positionId) {
    throw new ValidationError("Settlement position_id does not match the liquidation command");
  }
  if (compareDecimal(event.settledQuantity, attempt.filledQuantity) !== 0) {
    throw new ValidationError("Settlement quantity does not equal the order filled quantity");
  }
  if (
    attempt.status === "FILLED" &&
    compareDecimal(event.settledQuantity, attempt.requestedQuantity) !== 0
  ) {
    throw new ValidationError("FILLED settlement quantity does not equal requested quantity");
  }
  if (
    attempt.status === "CANCELLED" &&
    (compareDecimal(attempt.filledQuantity, "0") <= 0 ||
      compareDecimal(attempt.filledQuantity, attempt.requestedQuantity) >= 0)
  ) {
    throw new ValidationError("CANCELLED settlement must represent a partial fill");
  }

  const expectedVersion = expectedPositionVersion(step);
  if (event.previousPositionVersion !== expectedVersion) {
    throw new ValidationError("Settlement previous position version does not match the step", {
      expected: expectedVersion.toString(),
      actual: event.previousPositionVersion.toString()
    });
  }
}

function expectedPositionVersion(step: ExecutionStepRecord): bigint {
  const value =
    step.planPayload.expected_position_version ?? step.planPayload.position_version;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new InvariantViolationError("Execution step has no expected position version", {
      executionStepId: step.id.toString()
    });
  }
  return BigInt(value);
}

async function appendSettlementEvent(
  repositories: ExecutionEventRepositories,
  task: TaskRecord,
  settlementEventId: string,
  at: UtcIsoString,
  partial: boolean
): Promise<void> {
  await repositories.taskEvents.append({
    taskId: task.id,
    eventType: partial ? "STEP_PARTIALLY_SETTLED" : "STEP_SETTLED",
    eventSequence: BigInt(task.version + 1),
    payload: { status: task.status, settlement_event_id: settlementEventId },
    createdAt: at
  });
}

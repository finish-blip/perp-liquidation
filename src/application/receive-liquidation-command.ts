import {
  liquidationCommandToPayload,
  parseLiquidationCommand
} from "../domain/commands/liquidation-command-parser.js";
import type {
  LiquidationCommand,
  LiquidationCommandType
} from "../domain/commands/liquidation-command.js";
import { ValidationError } from "../domain/shared/errors.js";
import {
  deterministicEntityId,
  type TaskId
} from "../domain/shared/id.js";
import { nowUtcIso, toEpochMillis, type UtcIsoString } from "../domain/shared/time.js";
import type {
  CommandIntakeRepositories,
  CommandIntakeUnitOfWork
} from "../repositories/command-intake-unit-of-work.js";
import type { TaskRecord } from "../repositories/task-repository.js";

export type ReceiveLiquidationCommandInput = {
  readonly source: string;
  readonly payload: unknown;
  readonly receivedAt?: UtcIsoString;
};

export type ReceiveLiquidationCommandOutcome =
  | {
      readonly status: "ACCEPTED";
      readonly messageId: string;
      readonly task: TaskRecord;
    }
  | {
      readonly status: "DUPLICATE";
      readonly messageId: string;
      readonly existingTaskId: TaskId | undefined;
    }
  | {
      readonly status: "STALE_SEQUENCE";
      readonly messageId: string;
      readonly existingTaskId: TaskId;
      readonly latestDecisionSequence: bigint;
    };

export type ReceiveLiquidationCommandDependencies = {
  readonly unitOfWork: CommandIntakeUnitOfWork;
  readonly clock?: () => Date;
};

const COMMAND_PRIORITIES: Record<LiquidationCommandType, number> = {
  LIQUIDATE_POSITION: 100,
  CANCEL_RISK_ORDERS: 80,
  REDUCE_POSITION: 60
};

export class ReceiveLiquidationCommand {
  private readonly clock: () => Date;

  constructor(private readonly dependencies: ReceiveLiquidationCommandDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async execute(input: ReceiveLiquidationCommandInput): Promise<ReceiveLiquidationCommandOutcome> {
    assertSource(input.source);
    const command = parseLiquidationCommand(input.payload);
    const receivedAt = input.receivedAt ?? nowUtcIso(this.clock);
    assertSupportedCommand(command, receivedAt);
    const taskId = deterministicEntityId("task", [input.source, command.messageId]);

    return this.dependencies.unitOfWork.execute(async (repositories) => {
      const inboxReceipt = await repositories.inbox.record({
        source: input.source,
        command,
        receivedAt
      });

      if (inboxReceipt.status === "DUPLICATE") {
        return {
          status: "DUPLICATE",
          messageId: command.messageId,
          existingTaskId: inboxReceipt.existingTaskId
        };
      }

      const sequenceClaim = await repositories.decisionSequences.claim({
        riskUnitId: command.riskUnitId,
        decisionSequence: command.decisionSequence,
        messageId: command.messageId,
        taskId,
        claimedAt: receivedAt
      });

      if (sequenceClaim.status === "STALE_SEQUENCE") {
        await repositories.inbox.markStale({
          messageId: command.messageId,
          existingTaskId: sequenceClaim.existingTaskId,
          processedAt: receivedAt
        });

        return {
          status: "STALE_SEQUENCE",
          messageId: command.messageId,
          existingTaskId: sequenceClaim.existingTaskId,
          latestDecisionSequence: sequenceClaim.latestDecisionSequence
        };
      }

      await this.cancelSupersededTasks(command, taskId, receivedAt, repositories);

      const commandPayload = { ...liquidationCommandToPayload(command) };
      const task = await repositories.tasks.create({
        id: taskId,
        inboxMessageId: command.messageId,
        correlationId: command.correlationId,
        riskUnitId: command.riskUnitId,
        commandType: command.commandType,
        priority: COMMAND_PRIORITIES[command.commandType],
        decisionSequence: command.decisionSequence,
        commandPayload,
        now: receivedAt
      });

      await repositories.taskEvents.append({
        taskId,
        eventType: "TASK_RECEIVED",
        eventSequence: eventSequenceFor(task.version),
        payload: {
          status: task.status,
          decision_sequence: command.decisionSequence.toString()
        },
        createdAt: receivedAt
      });

      await repositories.executionSteps.create({
        taskId,
        stepSequence: 1,
        strategy: command.strategy,
        quantityMode: command.quantityMode,
        requestedQuantity: command.quantity,
        remainingQuantity: command.quantity,
        status: "PENDING",
        planPayload: buildInitialPlanPayload(command),
        createdAt: receivedAt
      });

      const readyTask = await repositories.tasks.transition(taskId, "READY", {
        at: receivedAt,
        reason: "initial execution step created"
      });

      await repositories.taskEvents.append({
        taskId,
        eventType: "TASK_READY",
        eventSequence: eventSequenceFor(readyTask.version),
        payload: {
          status: readyTask.status,
          strategy: command.strategy
        },
        createdAt: receivedAt
      });

      await repositories.inbox.markProcessed({
        messageId: command.messageId,
        taskId,
        processedAt: receivedAt
      });

      const outboxId = deterministicEntityId("outbox", [taskId, "LIQUIDATION_TASK_ACCEPTED"]);
      await repositories.outbox.create({
        id: outboxId,
        aggregateType: "LIQUIDATION_TASK",
        aggregateId: taskId,
        eventType: "LIQUIDATION_TASK_ACCEPTED",
        payload: {
          message_id: command.messageId,
          correlation_id: command.correlationId,
          task_id: taskId,
          risk_unit_id: command.riskUnitId,
          decision_sequence: command.decisionSequence.toString(),
          status: readyTask.status
        },
        nextAttemptAt: receivedAt
      });

      return {
        status: "ACCEPTED",
        messageId: command.messageId,
        task: readyTask
      };
    });
  }

  private async cancelSupersededTasks(
    command: LiquidationCommand,
    replacingTaskId: TaskId,
    at: UtcIsoString,
    repositories: CommandIntakeRepositories
  ): Promise<void> {
    const supersededTasks = await repositories.tasks.findSupersedable(
      command.riskUnitId,
      command.decisionSequence
    );

    for (const superseded of supersededTasks) {
      const cancelled = await repositories.tasks.transition(superseded.id, "CANCELLED", {
        at,
        reason: `superseded by ${replacingTaskId}`
      });

      await repositories.taskEvents.append({
        taskId: cancelled.id,
        eventType: "TASK_SUPERSEDED",
        eventSequence: eventSequenceFor(cancelled.version),
        payload: {
          status: cancelled.status,
          replacing_task_id: replacingTaskId,
          replacing_decision_sequence: command.decisionSequence.toString()
        },
        createdAt: at
      });
    }
  }
}

function assertSupportedCommand(command: LiquidationCommand, receivedAt: UtcIsoString): void {
  if (command.strategy !== "STATIC") {
    throw new ValidationError("Only STATIC execution strategy is currently supported");
  }
  if (command.commandType === "CANCEL_RISK_ORDERS") {
    throw new ValidationError("CANCEL_RISK_ORDERS is not currently supported");
  }
  if (toEpochMillis(command.expiresAt) <= toEpochMillis(receivedAt)) {
    throw new ValidationError("Liquidation command has expired");
  }
}

function buildInitialPlanPayload(command: LiquidationCommand): Record<string, unknown> {
  return {
    action: command.commandType,
    account_id: command.accountId,
    position_id: command.positionId,
    position_version: command.positionVersion.toString(),
    market: command.market,
    side: command.side,
    expires_at: command.expiresAt
  };
}

function eventSequenceFor(taskVersion: number): bigint {
  return BigInt(taskVersion + 1);
}

function assertSource(source: string): void {
  if (source.length < 1 || source.length > 64) {
    throw new ValidationError("Command source must be between 1 and 64 characters", {
      source
    });
  }
}

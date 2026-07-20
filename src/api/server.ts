import { createHash, timingSafeEqual } from "node:crypto";

import Fastify from "fastify";
import { Registry, collectDefaultMetrics } from "prom-client";

import type { HandleOrderEvent } from "../application/handle-order-event.js";
import type { HandleSettlementEvent } from "../application/handle-settlement-event.js";
import type { OperationApprovals } from "../application/operation-approvals.js";
import type { ReceiveLiquidationCommand } from "../application/receive-liquidation-command.js";
import type { MarketDataClient } from "../application/ports/market-data-client.js";
import type { AppConfig } from "../config/env.js";
import { AppError, UnauthorizedError, ValidationError } from "../domain/shared/errors.js";
import { assertEntityId } from "../domain/shared/id.js";
import { nowUtcIso } from "../domain/shared/time.js";
import type { AppLogger } from "../observability/logger.js";
import type {
  ApprovalActionType,
  ApprovalRecord
} from "../repositories/approval-repository.js";
import type { TaskReader } from "../repositories/task-reader.js";
import type { TaskRecord } from "../repositories/task-repository.js";

export type ApiServices = {
  readonly commands: Pick<ReceiveLiquidationCommand, "execute">;
  readonly orderEvents: Pick<HandleOrderEvent, "execute">;
  readonly settlementEvents: Pick<HandleSettlementEvent, "execute">;
  readonly tasks: TaskReader;
  readonly marketData: MarketDataClient;
  readonly approvals: Pick<OperationApprovals, "request" | "get" | "approve" | "reject">;
  readonly readiness: { check(): Promise<void> };
};

export function buildServer(config: AppConfig, logger: AppLogger, services: ApiServices) {
  const metricsRegistry = new Registry();
  collectDefaultMetrics({ register: metricsRegistry });
  const app = Fastify({ loggerInstance: logger });

  app.addHook("onRequest", (request, _reply, done) => {
    const expected = config.api.serviceAuthToken;
    if (expected === undefined || !requiresServiceAuthentication(request.method, request.url)) {
      done();
      return;
    }
    const actual = optionalHeader(request.headers["x-service-token"]);
    if (actual === undefined || !securelyEqual(actual, expected)) {
      done(new UnauthorizedError());
      return;
    }
    done();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(statusForError(error)).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      });
    }
    logger.error({ error }, "unhandled API error");
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" }
    });
  });

  app.get("/healthz", () => ({
    status: "ok",
    environment: config.nodeEnv,
    time: nowUtcIso()
  }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await services.readiness.check();
      return { status: "ready", time: nowUtcIso() };
    } catch (error) {
      logger.warn({ error }, "readiness check failed");
      return reply.code(503).send({ status: "not_ready", time: nowUtcIso() });
    }
  });
  app.get("/metrics", (_request, reply) => {
    reply.type(metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  app.post("/v1/commands", async (request, reply) => {
    const result = await services.commands.execute({
      source: optionalHeader(request.headers["x-command-source"]) ?? "http-api",
      payload: request.body
    });
    reply.code(result.status === "ACCEPTED" ? 202 : 200);
    return {
      status: result.status,
      message_id: result.messageId,
      ...(result.status === "ACCEPTED"
        ? { task: taskToResponse(result.task) }
        : { existing_task_id: result.existingTaskId }),
      ...(result.status === "STALE_SEQUENCE"
        ? { latest_decision_sequence: result.latestDecisionSequence.toString() }
        : {})
    };
  });

  app.post("/v1/events/orders", async (request, reply) => {
    const result = await services.orderEvents.execute(request.body);
    reply.code(result.status === "PROCESSED" ? 202 : 200);
    return {
      status: result.status,
      event_id: result.eventId,
      ...(result.status === "PROCESSED" ? { task: taskToResponse(result.task) } : {})
    };
  });

  app.post("/v1/events/settlements", async (request, reply) => {
    const result = await services.settlementEvents.execute(request.body);
    reply.code(result.status === "DUPLICATE" ? 200 : 202);
    return {
      status: result.status,
      event_id: result.eventId,
      ...(result.status === "DUPLICATE" ? {} : { task: taskToResponse(result.task) })
    };
  });

  app.get<{ Params: { market: string } }>(
    "/v1/markets/:market/snapshot",
    async (request) => {
      const snapshot = await services.marketData.getSnapshot({
        market: request.params.market,
        correlationId:
          optionalHeader(request.headers["x-correlation-id"]) ?? "market-data-api",
        signal: undefined
      });
      return {
        market: snapshot.market,
        best_bid: snapshot.bestBid,
        best_ask: snapshot.bestAsk,
        mark_price: snapshot.markPrice,
        tick_size: snapshot.tickSize,
        step_size: snapshot.stepSize,
        observed_at: snapshot.observedAt,
        source: "BINANCE_USD_M_FUTURES"
      };
    }
  );

  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId", async (request, reply) => {
    const taskId = assertEntityId(request.params.taskId, "task");
    const task = await services.tasks.findById(taskId);
    if (task === undefined) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Task does not exist" }
      });
    }
    return taskToResponse(task);
  });

  app.post("/v1/approvals", async (request, reply) => {
    const body = objectBody(request.body);
    const outcome = await services.approvals.request({
      approvalId: stringField(body, "approval_id"),
      actionType: actionTypeField(body, "action_type"),
      targetId: stringField(body, "target_id"),
      reason: stringField(body, "reason"),
      requestedBy: requiredHeader(request.headers["x-operator-id"], "x-operator-id")
    });
    reply.code(outcome.status === "CREATED" ? 201 : 200);
    return { status: outcome.status, approval: approvalToResponse(outcome.approval) };
  });

  app.get<{ Params: { approvalId: string } }>(
    "/v1/approvals/:approvalId",
    async (request) => approvalToResponse(await services.approvals.get(request.params.approvalId))
  );

  app.post<{ Params: { approvalId: string } }>(
    "/v1/approvals/:approvalId/approve",
    async (request) => {
      const outcome = await services.approvals.approve(
        request.params.approvalId,
        requiredHeader(request.headers["x-operator-id"], "x-operator-id")
      );
      return { status: outcome.status, approval: approvalToResponse(outcome.approval) };
    }
  );

  app.post<{ Params: { approvalId: string } }>(
    "/v1/approvals/:approvalId/reject",
    async (request) => {
      const body = objectBody(request.body);
      const outcome = await services.approvals.reject(
        request.params.approvalId,
        requiredHeader(request.headers["x-operator-id"], "x-operator-id"),
        stringField(body, "reason")
      );
      return { status: outcome.status, approval: approvalToResponse(outcome.approval) };
    }
  );

  return app;
}

function taskToResponse(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    inbox_message_id: task.inboxMessageId,
    correlation_id: task.correlationId,
    risk_unit_id: task.riskUnitId,
    command_type: task.commandType,
    status: task.status,
    status_reason: task.statusReason,
    priority: task.priority,
    decision_sequence: task.decisionSequence.toString(),
    fencing_token: task.fencingToken?.toString(),
    lease_owner: task.leaseOwner,
    lease_expires_at: task.leaseExpiresAt,
    version: task.version.toString(),
    command_payload: task.commandPayload,
    created_at: task.createdAt,
    updated_at: task.updatedAt
  };
}

function approvalToResponse(approval: ApprovalRecord): Record<string, unknown> {
  return {
    approval_id: approval.id,
    action_type: approval.actionType,
    target_id: approval.targetId,
    reason: approval.reason,
    status: approval.status,
    requested_by: approval.requestedBy,
    decided_by: approval.decidedBy,
    decision_reason: approval.decisionReason,
    requested_at: approval.requestedAt,
    decided_at: approval.decidedAt,
    executed_at: approval.executedAt
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  return value;
}

function actionTypeField(
  body: Record<string, unknown>,
  field: string
): ApprovalActionType {
  const value = stringField(body, field);
  if (value === "CANCEL_TASK" || value === "FORCE_RECONCILIATION" || value === "REPLAY_OUTBOX") {
    return value;
  }
  throw new ValidationError("action_type is unsupported");
}

function requiredHeader(value: string | string[] | undefined, field: string): string {
  const header = optionalHeader(value);
  if (header === undefined) {
    throw new ValidationError(`${field} header is required`);
  }
  return header;
}

function optionalHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError("Header must have exactly one value");
  }
  return value;
}

function statusForError(error: AppError): number {
  switch (error.code) {
    case "VALIDATION_FAILED":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "UNAUTHORIZED":
      return 401;
    case "CONFLICT":
    case "STATE_TRANSITION_INVALID":
      return 409;
    case "EXTERNAL_TIMEOUT":
    case "EXTERNAL_RETRYABLE":
    case "EXTERNAL_FATAL":
      return 502;
    case "CONFIG_INVALID":
    case "INVARIANT_VIOLATION":
      return 500;
  }
}

function requiresServiceAuthentication(method: string, url: string): boolean {
  return url.startsWith("/v1/") && !(method === "GET" && url.startsWith("/v1/markets/"));
}

function securelyEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

import { describe, expect, it, vi } from "vitest";

import type { ApiServices } from "../../../src/api/server.js";
import { buildServer } from "../../../src/api/server.js";
import type { HandleOrderEvent } from "../../../src/application/handle-order-event.js";
import type { HandleSettlementEvent } from "../../../src/application/handle-settlement-event.js";
import type { OperationApprovals } from "../../../src/application/operation-approvals.js";
import type { ReceiveLiquidationCommand } from "../../../src/application/receive-liquidation-command.js";
import type { MarketDataClient } from "../../../src/application/ports/market-data-client.js";
import { assertDecimalString } from "../../../src/domain/shared/decimal.js";
import { loadConfig } from "../../../src/config/env.js";
import { ConflictError } from "../../../src/domain/shared/errors.js";
import { assertEntityId } from "../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";
import { createLogger } from "../../../src/observability/logger.js";
import type { ApprovalRecord } from "../../../src/repositories/approval-repository.js";
import type { TaskReader } from "../../../src/repositories/task-reader.js";
import type { TaskRecord } from "../../../src/repositories/task-repository.js";

const NOW = assertUtcIsoString("2026-07-18T08:00:00.000Z");
const TASK_ID = assertEntityId("task_api", "task");
const APPROVAL_ID = assertEntityId("approval_api", "approval");

describe("business API", () => {
  it("serves health and readiness without service authentication", async () => {
    const harness = createHarness();
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      SERVICE_AUTH_TOKEN: "service-secret"
    });
    const app = buildServer(
      config,
      createLogger(config, { component: "api-test" }),
      harness.services
    );

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const readiness = await app.inject({ method: "GET", url: "/readyz" });

    expect(health.statusCode).toBe(200);
    expect(readiness.statusCode).toBe(200);
    await app.close();
  });

  it("accepts commands and serializes BIGINT fields as strings", async () => {
    const harness = createHarness();
    const app = createApp(harness.services);

    const response = await app.inject({
      method: "POST",
      url: "/v1/commands",
      headers: { "x-command-source": "risk-api" },
      payload: { message_id: "message-1" }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json<{
      status: string;
      task: {
        id: string;
        decision_sequence: string;
        fencing_token: string;
        version: string;
      };
    }>();
    expect(body.status).toBe("ACCEPTED");
    expect(body.task).toEqual(
      expect.objectContaining({
        id: TASK_ID,
        decision_sequence: "9007199254740993",
        fencing_token: "9007199254740995",
        version: "4"
      })
    );
    expect(harness.mocks.commandExecute).toHaveBeenCalledWith({
      source: "risk-api",
      payload: { message_id: "message-1" }
    });
    await app.close();
  });

  it("returns a task by id without numeric precision loss", async () => {
    const harness = createHarness();
    const app = createApp(harness.services);

    const response = await app.inject({ method: "GET", url: `/v1/tasks/${TASK_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ decision_sequence: string }>().decision_sequence).toBe(
      "9007199254740993"
    );
    await app.close();
  });

  it("exposes normalized Binance market snapshots", async () => {
    const harness = createHarness();
    const app = createApp(harness.services);

    const response = await app.inject({
      method: "GET",
      url: "/v1/markets/BTCUSDT/snapshot"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ source: string; mark_price: string }>()).toEqual(
      expect.objectContaining({
        source: "BINANCE_USD_M_FUTURES",
        mark_price: "60000.05"
      })
    );
    await app.close();
  });

  it("creates approvals using the trusted operator header", async () => {
    const harness = createHarness();
    const app = createApp(harness.services);

    const response = await app.inject({
      method: "POST",
      url: "/v1/approvals",
      headers: { "x-operator-id": "operator-a" },
      payload: {
        approval_id: APPROVAL_ID,
        action_type: "FORCE_RECONCILIATION",
        target_id: TASK_ID,
        reason: "manual review required"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(harness.mocks.approvalRequest).toHaveBeenCalledWith({
      approvalId: APPROVAL_ID,
      actionType: "FORCE_RECONCILIATION",
      targetId: TASK_ID,
      reason: "manual review required",
      requestedBy: "operator-a"
    });
    await app.close();
  });

  it("rejects approval requests without an operator identity", async () => {
    const harness = createHarness();
    const app = createApp(harness.services);

    const response = await app.inject({
      method: "POST",
      url: "/v1/approvals",
      payload: {
        approval_id: APPROVAL_ID,
        action_type: "FORCE_RECONCILIATION",
        target_id: TASK_ID,
        reason: "manual review required"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "VALIDATION_FAILED"
    );
    await app.close();
  });

  it("maps approval conflicts to HTTP 409", async () => {
    const harness = createHarness();
    harness.mocks.approvalApprove.mockRejectedValue(
      new ConflictError("Task has progressed too far to cancel safely")
    );
    const app = createApp(harness.services);

    const response = await app.inject({
      method: "POST",
      url: `/v1/approvals/${APPROVAL_ID}/approve`,
      headers: { "x-operator-id": "operator-b" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");
    await app.close();
  });

  it("requires the configured service token for protected business routes", async () => {
    const harness = createHarness();
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      SERVICE_AUTH_TOKEN: "service-secret"
    });
    const app = buildServer(
      config,
      createLogger(config, { component: "api-test" }),
      harness.services
    );

    const denied = await app.inject({
      method: "POST",
      url: "/v1/commands",
      payload: { message_id: "message-1" }
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/commands",
      headers: { "x-service-token": "service-secret" },
      payload: { message_id: "message-1" }
    });
    expect(allowed.statusCode).toBe(202);
    await app.close();
  });

  it("reports not ready when MySQL is unavailable", async () => {
    const harness = createHarness();
    harness.mocks.readinessCheck.mockRejectedValue(new Error("mysql unavailable"));
    const app = createApp(harness.services);

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ status: string }>().status).toBe("not_ready");
    await app.close();
  });
});

function createApp(services: ApiServices) {
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "fatal" });
  return buildServer(config, createLogger(config, { component: "api-test" }), services);
}

function createHarness() {
  const task = taskRecord();
  const approval = approvalRecord();
  const commandExecute = vi.fn<ReceiveLiquidationCommand["execute"]>(() =>
    Promise.resolve({ status: "ACCEPTED", messageId: "message-1", task })
  );
  const orderExecute = vi.fn<HandleOrderEvent["execute"]>(() =>
    Promise.resolve({ status: "DUPLICATE", eventId: "order-event-1" })
  );
  const settlementExecute = vi.fn<HandleSettlementEvent["execute"]>(() =>
    Promise.resolve({ status: "DUPLICATE", eventId: "settlement-event-1" })
  );
  const taskFind = vi.fn<TaskReader["findById"]>(() => Promise.resolve(task));
  const marketGet = vi.fn<MarketDataClient["getSnapshot"]>(() =>
    Promise.resolve({
      market: "BTCUSDT",
      bestBid: assertDecimalString("60000"),
      bestAsk: assertDecimalString("60000.1"),
      markPrice: assertDecimalString("60000.05"),
      tickSize: assertDecimalString("0.1"),
      stepSize: assertDecimalString("0.001"),
      observedAt: NOW
    })
  );
  const approvalRequest = vi.fn<OperationApprovals["request"]>(() =>
    Promise.resolve({ status: "CREATED", approval })
  );
  const approvalGet = vi.fn<OperationApprovals["get"]>(() => Promise.resolve(approval));
  const approvalApprove = vi.fn<OperationApprovals["approve"]>(() =>
    Promise.resolve({ status: "EXECUTED", approval: { ...approval, status: "EXECUTED" } })
  );
  const approvalReject = vi.fn<OperationApprovals["reject"]>(() =>
    Promise.resolve({ status: "REJECTED", approval: { ...approval, status: "REJECTED" } })
  );
  const readinessCheck = vi.fn(() => Promise.resolve());
  return {
    services: {
      commands: { execute: commandExecute },
      orderEvents: { execute: orderExecute },
      settlementEvents: { execute: settlementExecute },
      tasks: { findById: taskFind },
      marketData: { getSnapshot: marketGet },
      approvals: {
        request: approvalRequest,
        get: approvalGet,
        approve: approvalApprove,
        reject: approvalReject
      },
      readiness: { check: readinessCheck }
    },
    mocks: { commandExecute, approvalRequest, approvalApprove, readinessCheck }
  };
}

function taskRecord(): TaskRecord {
  return {
    id: TASK_ID,
    inboxMessageId: "message-1",
    correlationId: "correlation-1",
    riskUnitId: "account-1:BTCUSDT",
    commandType: "LIQUIDATE_POSITION",
    status: "READY",
    priority: 100,
    decisionSequence: 9_007_199_254_740_993n,
    fencingToken: 9_007_199_254_740_995n,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    version: 4,
    commandPayload: { quantity: "0.1" },
    createdAt: NOW,
    updatedAt: NOW
  };
}

function approvalRecord(): ApprovalRecord {
  return {
    id: APPROVAL_ID,
    actionType: "FORCE_RECONCILIATION",
    targetId: TASK_ID,
    reason: "manual review required",
    status: "PENDING",
    requestedBy: "operator-a",
    decidedBy: undefined,
    decisionReason: undefined,
    requestedAt: NOW,
    decidedAt: undefined,
    executedAt: undefined
  };
}

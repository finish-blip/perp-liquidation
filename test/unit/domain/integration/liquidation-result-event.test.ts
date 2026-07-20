import { describe, expect, it } from "vitest";

import { liquidationResultEventFromOutbox } from "../../../../src/domain/integration/liquidation-result-event.js";
import { assertEntityId } from "../../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../../src/domain/shared/time.js";

describe("liquidation result event", () => {
  it("converts a terminal Outbox message into the RabbitMQ result contract", () => {
    const event = liquidationResultEventFromOutbox({
      id: assertEntityId("outbox_result_1", "outbox"),
      aggregateType: "LIQUIDATION_TASK",
      aggregateId: "task-1",
      eventType: "LIQUIDATION_EXECUTION_SETTLED",
      payload: {
        risk_decision_id: "risk-1",
        request_event_id: "request-1",
        task_id: "task-1",
        position_id: "position-1",
        position_version: "2",
        status: "COMPLETED",
        requested_size: "0.1",
        executed_size: "0.1",
        average_price: null,
        remaining_size: "0",
        error_code: null,
        error_message: null
      },
      status: "PUBLISHING",
      attempts: 0,
      nextAttemptAt: assertUtcIsoString("2026-07-19T12:26:43.000Z"),
      lockedBy: "worker-1",
      lockedUntil: undefined,
      publishedAt: undefined,
      lastError: undefined
    });

    expect(event).toEqual({
      eventId: "outbox_result_1",
      eventType: "liquidation.execution.result.v1",
      eventVersion: 1,
      occurredAt: "2026-07-19T12:26:43.000Z",
      producer: "liquidation-service",
      data: {
        riskDecisionId: "risk-1",
        requestEventId: "request-1",
        taskId: "task-1",
        positionId: "position-1",
        positionVersion: "2",
        status: "COMPLETED",
        requestedSize: "0.1",
        executedSize: "0.1",
        averagePrice: null,
        remainingSize: "0",
        errorCode: null,
        errorMessage: null
      }
    });
  });
});

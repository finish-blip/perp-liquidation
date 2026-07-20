import { describe, expect, it, vi } from "vitest";

import { ReceiveRiskLiquidationEvent } from "../../../src/application/receive-risk-liquidation-event.js";
import type { ReceiveLiquidationCommand } from "../../../src/application/receive-liquidation-command.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";

const NOW = assertUtcIsoString("2026-07-19T12:26:45.000Z");

describe("ReceiveRiskLiquidationEvent", () => {
  it("passes a mapped command to the existing command receiver", async () => {
    const execute = vi.fn<ReceiveLiquidationCommand["execute"]>(() =>
      Promise.resolve({ status: "DUPLICATE" as const, messageId: "event-1", existingTaskId: undefined })
    );
    const receiver = new ReceiveRiskLiquidationEvent({ execute });

    const result = await receiver.execute({ payload: validEvent(), receivedAt: NOW });

    expect(result.outcome.status).toBe("DUPLICATE");
    const call = execute.mock.calls[0]?.[0];
    expect(call?.source).toBe("risk-control-service");
    expect(call?.receivedAt).toBe(NOW);
    expect(call?.payload).toEqual(
      expect.objectContaining({
        message_id: "event-1",
        side: "SELL",
        quantity: "0.1"
      })
    );
  });

  it("acknowledges an expired business event without creating an internal task", async () => {
    const execute = vi.fn();
    const receiver = new ReceiveRiskLiquidationEvent({ execute });

    const result = await receiver.execute({
      payload: { ...validEvent(), data: { ...validEvent().data, expireAt: NOW } },
      receivedAt: NOW
    });

    expect(result.outcome).toEqual({
      status: "EXPIRED",
      eventId: "event-1",
      riskDecisionId: "risk-1"
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

function validEvent() {
  return {
    eventId: "event-1",
    eventType: "risk.liquidation.requested.v1",
    eventVersion: 1,
    occurredAt: "2026-07-19T12:26:40.000Z",
    producer: "risk-control-service",
    data: {
      riskDecisionId: "risk-1",
      decisionSequence: "1",
      riskUnitId: "account-1:BTCUSDT",
      userId: "user-1",
      accountId: "account-1",
      positionId: "position-1",
      symbol: "BTCUSDT",
      positionSide: "LONG",
      positionVersion: "1",
      riskLevel: "LIQUIDATION_REQUIRED",
      triggerReason: "EQUITY_NON_POSITIVE",
      riskSnapshot: {},
      executionInstruction: {
        action: "LIQUIDATE_POSITION",
        mode: "FULL_LIQUIDATION",
        targetReduceSize: "0.1",
        orderType: "MARKET",
        reduceOnly: true
      },
      expireAt: "2026-07-19T12:27:45.000Z"
    }
  };
}

import { describe, expect, it } from "vitest";

import {
  mapRiskLiquidationEventToCommand,
  parseRiskLiquidationRequestedV1
} from "../../../../src/domain/integration/risk-liquidation-event.js";

describe("risk liquidation event integration", () => {
  it("maps the documented v1 event into the internal liquidation command", () => {
    const event = parseRiskLiquidationRequestedV1(validEvent());
    const mapped = mapRiskLiquidationEventToCommand(event);

    expect(mapped).toEqual({
      source: "risk-system",
      payload: {
        message_id: "liquidation:pos_001:1",
        correlation_id: "risk_20260719122640_e58c112ed861",
        command_type: "LIQUIDATE_POSITION",
        decision_sequence: "1",
        risk_unit_id: "acc_001:BTCUSDT",
        account_id: "acc_001",
        position_id: "pos_001",
        position_version: "1",
        market: "BTCUSDT",
        side: "SELL",
        quantity: "0.1",
        quantity_mode: "UP_TO",
        strategy: "STATIC",
        expires_at: "2026-07-19T12:27:45.305Z",
        max_slippage_bps: 50
      },
      usedDerivedDecisionSequence: true,
      usedDerivedRiskUnitId: true
    });
  });

  it("uses explicit sequencing fields and maps SHORT to a BUY reduce order", () => {
    const event = parseRiskLiquidationRequestedV1({
      ...validEvent(),
      data: {
        ...validEvent().data,
        decisionSequence: "42",
        riskUnitId: "risk-unit-42",
        positionSide: "SHORT",
        positionVersion: "12",
        executionInstruction: {
          ...validEvent().data.executionInstruction,
          maxSlippage: undefined,
          maxSlippageBps: 25
        }
      }
    });
    const mapped = mapRiskLiquidationEventToCommand(event);

    expect(mapped.payload).toEqual(
      expect.objectContaining({
        decision_sequence: "42",
        risk_unit_id: "risk-unit-42",
        position_version: "12",
        side: "BUY",
        max_slippage_bps: 25
      })
    );
    expect(mapped.usedDerivedDecisionSequence).toBe(false);
    expect(mapped.usedDerivedRiskUnitId).toBe(false);
  });

  it("rejects an instruction whose target exceeds its maximum", () => {
    const event = parseRiskLiquidationRequestedV1({
      ...validEvent(),
      data: {
        ...validEvent().data,
        executionInstruction: {
          ...validEvent().data.executionInstruction,
          targetReduceSize: "0.2",
          maxReduceSize: "0.1"
        }
      }
    });

    expect(() => mapRiskLiquidationEventToCommand(event)).toThrow(/exceeds maxReduceSize/);
  });
});

function validEvent() {
  return {
    eventId: "liquidation:pos_001:1",
    eventType: "risk.liquidation.requested.v1" as const,
    eventVersion: 1 as const,
    occurredAt: "2026-07-19T12:26:41.466Z",
    producer: "risk-control-service" as const,
    data: {
      riskDecisionId: "risk_20260719122640_e58c112ed861",
      source: "risk-system",
      userId: "user_001",
      accountId: "acc_001",
      positionId: "pos_001",
      symbol: "BTCUSDT",
      positionSide: "LONG" as const,
      positionVersion: 1,
      riskLevel: "LIQUIDATION_REQUIRED" as const,
      triggerReason: "EQUITY_NON_POSITIVE",
      riskSnapshot: {},
      executionInstruction: {
        action: "LIQUIDATE_POSITION" as const,
        mode: "FULL_LIQUIDATION" as const,
        targetReduceSize: "0.1",
        maxReduceSize: "0.1",
        orderType: "MARKET" as const,
        reduceOnly: true as const,
        maxSlippage: "0.005",
        timeInForce: "IOC"
      },
      expireAt: "2026-07-19T12:27:45.305Z"
    }
  };
}

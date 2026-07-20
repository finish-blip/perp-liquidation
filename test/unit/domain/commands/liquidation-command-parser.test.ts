import { describe, expect, it } from "vitest";

import {
  liquidationCommandToPayload,
  parseLiquidationCommand,
  type LiquidationCommandPayload
} from "../../../../src/domain/commands/liquidation-command-parser.js";
import { ValidationError } from "../../../../src/domain/shared/errors.js";

describe("liquidation command parser", () => {
  it("parses the wire contract without losing decision sequence precision", () => {
    const payload = validPayload({
      decision_sequence: "18446744073709551615",
      quantity: "1.2300"
    });

    const command = parseLiquidationCommand(payload);

    expect(command.decisionSequence).toBe(18_446_744_073_709_551_615n);
    expect(command.quantity).toBe("1.23");
    expect(liquidationCommandToPayload(command)).toEqual({
      ...payload,
      quantity: "1.23"
    });
  });

  it.each([
    ["zero quantity", validPayload({ quantity: "0" })],
    ["exponential quantity", validPayload({ quantity: "1e-8" })],
    ["zero sequence", validPayload({ decision_sequence: "0" })],
    ["unsafe sequence", validPayload({ decision_sequence: "18446744073709551616" })],
    ["non-UTC expiry", validPayload({ expires_at: "2026-07-18T03:00:00+00:00" })]
  ])("rejects %s", (_name, payload) => {
    expect(() => parseLiquidationCommand(payload)).toThrow(ValidationError);
  });

  it("rejects properties that are not part of the command contract", () => {
    expect(() =>
      parseLiquidationCommand({
        ...validPayload(),
        injected: true
      })
    ).toThrow(ValidationError);
  });
});

function validPayload(
  overrides: Partial<LiquidationCommandPayload> = {}
): LiquidationCommandPayload {
  return {
    message_id: "message-1",
    correlation_id: "correlation-1",
    command_type: "LIQUIDATE_POSITION",
    decision_sequence: "42",
    risk_unit_id: "account-1:BTCUSDT",
    account_id: "account-1",
    position_id: "position-1",
    position_version: "12",
    market: "BTCUSDT",
    side: "SELL",
    quantity: "0.25",
    quantity_mode: "UP_TO",
    strategy: "STATIC",
    expires_at: "2026-07-18T03:00:00.000Z",
    ...overrides
  };
}

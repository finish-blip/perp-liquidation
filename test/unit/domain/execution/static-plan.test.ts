import { describe, expect, it } from "vitest";

import { parseLiquidationCommand } from "../../../../src/domain/commands/liquidation-command-parser.js";
import { parseMarketSnapshot } from "../../../../src/domain/execution/market-snapshot.js";
import { buildStaticExecutionPlan } from "../../../../src/domain/execution/static-plan.js";
import { parsePositionSnapshot } from "../../../../src/domain/portfolio/position-snapshot.js";
import { ValidationError } from "../../../../src/domain/shared/errors.js";
import { assertUtcIsoString } from "../../../../src/domain/shared/time.js";

const NOW = assertUtcIsoString("2026-07-18T03:00:00.000Z");
const OPTIONS = {
  maxMarketAgeMs: 2000,
  maxFutureSkewMs: 100,
  maxPriceDeviationBps: 500,
  maxSlippageBps: 100,
  maxOrderQuantity: "1",
  maxSteps: 32
} as const;

describe("STATIC execution planner", () => {
  it("caps UP_TO quantity and quantizes down to stepSize", () => {
    const plan = buildStaticExecutionPlan({
      command: command(),
      position: position({ reducible_quantity: "0.237" }),
      market: market(),
      now: NOW,
      options: OPTIONS
    });

    expect(plan.quantity).toBe("0.23");
    expect(plan.limitPrice).toBe("99");
    expect(plan.reduceOnly).toBe(true);
  });

  it("splits a STATIC quantity into at most the configured per-order amount", () => {
    const plan = buildStaticExecutionPlan({
      command: command({ quantity: "0.25" }),
      position: position(),
      market: market(),
      now: NOW,
      options: { ...OPTIONS, maxOrderQuantity: "0.1" }
    });

    expect(plan.stepQuantities).toEqual(["0.1", "0.1", "0.05"]);
    expect(plan.quantity).toBe("0.1");
  });

  it("rejects an EXACT quantity that is not step-aligned", () => {
    expect(() =>
      buildStaticExecutionPlan({
        command: command({ quantity: "0.235", quantity_mode: "EXACT" }),
        position: position(),
        market: market(),
        now: NOW,
        options: OPTIONS
      })
    ).toThrow(ValidationError);
  });

  it("does not place a SELL limit below the long bankruptcy price", () => {
    const plan = buildStaticExecutionPlan({
      command: command(),
      position: position({ bankruptcy_price: "80.03" }),
      market: market(),
      now: NOW,
      options: { ...OPTIONS, maxSlippageBps: 5000 }
    });

    expect(plan.limitPrice).toBe("80.1");
  });

  it("does not place a BUY limit above the short bankruptcy price", () => {
    const plan = buildStaticExecutionPlan({
      command: command({ side: "BUY" }),
      position: position({ side: "SHORT", bankruptcy_price: "120.07" }),
      market: market(),
      now: NOW,
      options: { ...OPTIONS, maxSlippageBps: 5000 }
    });

    expect(plan.limitPrice).toBe("120");
  });

  it("rejects changed position versions and stale market snapshots", () => {
    expect(() =>
      buildStaticExecutionPlan({
        command: command(),
        position: position({ version: "13" }),
        market: market(),
        now: NOW,
        options: OPTIONS
      })
    ).toThrow(/Position version changed/);

    expect(() =>
      buildStaticExecutionPlan({
        command: command(),
        position: position(),
        market: market({ observed_at: "2026-07-18T02:59:57.000Z" }),
        now: NOW,
        options: OPTIONS
      })
    ).toThrow(/freshness window/);
  });

  it("rejects an order side that would increase the position", () => {
    expect(() =>
      buildStaticExecutionPlan({
        command: command({ side: "BUY" }),
        position: position({ side: "LONG" }),
        market: market(),
        now: NOW,
        options: OPTIONS
      })
    ).toThrow(/increase rather than reduce/);
  });
});

function command(overrides: Record<string, unknown> = {}) {
  return parseLiquidationCommand({
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
    expires_at: "2026-07-18T03:05:00.000Z",
    ...overrides
  });
}

function position(overrides: Record<string, unknown> = {}) {
  return parsePositionSnapshot({
    position_id: "position-1",
    account_id: "account-1",
    risk_unit_id: "account-1:BTCUSDT",
    market: "BTCUSDT",
    side: "LONG",
    version: "12",
    quantity: "1",
    reducible_quantity: "1",
    bankruptcy_price: "80",
    ...overrides
  });
}

function market(overrides: Record<string, unknown> = {}) {
  return parseMarketSnapshot({
    market: "BTCUSDT",
    best_bid: "100",
    best_ask: "100.2",
    mark_price: "100",
    tick_size: "0.1",
    step_size: "0.01",
    observed_at: "2026-07-18T02:59:59.500Z",
    ...overrides
  });
}

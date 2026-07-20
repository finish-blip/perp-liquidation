import { describe, expect, it, vi } from "vitest";

import type { HandleOrderEvent } from "../../../src/application/handle-order-event.js";
import type { HandleSettlementEvent } from "../../../src/application/handle-settlement-event.js";
import type { ReceiveLiquidationCommand } from "../../../src/application/receive-liquidation-command.js";
import {
  LiquidationCommandStreamHandler,
  OrderEventStreamHandler,
  SettlementEventStreamHandler
} from "../../../src/application/stream-message-handlers.js";

const CONTEXT = {
  messageId: "1710000000000-0",
  fields: { payload: "{}", source: "risk-stream" },
  deliveryCount: 1,
  reclaimed: false
} as const;

describe("stream message handlers", () => {
  it("routes commands through Inbox intake with the stream source", async () => {
    const execute = vi.fn<ReceiveLiquidationCommand["execute"]>(() =>
      Promise.resolve({
        status: "DUPLICATE",
        messageId: "message-1",
        existingTaskId: undefined
      })
    );
    const handler = new LiquidationCommandStreamHandler({ execute }, "redis-stream");
    const payload = { message_id: "message-1" };

    await handler.handle(payload, CONTEXT);

    expect(execute).toHaveBeenCalledWith({ source: "risk-stream", payload });
  });

  it("routes order and settlement payloads through their idempotent handlers", async () => {
    const orderExecute = vi.fn<HandleOrderEvent["execute"]>(() =>
      Promise.resolve({ status: "DUPLICATE", eventId: "order-event-1" })
    );
    const settlementExecute = vi.fn<HandleSettlementEvent["execute"]>(() =>
      Promise.resolve({ status: "DUPLICATE", eventId: "settlement-event-1" })
    );
    const orderHandler = new OrderEventStreamHandler({ execute: orderExecute });
    const settlementHandler = new SettlementEventStreamHandler({
      execute: settlementExecute
    });
    const orderPayload = { event_id: "order-event-1" };
    const settlementPayload = { event_id: "settlement-event-1" };

    await orderHandler.handle(orderPayload);
    await settlementHandler.handle(settlementPayload);

    expect(orderExecute).toHaveBeenCalledWith(orderPayload);
    expect(settlementExecute).toHaveBeenCalledWith(settlementPayload);
  });
});

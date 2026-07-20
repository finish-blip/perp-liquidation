import type { HandleOrderEvent } from "./handle-order-event.js";
import type { HandleSettlementEvent } from "./handle-settlement-event.js";
import type { ReceiveLiquidationCommand } from "./receive-liquidation-command.js";
import type {
  StreamMessageContext,
  StreamMessageHandler
} from "./consume-stream.js";

export class LiquidationCommandStreamHandler implements StreamMessageHandler {
  constructor(
    private readonly receiver: Pick<ReceiveLiquidationCommand, "execute">,
    private readonly defaultSource: string
  ) {}

  async handle(payload: unknown, context: StreamMessageContext): Promise<void> {
    await this.receiver.execute({
      source: context.fields.source ?? this.defaultSource,
      payload
    });
  }
}

export class OrderEventStreamHandler implements StreamMessageHandler {
  constructor(private readonly handler: Pick<HandleOrderEvent, "execute">) {}

  async handle(payload: unknown): Promise<void> {
    await this.handler.execute(payload);
  }
}

export class SettlementEventStreamHandler implements StreamMessageHandler {
  constructor(private readonly handler: Pick<HandleSettlementEvent, "execute">) {}

  async handle(payload: unknown): Promise<void> {
    await this.handler.execute(payload);
  }
}

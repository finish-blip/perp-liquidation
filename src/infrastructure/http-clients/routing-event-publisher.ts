import type { EventPublisher } from "../../application/ports/event-publisher.js";
import { isLiquidationResultMessage } from "../../domain/integration/liquidation-result-event.js";

export class RoutingEventPublisher implements EventPublisher {
  constructor(
    private readonly internalPublisher: EventPublisher,
    private readonly liquidationResultPublisher: EventPublisher
  ) {}

  publish(
    message: Parameters<EventPublisher["publish"]>[0],
    signal: AbortSignal | undefined
  ): Promise<void> {
    return isLiquidationResultMessage(message)
      ? this.liquidationResultPublisher.publish(message, signal)
      : this.internalPublisher.publish(message, signal);
  }
}

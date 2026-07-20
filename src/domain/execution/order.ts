import type { OrderSide } from "../commands/liquidation-command.js";
import type { DecimalString } from "../shared/decimal.js";
import type { ClientOrderId } from "../shared/id.js";
import type { UtcIsoString } from "../shared/time.js";
import type { OrderEventType } from "./order-event.js";

export type PlaceReduceOnlyOrderRequest = {
  readonly clientOrderId: ClientOrderId;
  readonly correlationId: string;
  readonly accountId: string;
  readonly positionId: string;
  readonly market: string;
  readonly side: OrderSide;
  readonly quantity: DecimalString;
  readonly limitPrice: DecimalString;
  readonly reduceOnly: true;
  readonly timeInForce: "IOC";
  readonly fencingToken: bigint;
};

export type PlaceOrderResult =
  | {
      readonly accepted: true;
      readonly exchangeOrderId: string;
    }
  | {
      readonly accepted: false;
      readonly reason: string;
    };

export type OrderLookupResult =
  | {
      readonly found: false;
    }
  | {
      readonly found: true;
      readonly exchangeOrderId: string;
      readonly eventSequence: bigint;
      readonly eventType: OrderEventType;
      readonly cumulativeFilledQuantity: DecimalString;
      readonly occurredAt: UtcIsoString;
    };

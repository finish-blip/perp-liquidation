import { Ajv2020 } from "ajv/dist/2020.js";

import orderEventSchema from "../../../contracts/json-schema/order-event.schema.json" with {
  type: "json"
};
import { assertNonNegativeDecimal, type DecimalString } from "../shared/decimal.js";
import { ValidationError } from "../shared/errors.js";
import { assertEntityId, type ClientOrderId } from "../shared/id.js";
import { assertUtcIsoString, type UtcIsoString } from "../shared/time.js";

export type OrderEventType =
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "CANCELLED";

export type OrderEvent = {
  readonly eventId: string;
  readonly correlationId: string;
  readonly clientOrderId: ClientOrderId;
  readonly exchangeOrderId: string;
  readonly eventSequence: bigint;
  readonly eventType: OrderEventType;
  readonly cumulativeFilledQuantity: DecimalString;
  readonly occurredAt: UtcIsoString;
};

type OrderEventPayload = {
  readonly event_id: string;
  readonly correlation_id: string;
  readonly client_order_id: string;
  readonly exchange_order_id: string;
  readonly event_sequence: string;
  readonly event_type: OrderEventType;
  readonly cumulative_filled_quantity: string;
  readonly occurred_at: string;
};

const ajv = createAjv();
const validate = ajv.compile<OrderEventPayload>(orderEventSchema);

export function parseOrderEvent(input: unknown): OrderEvent {
  if (!validate(input)) {
    throw new ValidationError("Order event does not match its contract", {
      errors: validate.errors ?? []
    });
  }

  return {
    eventId: input.event_id,
    correlationId: input.correlation_id,
    clientOrderId: assertEntityId(input.client_order_id, "coid"),
    exchangeOrderId: input.exchange_order_id,
    eventSequence: parseUnsignedBigInt(input.event_sequence, "event_sequence"),
    eventType: input.event_type,
    cumulativeFilledQuantity: assertNonNegativeDecimal(
      input.cumulative_filled_quantity,
      "cumulative_filled_quantity"
    ),
    occurredAt: assertUtcIsoString(input.occurred_at, "occurred_at")
  };
}

export function orderEventToPayload(event: OrderEvent): Record<string, unknown> {
  return {
    event_id: event.eventId,
    correlation_id: event.correlationId,
    client_order_id: event.clientOrderId,
    exchange_order_id: event.exchangeOrderId,
    event_sequence: event.eventSequence.toString(),
    event_type: event.eventType,
    cumulative_filled_quantity: event.cumulativeFilledQuantity,
    occurred_at: event.occurredAt
  };
}

function createAjv(): Ajv2020 {
  const instance = new Ajv2020({ allErrors: true, strict: true });
  instance.addFormat("date-time", {
    type: "string",
    validate: (value: string) => {
      try {
        assertUtcIsoString(value);
        return true;
      } catch {
        return false;
      }
    }
  });
  return instance;
}

function parseUnsignedBigInt(value: string, field: string): bigint {
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new ValidationError(`${field} exceeds MySQL UNSIGNED BIGINT`);
  }
  return parsed;
}

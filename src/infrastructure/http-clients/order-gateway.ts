import { Ajv2020 } from "ajv/dist/2020.js";

import placeOrderResponseSchema from "../../../contracts/json-schema/place-order-response.schema.json" with {
  type: "json"
};
import orderQueryResponseSchema from "../../../contracts/json-schema/order-query-response.schema.json" with {
  type: "json"
};
import type { OrderGateway } from "../../application/ports/order-gateway.js";
import type {
  OrderLookupResult,
  PlaceOrderResult
} from "../../domain/execution/order.js";
import type { OrderEventType } from "../../domain/execution/order-event.js";
import { assertNonNegativeDecimal } from "../../domain/shared/decimal.js";
import { ExternalFatalError } from "../../domain/shared/errors.js";
import { assertUtcIsoString } from "../../domain/shared/time.js";
import type { JsonHttpTransport } from "./json-http-transport.js";

type PlaceOrderResponsePayload =
  | {
      readonly accepted: true;
      readonly exchange_order_id: string;
    }
  | {
      readonly accepted: false;
      readonly reason: string;
    };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile<PlaceOrderResponsePayload>(placeOrderResponseSchema);

type OrderQueryResponsePayload =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly exchange_order_id: string;
      readonly event_sequence: string;
      readonly event_type: OrderEventType;
      readonly cumulative_filled_quantity: string;
      readonly occurred_at: string;
    };

const queryAjv = new Ajv2020({ allErrors: true, strict: true });
queryAjv.addFormat("date-time", {
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
const validateQuery = queryAjv.compile<OrderQueryResponsePayload>(
  orderQueryResponseSchema
);
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

export class HttpOrderGateway implements OrderGateway {
  constructor(private readonly transport: JsonHttpTransport) {}

  async placeReduceOnly(
    input: Parameters<OrderGateway["placeReduceOnly"]>[0]
  ): ReturnType<OrderGateway["placeReduceOnly"]> {
    const order = input.order;
    const payload = await this.transport.send({
      method: "POST",
      path: "/v1/orders",
      correlationId: order.correlationId,
      body: {
        client_order_id: order.clientOrderId,
        account_id: order.accountId,
        position_id: order.positionId,
        market: order.market,
        side: order.side,
        quantity: order.quantity,
        limit_price: order.limitPrice,
        reduce_only: order.reduceOnly,
        time_in_force: order.timeInForce,
        fencing_token: order.fencingToken.toString()
      },
      signal: input.signal
    });

    if (!validate(payload)) {
      throw new ExternalFatalError("Order gateway response does not match its contract", {
        errors: validate.errors ?? []
      });
    }

    return toOrderResult(payload);
  }

  async getByClientOrderId(
    input: Parameters<OrderGateway["getByClientOrderId"]>[0]
  ): ReturnType<OrderGateway["getByClientOrderId"]> {
    const payload = await this.transport.send({
      method: "GET",
      path: `/v1/orders/by-client-id/${encodeURIComponent(input.clientOrderId)}`,
      correlationId: input.correlationId,
      signal: input.signal
    });
    if (!validateQuery(payload)) {
      throw new ExternalFatalError("Order query response does not match its contract", {
        errors: validateQuery.errors ?? []
      });
    }
    return toLookupResult(payload);
  }
}

function toOrderResult(payload: PlaceOrderResponsePayload): PlaceOrderResult {
  return payload.accepted
    ? { accepted: true, exchangeOrderId: payload.exchange_order_id }
    : { accepted: false, reason: payload.reason };
}

function toLookupResult(payload: OrderQueryResponsePayload): OrderLookupResult {
  if (!payload.found) {
    return { found: false };
  }
  const eventSequence = BigInt(payload.event_sequence);
  if (eventSequence > MAX_UNSIGNED_BIGINT) {
    throw new ExternalFatalError(
      "Order query event_sequence exceeds MySQL UNSIGNED BIGINT"
    );
  }
  return {
    found: true,
    exchangeOrderId: payload.exchange_order_id,
    eventSequence,
    eventType: payload.event_type,
    cumulativeFilledQuantity: assertNonNegativeDecimal(
      payload.cumulative_filled_quantity,
      "cumulative_filled_quantity"
    ),
    occurredAt: assertUtcIsoString(payload.occurred_at, "occurred_at")
  };
}

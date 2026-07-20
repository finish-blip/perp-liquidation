import type {
  OrderLookupResult,
  PlaceOrderResult,
  PlaceReduceOnlyOrderRequest
} from "../../domain/execution/order.js";

export type PlaceOrderInput = {
  readonly order: PlaceReduceOnlyOrderRequest;
  readonly signal: AbortSignal | undefined;
};

export type OrderGateway = {
  placeReduceOnly(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  getByClientOrderId(input: {
    readonly clientOrderId: PlaceReduceOnlyOrderRequest["clientOrderId"];
    readonly correlationId: string;
    readonly signal: AbortSignal | undefined;
  }): Promise<OrderLookupResult>;
};

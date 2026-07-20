import { Ajv2020 } from "ajv/dist/2020.js";

import settlementEventSchema from "../../../contracts/json-schema/settlement-event.schema.json" with {
  type: "json"
};
import { assertPositiveDecimal, type DecimalString } from "../shared/decimal.js";
import { ValidationError } from "../shared/errors.js";
import { assertEntityId, type ClientOrderId } from "../shared/id.js";
import { assertUtcIsoString, type UtcIsoString } from "../shared/time.js";

export type SettlementEvent = {
  readonly eventId: string;
  readonly correlationId: string;
  readonly clientOrderId: ClientOrderId;
  readonly exchangeOrderId: string;
  readonly settlementSequence: bigint;
  readonly positionId: string;
  readonly previousPositionVersion: bigint;
  readonly newPositionVersion: bigint;
  readonly settledQuantity: DecimalString;
  readonly occurredAt: UtcIsoString;
};

type SettlementEventPayload = {
  readonly event_id: string;
  readonly correlation_id: string;
  readonly client_order_id: string;
  readonly exchange_order_id: string;
  readonly settlement_sequence: string;
  readonly position_id: string;
  readonly previous_position_version: string;
  readonly new_position_version: string;
  readonly settled_quantity: string;
  readonly occurred_at: string;
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
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
const validate = ajv.compile<SettlementEventPayload>(settlementEventSchema);

export function parseSettlementEvent(input: unknown): SettlementEvent {
  if (!validate(input)) {
    throw new ValidationError("Settlement event does not match its contract", {
      errors: validate.errors ?? []
    });
  }

  const previousPositionVersion = parseUnsignedBigInt(
    input.previous_position_version,
    "previous_position_version"
  );
  const newPositionVersion = parseUnsignedBigInt(
    input.new_position_version,
    "new_position_version"
  );
  if (newPositionVersion <= previousPositionVersion) {
    throw new ValidationError("new_position_version must advance after settlement");
  }

  return {
    eventId: input.event_id,
    correlationId: input.correlation_id,
    clientOrderId: assertEntityId(input.client_order_id, "coid"),
    exchangeOrderId: input.exchange_order_id,
    settlementSequence: parseUnsignedBigInt(
      input.settlement_sequence,
      "settlement_sequence"
    ),
    positionId: input.position_id,
    previousPositionVersion,
    newPositionVersion,
    settledQuantity: assertPositiveDecimal(input.settled_quantity, "settled_quantity"),
    occurredAt: assertUtcIsoString(input.occurred_at, "occurred_at")
  };
}

export function settlementEventToPayload(event: SettlementEvent): Record<string, unknown> {
  return {
    event_id: event.eventId,
    correlation_id: event.correlationId,
    client_order_id: event.clientOrderId,
    exchange_order_id: event.exchangeOrderId,
    settlement_sequence: event.settlementSequence.toString(),
    position_id: event.positionId,
    previous_position_version: event.previousPositionVersion.toString(),
    new_position_version: event.newPositionVersion.toString(),
    settled_quantity: event.settledQuantity,
    occurred_at: event.occurredAt
  };
}

function parseUnsignedBigInt(value: string, field: string): bigint {
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new ValidationError(`${field} exceeds MySQL UNSIGNED BIGINT`);
  }
  return parsed;
}

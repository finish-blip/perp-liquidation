import { Ajv2020 } from "ajv/dist/2020.js";

import positionSnapshotSchema from "../../../contracts/json-schema/position-snapshot.schema.json" with {
  type: "json"
};
import {
  assertNonNegativeDecimal,
  assertPositiveDecimal,
  compareDecimal,
  type DecimalString
} from "../shared/decimal.js";
import { ValidationError } from "../shared/errors.js";

export type PositionSide = "LONG" | "SHORT";

export type PositionSnapshot = {
  readonly positionId: string;
  readonly accountId: string;
  readonly riskUnitId: string;
  readonly market: string;
  readonly side: PositionSide;
  readonly version: bigint;
  readonly quantity: DecimalString;
  readonly reducibleQuantity: DecimalString;
  readonly bankruptcyPrice: DecimalString;
};

type PositionSnapshotPayload = {
  readonly position_id: string;
  readonly account_id: string;
  readonly risk_unit_id: string;
  readonly market: string;
  readonly side: PositionSide;
  readonly version: string;
  readonly quantity: string;
  readonly reducible_quantity: string;
  readonly bankruptcy_price: string;
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile<PositionSnapshotPayload>(positionSnapshotSchema);
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

export function parsePositionSnapshot(input: unknown): PositionSnapshot {
  if (!validate(input)) {
    throw new ValidationError("Position snapshot does not match its contract", {
      errors: validate.errors ?? []
    });
  }

  const quantity = assertNonNegativeDecimal(input.quantity, "position.quantity");
  const reducibleQuantity = assertNonNegativeDecimal(
    input.reducible_quantity,
    "position.reducible_quantity"
  );
  if (compareDecimal(reducibleQuantity, quantity) > 0) {
    throw new ValidationError("Reducible quantity exceeds position quantity");
  }
  const version = BigInt(input.version);
  if (version > MAX_UNSIGNED_BIGINT) {
    throw new ValidationError("Position version exceeds MySQL UNSIGNED BIGINT");
  }

  return {
    positionId: input.position_id,
    accountId: input.account_id,
    riskUnitId: input.risk_unit_id,
    market: input.market,
    side: input.side,
    version,
    quantity,
    reducibleQuantity,
    bankruptcyPrice: assertPositiveDecimal(
      input.bankruptcy_price,
      "position.bankruptcy_price"
    )
  };
}

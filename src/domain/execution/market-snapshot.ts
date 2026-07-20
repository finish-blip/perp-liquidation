import { Ajv2020 } from "ajv/dist/2020.js";

import marketSnapshotSchema from "../../../contracts/json-schema/market-snapshot.schema.json" with {
  type: "json"
};
import { assertPositiveDecimal, type DecimalString } from "../shared/decimal.js";
import { ValidationError } from "../shared/errors.js";
import { assertUtcIsoString, type UtcIsoString } from "../shared/time.js";

export type MarketSnapshot = {
  readonly market: string;
  readonly bestBid: DecimalString;
  readonly bestAsk: DecimalString;
  readonly markPrice: DecimalString;
  readonly tickSize: DecimalString;
  readonly stepSize: DecimalString;
  readonly observedAt: UtcIsoString;
};

type MarketSnapshotPayload = {
  readonly market: string;
  readonly best_bid: string;
  readonly best_ask: string;
  readonly mark_price: string;
  readonly tick_size: string;
  readonly step_size: string;
  readonly observed_at: string;
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
const validate = ajv.compile<MarketSnapshotPayload>(marketSnapshotSchema);

export function parseMarketSnapshot(input: unknown): MarketSnapshot {
  if (!validate(input)) {
    throw new ValidationError("Market snapshot does not match its contract", {
      errors: validate.errors ?? []
    });
  }

  return {
    market: input.market,
    bestBid: assertPositiveDecimal(input.best_bid, "market.best_bid"),
    bestAsk: assertPositiveDecimal(input.best_ask, "market.best_ask"),
    markPrice: assertPositiveDecimal(input.mark_price, "market.mark_price"),
    tickSize: assertPositiveDecimal(input.tick_size, "market.tick_size"),
    stepSize: assertPositiveDecimal(input.step_size, "market.step_size"),
    observedAt: assertUtcIsoString(input.observed_at, "market.observed_at")
  };
}

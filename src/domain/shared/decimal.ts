import { Decimal } from "decimal.js";

import { ValidationError } from "./errors.js";

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40
});

export type DecimalString = string & {
  readonly __decimalStringBrand: unique symbol;
};

export type DecimalInput = string | Decimal;

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function assertDecimalString(value: string, field = "decimal"): DecimalString {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new ValidationError(`${field} must be a finite decimal string`, { value });
  }

  const parsed = new Decimal(value);
  if (!parsed.isFinite()) {
    throw new ValidationError(`${field} must be finite`, { value });
  }

  return value as DecimalString;
}

export function toDecimal(value: DecimalInput, field = "decimal"): Decimal {
  if (value instanceof Decimal) {
    if (!value.isFinite()) {
      throw new ValidationError(`${field} must be finite`, { value: value.toString() });
    }

    return value;
  }

  return new Decimal(assertDecimalString(value, field));
}

export function decimalToString(value: DecimalInput, field = "decimal"): DecimalString {
  return toDecimal(value, field).toFixed() as DecimalString;
}

export function addDecimal(a: DecimalInput, b: DecimalInput): DecimalString {
  return toDecimal(a, "left operand").plus(toDecimal(b, "right operand")).toFixed() as DecimalString;
}

export function subtractDecimal(a: DecimalInput, b: DecimalInput): DecimalString {
  return toDecimal(a, "left operand").minus(toDecimal(b, "right operand")).toFixed() as DecimalString;
}

export function compareDecimal(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  const comparison = toDecimal(a, "left operand").cmp(toDecimal(b, "right operand"));

  if (comparison < 0) {
    return -1;
  }

  if (comparison > 0) {
    return 1;
  }

  return 0;
}

export function assertNonNegativeDecimal(value: DecimalInput, field = "decimal"): DecimalString {
  const parsed = toDecimal(value, field);
  if (parsed.isNegative()) {
    throw new ValidationError(`${field} must be non-negative`, { value: parsed.toFixed() });
  }

  return parsed.toFixed() as DecimalString;
}

export function assertPositiveDecimal(value: DecimalInput, field = "decimal"): DecimalString {
  const parsed = toDecimal(value, field);
  if (parsed.lte(0)) {
    throw new ValidationError(`${field} must be positive`, { value: parsed.toFixed() });
  }

  return parsed.toFixed() as DecimalString;
}

export function minDecimal(a: DecimalInput, b: DecimalInput): DecimalString {
  return Decimal.min(toDecimal(a, "left operand"), toDecimal(b, "right operand")).toFixed() as DecimalString;
}

export function maxDecimal(a: DecimalInput, b: DecimalInput): DecimalString {
  return Decimal.max(toDecimal(a, "left operand"), toDecimal(b, "right operand")).toFixed() as DecimalString;
}

export function quantizeDownToStep(quantity: DecimalInput, stepSize: DecimalInput): DecimalString {
  const step = toDecimal(stepSize, "stepSize");
  if (step.lte(0)) {
    throw new ValidationError("stepSize must be positive", { stepSize: step.toFixed() });
  }

  const rawQuantity = assertNonNegativeDecimal(quantity, "quantity");
  return toDecimal(rawQuantity, "quantity").div(step).floor().mul(step).toFixed() as DecimalString;
}

export function quantizeUpToStep(quantity: DecimalInput, stepSize: DecimalInput): DecimalString {
  const step = toDecimal(stepSize, "stepSize");
  if (step.lte(0)) {
    throw new ValidationError("stepSize must be positive", { stepSize: step.toFixed() });
  }

  const rawQuantity = assertNonNegativeDecimal(quantity, "quantity");
  return toDecimal(rawQuantity, "quantity").div(step).ceil().mul(step).toFixed() as DecimalString;
}

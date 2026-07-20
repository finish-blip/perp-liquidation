import { describe, expect, it } from "vitest";

import {
  addDecimal,
  assertDecimalString,
  assertPositiveDecimal,
  compareDecimal,
  quantizeDownToStep,
  subtractDecimal
} from "../../../../src/domain/shared/decimal.js";
import { ValidationError } from "../../../../src/domain/shared/errors.js";

describe("decimal primitives", () => {
  it("adds and subtracts decimal strings without floating point drift", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(subtractDecimal("1.00000001", "0.00000002")).toBe("0.99999999");
  });

  it("rejects non-decimal strings", () => {
    expect(() => assertDecimalString("1e-8")).toThrow(ValidationError);
    expect(() => assertDecimalString("NaN")).toThrow(ValidationError);
    expect(() => assertPositiveDecimal("0")).toThrow(ValidationError);
  });

  it("compares decimal strings", () => {
    expect(compareDecimal("1.20", "1.2")).toBe(0);
    expect(compareDecimal("1.19", "1.2")).toBe(-1);
    expect(compareDecimal("1.21", "1.2")).toBe(1);
  });

  it("quantizes down to the configured step size", () => {
    expect(quantizeDownToStep("1.239", "0.01")).toBe("1.23");
    expect(quantizeDownToStep("0.00000019", "0.00000001")).toBe("0.00000019");
  });
});

import { describe, expect, it } from "vitest";

import {
  addMillis,
  assertUtcIsoString,
  nowUtcIso,
  toEpochMillis
} from "../../../../src/domain/shared/time.js";

describe("time primitives", () => {
  it("creates ISO UTC timestamps", () => {
    const value = nowUtcIso(() => new Date("2026-07-18T00:00:00.123Z"));

    expect(value).toBe("2026-07-18T00:00:00.123Z");
    expect(assertUtcIsoString(value)).toBe(value);
  });

  it("adds milliseconds", () => {
    const value = assertUtcIsoString("2026-07-18T00:00:00.000Z");

    expect(addMillis(value, 250)).toBe("2026-07-18T00:00:00.250Z");
    expect(toEpochMillis(value)).toBe(1784332800000);
  });
});

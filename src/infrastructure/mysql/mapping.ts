import { InvariantViolationError } from "../../domain/shared/errors.js";
import { parseJsonObject } from "../../domain/shared/serialization.js";
import { assertUtcIsoString, type UtcIsoString } from "../../domain/shared/time.js";

export function toMysqlDateTime(value: UtcIsoString): string {
  return `${value.slice(0, 10)} ${value.slice(11, -1)}`;
}

export function fromMysqlDateTime(value: string): UtcIsoString {
  return assertUtcIsoString(`${value.slice(0, 10)}T${value.slice(11)}Z`, "MySQL datetime");
}

export function parseMysqlJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return parseJsonObject(value);
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new InvariantViolationError("MySQL JSON column did not contain an object");
}

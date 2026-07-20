import { ValidationError } from "./errors.js";

export type UtcIsoString = string & {
  readonly __utcIsoStringBrand: unique symbol;
};

const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function nowUtcIso(clock: () => Date = () => new Date()): UtcIsoString {
  return clock().toISOString() as UtcIsoString;
}

export function assertUtcIsoString(value: string, field = "timestamp"): UtcIsoString {
  if (!UTC_ISO_PATTERN.test(value)) {
    throw new ValidationError(`${field} must be an ISO-8601 UTC timestamp`, { value });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ValidationError(`${field} must be a valid UTC timestamp`, { value });
  }

  return value as UtcIsoString;
}

export function toEpochMillis(value: UtcIsoString): number {
  return new Date(value).getTime();
}

export function addMillis(value: UtcIsoString, millis: number): UtcIsoString {
  return new Date(toEpochMillis(value) + millis).toISOString() as UtcIsoString;
}

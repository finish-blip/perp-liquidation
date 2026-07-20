import { InvariantViolationError, ValidationError } from "../../domain/shared/errors.js";
import type { UtcIsoString } from "../../domain/shared/time.js";
import type {
  ReclaimedStreamMessages,
  StreamMessage,
  StreamMessageSource
} from "../../application/ports/stream-message-source.js";

const DEAD_LETTER_SCRIPT = `
redis.call(
  'XADD', KEYS[2], '*',
  'original_stream', KEYS[1],
  'original_id', ARGV[2],
  'consumer_group', ARGV[1],
  'consumer', ARGV[3],
  'delivery_count', ARGV[4],
  'error', ARGV[5],
  'failed_at', ARGV[6],
  'fields', ARGV[7]
)
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

export type RedisStreamsClient = {
  call(command: string, ...args: string[]): Promise<unknown>;
};

export type RedisStreamMessageSourceOptions = {
  readonly stream: string;
  readonly deadLetterStream: string;
  readonly group: string;
  readonly consumer: string;
};

export class RedisStreamMessageSource implements StreamMessageSource {
  constructor(
    private readonly client: RedisStreamsClient,
    private readonly options: RedisStreamMessageSourceOptions
  ) {
    validateOptions(options);
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.client.call(
        "XGROUP",
        "CREATE",
        this.options.stream,
        this.options.group,
        "0-0",
        "MKSTREAM"
      );
    } catch (error) {
      if (!isBusyGroupError(error)) {
        throw error;
      }
    }
  }

  async readNew(input: {
    readonly count: number;
    readonly blockMs: number;
  }): Promise<readonly StreamMessage[]> {
    const response = await this.client.call(
      "XREADGROUP",
      "GROUP",
      this.options.group,
      this.options.consumer,
      "COUNT",
      input.count.toString(),
      "BLOCK",
      input.blockMs.toString(),
      "STREAMS",
      this.options.stream,
      ">"
    );
    return parseReadGroupResponse(response).map((message) => ({
      ...message,
      deliveryCount: 1,
      reclaimed: false
    }));
  }

  async reclaim(input: {
    readonly cursor: string;
    readonly count: number;
    readonly minIdleMs: number;
  }): Promise<ReclaimedStreamMessages> {
    assertStreamId(input.cursor, "reclaim cursor");
    const response = await this.client.call(
      "XAUTOCLAIM",
      this.options.stream,
      this.options.group,
      this.options.consumer,
      input.minIdleMs.toString(),
      input.cursor,
      "COUNT",
      input.count.toString()
    );
    const { nextCursor, entries } = parseAutoClaimResponse(response);
    const messages = await Promise.all(
      entries.map(async (entry): Promise<StreamMessage> => ({
        ...entry,
        deliveryCount: await this.getDeliveryCount(entry.id),
        reclaimed: true
      }))
    );
    return { nextCursor, messages };
  }

  async acknowledge(messageId: string): Promise<void> {
    assertStreamId(messageId, "message id");
    await this.client.call("XACK", this.options.stream, this.options.group, messageId);
  }

  async deadLetter(input: {
    readonly message: StreamMessage;
    readonly error: string;
    readonly failedAt: UtcIsoString;
  }): Promise<void> {
    assertStreamId(input.message.id, "message id");
    await this.client.call(
      "EVAL",
      DEAD_LETTER_SCRIPT,
      "2",
      this.options.stream,
      this.options.deadLetterStream,
      this.options.group,
      input.message.id,
      this.options.consumer,
      input.message.deliveryCount.toString(),
      input.error.slice(0, 4096),
      input.failedAt,
      JSON.stringify(input.message.fields)
    );
  }

  private async getDeliveryCount(messageId: string): Promise<number> {
    const response = await this.client.call(
      "XPENDING",
      this.options.stream,
      this.options.group,
      messageId,
      messageId,
      "1"
    );
    if (!Array.isArray(response) || response.length !== 1) {
      throw new InvariantViolationError("Redis XPENDING did not return the reclaimed message", {
        messageId
      });
    }
    const responseEntries: readonly unknown[] = response;
    const row: unknown = responseEntries[0];
    if (!Array.isArray(row) || row.length < 4) {
      throw new InvariantViolationError("Redis XPENDING returned a malformed entry");
    }
    const pendingEntry: readonly unknown[] = row;
    return parseDeliveryCount(pendingEntry[3]);
  }
}

type ParsedEntry = Pick<StreamMessage, "id" | "fields">;

function parseReadGroupResponse(value: unknown): ParsedEntry[] {
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new InvariantViolationError("Redis XREADGROUP returned a malformed response");
  }
  const messages: ParsedEntry[] = [];
  const streamResults: readonly unknown[] = value;
  for (const streamResult of streamResults) {
    if (!Array.isArray(streamResult) || streamResult.length < 2) {
      throw new InvariantViolationError("Redis XREADGROUP returned a malformed stream");
    }
    const streamValues: readonly unknown[] = streamResult;
    const entries: unknown = streamValues[1];
    if (!Array.isArray(entries)) {
      throw new InvariantViolationError("Redis XREADGROUP entries are malformed");
    }
    const rawEntries: readonly unknown[] = entries;
    messages.push(...rawEntries.map(parseEntry));
  }
  return messages;
}

function parseAutoClaimResponse(value: unknown): {
  readonly nextCursor: string;
  readonly entries: ParsedEntry[];
} {
  if (!Array.isArray(value) || value.length < 2) {
    throw new InvariantViolationError("Redis XAUTOCLAIM returned a malformed response");
  }
  const claimValues: readonly unknown[] = value;
  const nextCursor = scalarToString(claimValues[0]);
  assertStreamId(nextCursor, "next reclaim cursor");
  const rawEntries: unknown = claimValues[1];
  if (!Array.isArray(rawEntries)) {
    throw new InvariantViolationError("Redis XAUTOCLAIM entries are malformed");
  }
  const claimEntries: readonly unknown[] = rawEntries;
  return { nextCursor, entries: claimEntries.map(parseEntry) };
}

function parseEntry(value: unknown): ParsedEntry {
  if (!Array.isArray(value) || value.length < 2) {
    throw new InvariantViolationError("Redis stream entry is malformed");
  }
  const entryValues: readonly unknown[] = value;
  const id = scalarToString(entryValues[0]);
  assertStreamId(id, "message id");
  const rawFields: unknown = entryValues[1];
  if (!Array.isArray(rawFields) || rawFields.length % 2 !== 0) {
    throw new InvariantViolationError("Redis stream fields are malformed", { messageId: id });
  }
  const fieldValues: readonly unknown[] = rawFields;
  const fields: Record<string, string> = {};
  for (let index = 0; index < fieldValues.length; index += 2) {
    const key = scalarToString(fieldValues[index]);
    fields[key] = scalarToString(fieldValues[index + 1]);
  }
  return { id, fields };
}

function parseDeliveryCount(value: unknown): number {
  const text = scalarToString(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new InvariantViolationError("Redis returned an invalid delivery count", { value: text });
  }
  const count = BigInt(text);
  return count > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(count);
}

function scalarToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  throw new InvariantViolationError("Redis returned a non-scalar stream value");
}

function assertStreamId(value: string, field: string): void {
  if (!/^\d+-\d+$/.test(value)) {
    throw new ValidationError(`${field} must be a Redis stream id`, { value });
  }
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("BUSYGROUP");
}

function validateOptions(options: RedisStreamMessageSourceOptions): void {
  for (const [field, value, maximum] of [
    ["stream", options.stream, 512],
    ["deadLetterStream", options.deadLetterStream, 512],
    ["group", options.group, 128],
    ["consumer", options.consumer, 128]
  ] as const) {
    if (value.length < 1 || value.length > maximum) {
      throw new ValidationError(`${field} must be between 1 and ${maximum} characters`);
    }
  }
}

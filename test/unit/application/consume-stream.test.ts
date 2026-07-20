import { describe, expect, it, vi } from "vitest";

import {
  ConsumeStream,
  type ConsumeStreamOptions,
  type StreamMessageHandler
} from "../../../src/application/consume-stream.js";
import type {
  StreamMessage,
  StreamMessageSource
} from "../../../src/application/ports/stream-message-source.js";
import { ConflictError, ValidationError } from "../../../src/domain/shared/errors.js";
import { assertUtcIsoString } from "../../../src/domain/shared/time.js";

const NOW = assertUtcIsoString("2026-07-18T06:00:00.000Z");
const OPTIONS: ConsumeStreamOptions = {
  batchSize: 10,
  blockMs: 100,
  reclaimMinIdleMs: 30_000,
  maxDeliveries: 3,
  errorBackoffMs: 100
};

describe("ConsumeStream", () => {
  it("processes reclaimed messages before reading new messages and acknowledges success", async () => {
    const reclaimed = streamMessage({ reclaimed: true, deliveryCount: 2 });
    const harness = createHarness([reclaimed]);
    const consumer = createConsumer(harness);

    await expect(consumer.processNextBatch()).resolves.toEqual({
      received: 1,
      processed: 1,
      deferred: 0,
      dead: 0
    });
    expect(harness.mocks.ensureGroup).toHaveBeenCalledTimes(1);
    expect(harness.mocks.readNew).not.toHaveBeenCalled();
    expect(harness.mocks.handle).toHaveBeenCalledWith(
      { message_id: "message-1" },
      expect.objectContaining({
        messageId: "1710000000000-0",
        deliveryCount: 2,
        reclaimed: true
      })
    );
    expect(harness.mocks.acknowledge).toHaveBeenCalledWith("1710000000000-0");
  });

  it("reads new messages when no pending message is eligible for reclaim", async () => {
    const fresh = streamMessage();
    const harness = createHarness([], [fresh]);
    const consumer = createConsumer(harness);

    await expect(consumer.processNextBatch()).resolves.toEqual({
      received: 1,
      processed: 1,
      deferred: 0,
      dead: 0
    });
    expect(harness.mocks.readNew).toHaveBeenCalledWith({ count: 10, blockMs: 100 });
  });

  it("leaves retryable failures pending below the delivery limit", async () => {
    const harness = createHarness([
      streamMessage({ reclaimed: true, deliveryCount: 2 })
    ]);
    harness.mocks.handle.mockRejectedValue(new ConflictError("database conflict"));
    const consumer = createConsumer(harness);

    await expect(consumer.processNextBatch()).resolves.toEqual({
      received: 1,
      processed: 0,
      deferred: 1,
      dead: 0
    });
    expect(harness.mocks.acknowledge).not.toHaveBeenCalled();
    expect(harness.mocks.deadLetter).not.toHaveBeenCalled();
  });

  it("moves retryable failures to dead letter at the delivery limit", async () => {
    const message = streamMessage({ reclaimed: true, deliveryCount: 3 });
    const harness = createHarness([message]);
    harness.mocks.handle.mockRejectedValue(new ConflictError("database conflict"));
    const consumer = createConsumer(harness);

    await expect(consumer.processNextBatch()).resolves.toEqual({
      received: 1,
      processed: 0,
      deferred: 0,
      dead: 1
    });
    expect(harness.mocks.deadLetter).toHaveBeenCalledWith({
      message,
      error: "database conflict",
      failedAt: NOW
    });
    expect(harness.mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("dead-letters non-retryable validation errors immediately", async () => {
    const message = streamMessage();
    const harness = createHarness([message]);
    harness.mocks.handle.mockRejectedValue(new ValidationError("invalid command"));
    const consumer = createConsumer(harness);

    const result = await consumer.processNextBatch();

    expect(result.dead).toBe(1);
    expect(harness.mocks.deadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ message, error: "invalid command" })
    );
  });

  it("dead-letters malformed JSON without invoking the business handler", async () => {
    const message = streamMessage({ fields: { payload: "{" } });
    const harness = createHarness([message]);
    const consumer = createConsumer(harness);

    const result = await consumer.processNextBatch();

    expect(result.dead).toBe(1);
    expect(harness.mocks.handle).not.toHaveBeenCalled();
    expect(harness.mocks.deadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Stream message payload must be valid JSON" })
    );
  });

  it("propagates acknowledgement failures so an idempotent handler can be retried", async () => {
    const harness = createHarness([streamMessage()]);
    harness.mocks.acknowledge.mockRejectedValue(new Error("Redis disconnected"));
    const consumer = createConsumer(harness);

    await expect(consumer.processNextBatch()).rejects.toThrow("Redis disconnected");
    expect(harness.mocks.handle).toHaveBeenCalledTimes(1);
    expect(harness.mocks.deadLetter).not.toHaveBeenCalled();
  });
});

function createConsumer(harness: ReturnType<typeof createHarness>): ConsumeStream {
  return new ConsumeStream(
    {
      source: harness.source,
      handler: { handle: harness.mocks.handle },
      clock: () => new Date(NOW)
    },
    OPTIONS
  );
}

function createHarness(
  reclaimedMessages: readonly StreamMessage[],
  newMessages: readonly StreamMessage[] = []
) {
  const ensureGroup = vi.fn<StreamMessageSource["ensureGroup"]>(() => Promise.resolve());
  const reclaim = vi.fn<StreamMessageSource["reclaim"]>(() =>
    Promise.resolve({ nextCursor: "0-0", messages: reclaimedMessages })
  );
  const readNew = vi.fn<StreamMessageSource["readNew"]>(() =>
    Promise.resolve(newMessages)
  );
  const acknowledge = vi.fn<StreamMessageSource["acknowledge"]>(() =>
    Promise.resolve()
  );
  const deadLetter = vi.fn<StreamMessageSource["deadLetter"]>(() => Promise.resolve());
  const handle = vi.fn<StreamMessageHandler["handle"]>(() => Promise.resolve());
  return {
    source: { ensureGroup, reclaim, readNew, acknowledge, deadLetter },
    mocks: { ensureGroup, reclaim, readNew, acknowledge, deadLetter, handle }
  };
}

function streamMessage(overrides: Partial<StreamMessage> = {}): StreamMessage {
  return {
    id: "1710000000000-0",
    fields: { payload: '{"message_id":"message-1"}', source: "risk-engine" },
    deliveryCount: 1,
    reclaimed: false,
    ...overrides
  };
}

import { describe, expect, it, vi } from "vitest";

import { assertUtcIsoString } from "../../../../src/domain/shared/time.js";
import {
  RedisStreamMessageSource,
  type RedisStreamsClient
} from "../../../../src/infrastructure/redis/stream-message-source.js";

const OPTIONS = {
  stream: "liquidation:{engine}:commands",
  deadLetterStream: "liquidation:{engine}:dead-letter",
  group: "liquidation-engine",
  consumer: "consumer-1"
} as const;

describe("RedisStreamMessageSource", () => {
  it("creates the consumer group and treats BUSYGROUP as idempotent", async () => {
    const call = vi.fn<RedisStreamsClient["call"]>(() =>
      Promise.reject(new Error("BUSYGROUP Consumer Group name already exists"))
    );
    const source = new RedisStreamMessageSource({ call }, OPTIONS);

    await expect(source.ensureGroup()).resolves.toBeUndefined();
    expect(call).toHaveBeenCalledWith(
      "XGROUP",
      "CREATE",
      OPTIONS.stream,
      OPTIONS.group,
      "0-0",
      "MKSTREAM"
    );
  });

  it("parses fresh stream entries without converting their ids to numbers", async () => {
    const call = vi.fn<RedisStreamsClient["call"]>(() =>
      Promise.resolve([
        [
          OPTIONS.stream,
          [
            [
              "18446744073709551615-7",
              ["payload", '{"message_id":"message-1"}', "source", "risk-engine"]
            ]
          ]
        ]
      ])
    );
    const source = new RedisStreamMessageSource({ call }, OPTIONS);

    await expect(source.readNew({ count: 25, blockMs: 1000 })).resolves.toEqual([
      {
        id: "18446744073709551615-7",
        fields: {
          payload: '{"message_id":"message-1"}',
          source: "risk-engine"
        },
        deliveryCount: 1,
        reclaimed: false
      }
    ]);
    expect(call).toHaveBeenCalledWith(
      "XREADGROUP",
      "GROUP",
      OPTIONS.group,
      OPTIONS.consumer,
      "COUNT",
      "25",
      "BLOCK",
      "1000",
      "STREAMS",
      OPTIONS.stream,
      ">"
    );
  });

  it("reclaims stale pending entries and reads their native delivery counts", async () => {
    const call = vi
      .fn<RedisStreamsClient["call"]>()
      .mockResolvedValueOnce([
        "1710000000001-0",
        [["1710000000000-0", ["payload", "{}"]]],
        []
      ])
      .mockResolvedValueOnce([
        ["1710000000000-0", OPTIONS.consumer, "30001", "4"]
      ]);
    const source = new RedisStreamMessageSource({ call }, OPTIONS);

    await expect(
      source.reclaim({ cursor: "0-0", count: 10, minIdleMs: 30_000 })
    ).resolves.toEqual({
      nextCursor: "1710000000001-0",
      messages: [
        {
          id: "1710000000000-0",
          fields: { payload: "{}" },
          deliveryCount: 4,
          reclaimed: true
        }
      ]
    });
    expect(call).toHaveBeenNthCalledWith(
      2,
      "XPENDING",
      OPTIONS.stream,
      OPTIONS.group,
      "1710000000000-0",
      "1710000000000-0",
      "1"
    );
  });

  it("writes dead letter and acknowledges the original message in one Lua call", async () => {
    const call = vi.fn<RedisStreamsClient["call"]>(() => Promise.resolve(1));
    const source = new RedisStreamMessageSource({ call }, OPTIONS);

    await source.deadLetter({
      message: {
        id: "1710000000000-0",
        fields: { payload: "{}" },
        deliveryCount: 5,
        reclaimed: true
      },
      error: "invalid payload",
      failedAt: assertUtcIsoString("2026-07-18T06:00:00.000Z")
    });

    const invocation = call.mock.calls[0];
    expect(invocation?.[0]).toBe("EVAL");
    expect(invocation?.[1]).toEqual(expect.stringContaining("XADD"));
    expect(invocation?.[1]).toEqual(expect.stringContaining("XACK"));
    expect(invocation?.slice(2, 6)).toEqual([
      "2",
      OPTIONS.stream,
      OPTIONS.deadLetterStream,
      OPTIONS.group
    ]);
    expect(invocation).toContain("invalid payload");
  });
});

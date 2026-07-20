import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { describe, expect, it, vi } from "vitest";

import { publishConfirmed } from "../../../../src/infrastructure/rabbitmq/confirmed-publish.js";

describe("publishConfirmed", () => {
  it("waits for publisher confirms and enables mandatory routing", async () => {
    const harness = channelHarness();

    await publishConfirmed(harness.channel, publishInput());

    expect(harness.publish).toHaveBeenCalledWith(
      "perpetual.events",
      "liquidation.execution.result.v1",
      expect.any(Buffer),
      expect.objectContaining({ mandatory: true, messageId: "result-1" })
    );
    expect(harness.waitForConfirms).toHaveBeenCalledOnce();
  });

  it("reports an unroutable mandatory message as retryable", async () => {
    const harness = channelHarness(true);

    await expect(
      publishConfirmed(harness.channel, publishInput())
    ).rejects.toMatchObject({
      code: "EXTERNAL_RETRYABLE",
      retryable: true
    });
  });
});

function publishInput() {
  return {
    exchange: "perpetual.events",
    routingKey: "liquidation.execution.result.v1",
    content: Buffer.from("{}"),
    options: {
      contentType: "application/json",
      messageId: "result-1"
    }
  };
}

function channelHarness(returnMessage = false) {
  const returnListeners = new Set<(message: ConsumeMessage) => void>();
  const publish = vi.fn(() => {
    if (returnMessage) {
      for (const listener of returnListeners) {
        listener(returnedMessage());
      }
    }
    return true;
  });
  const waitForConfirms = vi.fn(() => Promise.resolve());
  const channel = {
    on: vi.fn((event: string, listener: (message: ConsumeMessage) => void) => {
      if (event === "return") {
        returnListeners.add(listener);
      }
    }),
    off: vi.fn((event: string, listener: (message: ConsumeMessage) => void) => {
      if (event === "return") {
        returnListeners.delete(listener);
      }
    }),
    publish,
    waitForConfirms
  } as unknown as ConfirmChannel;
  return { channel, publish, waitForConfirms };
}

function returnedMessage(): ConsumeMessage {
  return {
    content: Buffer.from("{}"),
    fields: {
      consumerTag: "",
      deliveryTag: 1,
      redelivered: false,
      exchange: "perpetual.events",
      routingKey: "liquidation.execution.result.v1"
    },
    properties: {
      contentType: "application/json",
      contentEncoding: undefined,
      headers: undefined,
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: "result-1",
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined
    }
  };
}

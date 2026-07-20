import type { ConfirmChannel, Message, Options } from "amqplib";

import { ExternalRetryableError } from "../../domain/shared/errors.js";

export async function publishConfirmed(
  channel: ConfirmChannel,
  input: {
    readonly exchange: string;
    readonly routingKey: string;
    readonly content: Buffer;
    readonly options: Options.Publish & { readonly messageId: string };
  }
): Promise<void> {
  const state: { returned: boolean } = { returned: false };
  const onReturn = (message: Message): void => {
    const returnedMessageId = message.properties.messageId as unknown;
    if (returnedMessageId === input.options.messageId) {
      state.returned = true;
    }
  };

  channel.on("return", onReturn);
  try {
    channel.publish(input.exchange, input.routingKey, input.content, {
      ...input.options,
      mandatory: true
    });
    await channel.waitForConfirms();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (state.returned) {
      throw new ExternalRetryableError("RabbitMQ message was not routed to any queue", {
        exchange: input.exchange,
        routingKey: input.routingKey,
        messageId: input.options.messageId
      });
    }
  } finally {
    channel.off("return", onReturn);
  }
}

import amqp from "amqplib";

const rabbitUrl = process.env.RABBITMQ_URL ?? "amqp://liquidation:liquidation@127.0.0.1:5673";
const exchange = process.env.RABBITMQ_EXCHANGE ?? "perpetual.events";
const commandRoutingKey =
  process.env.RABBITMQ_COMMAND_ROUTING_KEY ?? "risk.liquidation.requested.v1";
const resultRoutingKey =
  process.env.RABBITMQ_RESULT_ROUTING_KEY ?? "liquidation.execution.result.v1";
const queue = `liquidation.results.smoke.${process.pid}`;

const connection = await amqp.connect(rabbitUrl);
const channel = await connection.createChannel();

try {
  await channel.assertExchange(exchange, "topic", { durable: true });
  await channel.assertQueue(queue, { durable: false, autoDelete: true });
  await channel.bindQueue(queue, exchange, resultRoutingKey);

  const event = buildExpiredEvent();
  channel.publish(exchange, commandRoutingKey, Buffer.from(JSON.stringify(event)), {
    contentType: "application/json",
    persistent: true,
    messageId: event.eventId
  });

  const result = await waitForResult(channel, queue);
  if (
    result.eventType !== "liquidation.execution.result.v1" ||
    result.data?.status !== "EXPIRED" ||
    result.data?.requestEventId !== event.eventId
  ) {
    throw new Error(`Unexpected liquidation result: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await channel.deleteQueue(queue).catch(() => undefined);
  await channel.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
}

function waitForResult(channel, queueName) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("RabbitMQ result timeout")), 10_000);
    void channel.consume(
      queueName,
      (message) => {
        if (message === null) {
          return;
        }
        clearTimeout(timeout);
        channel.ack(message);
        resolve(JSON.parse(message.content.toString("utf8")));
      },
      { noAck: false }
    ).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function buildExpiredEvent() {
  const suffix = `${Date.now()}_${process.pid}`;
  return {
    eventId: `liquidation:smoke_expired:${suffix}`,
    eventType: "risk.liquidation.requested.v1",
    eventVersion: 1,
    occurredAt: "2026-07-20T00:00:00.000Z",
    producer: "risk-control-service",
    data: {
      riskDecisionId: `risk_smoke_expired_${suffix}`,
      decisionSequence: "1",
      riskUnitId: "smoke-account:BTCUSDT",
      source: "risk-smoke",
      userId: "smoke-user",
      accountId: "smoke-account",
      positionId: "smoke-position",
      symbol: "BTCUSDT",
      positionSide: "LONG",
      positionVersion: "1",
      riskLevel: "LIQUIDATION_REQUIRED",
      triggerReason: "SMOKE_TEST",
      riskSnapshot: {},
      executionInstruction: {
        action: "LIQUIDATE_POSITION",
        mode: "FULL_LIQUIDATION",
        targetReduceSize: "0.1",
        maxReduceSize: "0.1",
        orderType: "MARKET",
        reduceOnly: true,
        maxSlippageBps: 50,
        timeInForce: "IOC"
      },
      expireAt: "2026-07-20T00:00:01.000Z"
    }
  };
}

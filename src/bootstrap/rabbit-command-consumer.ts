import { connect } from "amqplib";

import { ReceiveLiquidationCommand } from "../application/receive-liquidation-command.js";
import { ReceiveRiskLiquidationEvent } from "../application/receive-risk-liquidation-event.js";
import { loadConfig } from "../config/env.js";
import { MysqlCommandIntakeUnitOfWork } from "../infrastructure/mysql/command-intake-unit-of-work.js";
import { closeMysqlPool, createMysqlPool } from "../infrastructure/mysql/pool.js";
import { RabbitLiquidationCommandConsumer } from "../infrastructure/rabbitmq/liquidation-command-consumer.js";
import { createLogger } from "../observability/logger.js";
import { installGracefulShutdown } from "./lifecycle.js";

const config = loadConfig();
const logger = createLogger(config, { component: "rabbit-command-consumer" });
const mysqlPool = createMysqlPool(config);
const connection = await connect(config.rabbit.url);
const channel = await connection.createConfirmChannel();
const commandReceiver = new ReceiveLiquidationCommand({
  unitOfWork: new MysqlCommandIntakeUnitOfWork(mysqlPool)
});
const riskEventReceiver = new ReceiveRiskLiquidationEvent(commandReceiver);
const consumer = new RabbitLiquidationCommandConsumer(
  channel,
  riskEventReceiver,
  {
    exchange: config.rabbit.exchange,
    queue: config.rabbit.commandQueue,
    routingKey: config.rabbit.commandRoutingKey,
    resultRoutingKey: config.rabbit.resultRoutingKey,
    deadLetterExchange: config.rabbit.deadLetterExchange,
    deadLetterQueue: config.rabbit.deadLetterQueue,
    deadLetterRoutingKey: config.rabbit.deadLetterRoutingKey,
    retryExchange: config.rabbit.retryExchange,
    retryQueue: config.rabbit.retryQueue,
    retryRoutingKey: config.rabbit.retryRoutingKey,
    retryDelayMs: config.rabbit.retryDelayMs,
    maxRetries: config.rabbit.maxRetries,
    prefetch: config.rabbit.prefetch
  },
  logger
);

await consumer.start();

const connectionClosed = new Promise<void>((resolve, reject) => {
  connection.once("close", resolve);
  connection.once("error", reject);
});

installGracefulShutdown({
  logger,
  timeoutMs: config.shutdownTimeoutMs,
  hooks: [
    async () => {
      await consumer.stop();
      await channel.close();
      await connection.close();
      await closeMysqlPool(mysqlPool, logger);
    }
  ]
});

await connectionClosed;

import { ConsumeStream } from "../application/consume-stream.js";
import { HandleOrderEvent } from "../application/handle-order-event.js";
import { HandleSettlementEvent } from "../application/handle-settlement-event.js";
import { ReceiveLiquidationCommand } from "../application/receive-liquidation-command.js";
import {
  LiquidationCommandStreamHandler,
  OrderEventStreamHandler,
  SettlementEventStreamHandler
} from "../application/stream-message-handlers.js";
import { loadConfig } from "../config/env.js";
import { MysqlCommandIntakeUnitOfWork } from "../infrastructure/mysql/command-intake-unit-of-work.js";
import { MysqlExecutionEventUnitOfWork } from "../infrastructure/mysql/execution-event-unit-of-work.js";
import { closeMysqlPool, createMysqlPool } from "../infrastructure/mysql/pool.js";
import { closeRedisClient, createRedisClient } from "../infrastructure/redis/client.js";
import { RedisStreamMessageSource } from "../infrastructure/redis/stream-message-source.js";
import { createLogger } from "../observability/logger.js";
import { installGracefulShutdown } from "./lifecycle.js";

const config = loadConfig();
const logger = createLogger(config, { component: "stream-consumer" });
const mysqlPool = createMysqlPool(config);
const commandReceiver = new ReceiveLiquidationCommand({
  unitOfWork: new MysqlCommandIntakeUnitOfWork(mysqlPool)
});
const eventUnitOfWork = new MysqlExecutionEventUnitOfWork(mysqlPool);
const orderEventHandler = new HandleOrderEvent(eventUnitOfWork);
const settlementEventHandler = new HandleSettlementEvent(eventUnitOfWork);
const commandRedisClient = createRedisClient(config);
const orderEventRedisClient = createRedisClient(config);
const settlementEventRedisClient = createRedisClient(config);
const redisClients = [
  commandRedisClient,
  orderEventRedisClient,
  settlementEventRedisClient
] as const;
const streamOptions = {
  batchSize: config.streams.batchSize,
  blockMs: config.streams.blockMs,
  reclaimMinIdleMs: config.streams.reclaimMinIdleMs,
  maxDeliveries: config.streams.maxDeliveries,
  errorBackoffMs: config.streams.errorBackoffMs
};
const consumers = [
  new ConsumeStream(
    {
      source: new RedisStreamMessageSource(commandRedisClient, {
        stream: config.streams.commands,
        deadLetterStream: config.streams.deadLetter,
        group: config.streams.group,
        consumer: config.streams.consumer
      }),
      handler: new LiquidationCommandStreamHandler(commandReceiver, "redis-stream"),
      logger: logger.child({ stream: config.streams.commands })
    },
    streamOptions
  ),
  new ConsumeStream(
    {
      source: new RedisStreamMessageSource(orderEventRedisClient, {
        stream: config.streams.orderEvents,
        deadLetterStream: config.streams.deadLetter,
        group: config.streams.group,
        consumer: config.streams.consumer
      }),
      handler: new OrderEventStreamHandler(orderEventHandler),
      logger: logger.child({ stream: config.streams.orderEvents })
    },
    streamOptions
  ),
  new ConsumeStream(
    {
      source: new RedisStreamMessageSource(settlementEventRedisClient, {
        stream: config.streams.settlementEvents,
        deadLetterStream: config.streams.deadLetter,
        group: config.streams.group,
        consumer: config.streams.consumer
      }),
      handler: new SettlementEventStreamHandler(settlementEventHandler),
      logger: logger.child({ stream: config.streams.settlementEvents })
    },
    streamOptions
  )
];
const abortController = new AbortController();

await Promise.all(redisClients.map((client) => client.connect()));
const runPromise = Promise.all(
  consumers.map((consumer) => consumer.run(abortController.signal))
);
installGracefulShutdown({
  logger,
  timeoutMs: config.shutdownTimeoutMs,
  hooks: [
    async () => {
      abortController.abort();
      await Promise.all(redisClients.map((client) => closeRedisClient(client, logger)));
      await runPromise;
      await closeMysqlPool(mysqlPool, logger);
    }
  ]
});

logger.info(
  {
    streams: [
      config.streams.commands,
      config.streams.orderEvents,
      config.streams.settlementEvents
    ],
    group: config.streams.group,
    consumer: config.streams.consumer
  },
  "stream consumers started"
);
await runPromise;

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { describe, expect, it } from "vitest";

import { buildServer } from "../../src/api/server.js";
import {
  ClaimLiquidationTask,
  RenewClaimedTaskLease
} from "../../src/application/claim-liquidation-task.js";
import { ConsumeStream } from "../../src/application/consume-stream.js";
import { DispatchOutbox } from "../../src/application/dispatch-outbox.js";
import { ExecuteStaticLiquidation } from "../../src/application/execute-static-liquidation.js";
import { HandleOrderEvent } from "../../src/application/handle-order-event.js";
import { HandleSettlementEvent } from "../../src/application/handle-settlement-event.js";
import { OperationApprovals } from "../../src/application/operation-approvals.js";
import { ReceiveLiquidationCommand } from "../../src/application/receive-liquidation-command.js";
import { runWithRenewedTaskLease } from "../../src/application/run-with-renewed-task-lease.js";
import {
  OrderEventStreamHandler,
  SettlementEventStreamHandler
} from "../../src/application/stream-message-handlers.js";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { toDecimal } from "../../src/domain/shared/decimal.js";
import { BinanceFuturesMarketDataClient } from "../../src/infrastructure/http-clients/binance-futures-market-data-client.js";
import { HttpEventPublisher } from "../../src/infrastructure/http-clients/event-publisher.js";
import { UndiciJsonHttpTransport } from "../../src/infrastructure/http-clients/json-http-transport.js";
import { HttpOrderGateway } from "../../src/infrastructure/http-clients/order-gateway.js";
import { HttpPortfolioClient } from "../../src/infrastructure/http-clients/portfolio-client.js";
import { MysqlApprovalUnitOfWork } from "../../src/infrastructure/mysql/approval-unit-of-work.js";
import { MysqlCommandIntakeUnitOfWork } from "../../src/infrastructure/mysql/command-intake-unit-of-work.js";
import { MysqlExecutionEventUnitOfWork } from "../../src/infrastructure/mysql/execution-event-unit-of-work.js";
import { MysqlOutboxUnitOfWork } from "../../src/infrastructure/mysql/outbox-unit-of-work.js";
import { createMysqlPool } from "../../src/infrastructure/mysql/pool.js";
import { MysqlStaticExecutionUnitOfWork } from "../../src/infrastructure/mysql/static-execution-unit-of-work.js";
import { MysqlTaskReader } from "../../src/infrastructure/mysql/task-reader.js";
import { MysqlWorkerLeaseUnitOfWork } from "../../src/infrastructure/mysql/worker-lease-unit-of-work.js";
import { createRedisClient } from "../../src/infrastructure/redis/client.js";
import { RedisRiskUnitLock } from "../../src/infrastructure/redis/risk-unit-lock.js";
import { RedisStreamMessageSource } from "../../src/infrastructure/redis/stream-message-source.js";
import { createLogger } from "../../src/observability/logger.js";

const AUTH_TOKEN = "real-e2e-service-token";
const MARKET = "BTCUSDT";

describe("real liquidation flow", () => {
  it("completes a liquidation using real Binance market data", async () => {
    let mysqlContainer: StartedTestContainer | undefined;
    let redisContainer: StartedTestContainer | undefined;
    let pool: Pool | undefined;
    let redis: ReturnType<typeof createRedisClient> | undefined;
    let api: ReturnType<typeof buildServer> | undefined;
    let portfolioService: FastifyInstance | undefined;
    let orderService: FastifyInstance | undefined;
    let publisherService: FastifyInstance | undefined;
    let marketProxyService: FastifyInstance | undefined;

    try {
      mysqlContainer = await startMysql();
      redisContainer = await startRedis();
      await applyMigrations(mysqlContainer);

      const position = { payload: undefined as Record<string, unknown> | undefined };
      let submittedOrder: Record<string, unknown> | undefined;
      const publishedEvents: Record<string, unknown>[] = [];

      portfolioService = Fastify();
      portfolioService.get("/v1/positions/:positionId", () => {
        if (position.payload === undefined) {
          throw new Error("E2E position was not initialized");
        }
        return position.payload;
      });
      const portfolioBaseUrl = await portfolioService.listen({ host: "127.0.0.1", port: 0 });

      orderService = Fastify();
      orderService.post("/v1/orders", async (request) => {
        submittedOrder = requireObject(request.body, "order request");
        await delay(1500);
        return { accepted: true, exchange_order_id: "e2e-exchange-order-1" };
      });
      orderService.get("/v1/orders/by-client-id/:clientOrderId", () => ({
        found: false
      }));
      const orderBaseUrl = await orderService.listen({ host: "127.0.0.1", port: 0 });

      publisherService = Fastify();
      publisherService.post("/v1/events", (request, reply) => {
        publishedEvents.push(requireObject(request.body, "published event"));
        return reply.code(202).send({ status: "accepted" });
      });
      const publisherBaseUrl = await publisherService.listen({
        host: "127.0.0.1",
        port: 0
      });

      marketProxyService = Fastify();
      marketProxyService.get("/fapi/v1/ticker/bookTicker", async () => {
        const ticker = await publicBinanceJson(
          "https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT"
        );
        return {
          symbol: requireString(ticker.symbol, "Binance ticker symbol"),
          bidPrice: requireString(ticker.bidPrice, "Binance bid price"),
          askPrice: requireString(ticker.askPrice, "Binance ask price"),
          time: Date.now()
        };
      });
      marketProxyService.get("/fapi/v1/premiumIndex", async () => {
        const average = await publicBinanceJson(
          "https://data-api.binance.vision/api/v3/avgPrice?symbol=BTCUSDT"
        );
        return {
          symbol: MARKET,
          markPrice: requireString(average.price, "Binance average price"),
          time: requireNumber(average.closeTime, "Binance average closeTime")
        };
      });
      marketProxyService.get("/fapi/v1/exchangeInfo", async () => {
        const exchangeInfo = await publicBinanceJson(
          "https://data-api.binance.vision/api/v3/exchangeInfo?symbol=BTCUSDT"
        );
        return {
          symbols: requireArray(exchangeInfo.symbols, "Binance exchange symbols").map(
            (value) => {
              const symbol = requireObject(value, "Binance exchange symbol");
              return {
                ...symbol,
                status: "TRADING",
                contractType: "PERPETUAL"
              };
            }
          )
        };
      });
      const marketProxyBaseUrl = await marketProxyService.listen({
        host: "127.0.0.1",
        port: 0
      });

      const config = e2eConfig(
        mysqlContainer,
        redisContainer,
        portfolioBaseUrl,
        orderBaseUrl,
        publisherBaseUrl,
        marketProxyBaseUrl
      );
      const logger = createLogger(config, { component: "real-e2e" });
      const activePool = createMysqlPool(config);
      pool = activePool;
      redis = createRedisClient(config);
      await redis.connect();

      const transportOptions = { timeoutMs: 10_000, maxGetAttempts: 2 };
      const marketData = new BinanceFuturesMarketDataClient(
        new UndiciJsonHttpTransport({
          baseUrl: config.binance.baseUrl,
          timeoutMs: config.binance.timeoutMs,
          maxGetAttempts: config.binance.maxGetAttempts
        }),
        { exchangeInfoTtlMs: config.binance.exchangeInfoTtlMs }
      );
      const portfolioClient = new HttpPortfolioClient(
        new UndiciJsonHttpTransport({ baseUrl: portfolioBaseUrl, ...transportOptions })
      );
      const orderGateway = new HttpOrderGateway(
        new UndiciJsonHttpTransport({ baseUrl: orderBaseUrl, ...transportOptions })
      );
      const executionEvents = new MysqlExecutionEventUnitOfWork(activePool);
      const commandReceiver = new ReceiveLiquidationCommand({
        unitOfWork: new MysqlCommandIntakeUnitOfWork(activePool)
      });
      const orderEventHandler = new HandleOrderEvent(executionEvents);
      const settlementEventHandler = new HandleSettlementEvent(executionEvents);

      const application = buildServer(config, logger, {
        commands: commandReceiver,
        orderEvents: orderEventHandler,
        settlementEvents: settlementEventHandler,
        tasks: new MysqlTaskReader(activePool),
        marketData,
        approvals: new OperationApprovals(new MysqlApprovalUnitOfWork(activePool)),
        readiness: { check: async () => void (await activePool.query("SELECT 1")) }
      });
      api = application;
      const apiBaseUrl = await application.listen({ host: "127.0.0.1", port: 0 });

      const realMarket = await marketData.getSnapshot({
        market: MARKET,
        correlationId: "real-e2e-market",
        signal: AbortSignal.timeout(20_000)
      });
      const quantity = realMarket.stepSize;
      const bankruptcyPrice = toDecimal(realMarket.markPrice).mul("0.8").toFixed();
      position.payload = {
        position_id: "position-real-e2e",
        account_id: "account-real-e2e",
        risk_unit_id: `account-real-e2e:${MARKET}`,
        market: MARKET,
        side: "LONG",
        version: "1",
        quantity,
        reducible_quantity: quantity,
        bankruptcy_price: bankruptcyPrice
      };

      const commandResponse = await requestJson(`${apiBaseUrl}/v1/commands`, {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          message_id: "real-e2e-command-1",
          correlation_id: "real-e2e-correlation-1",
          command_type: "LIQUIDATE_POSITION",
          decision_sequence: "1",
          risk_unit_id: `account-real-e2e:${MARKET}`,
          account_id: "account-real-e2e",
          position_id: "position-real-e2e",
          position_version: "1",
          market: MARKET,
          side: "SELL",
          quantity,
          quantity_mode: "EXACT",
          strategy: "STATIC",
          expires_at: new Date(Date.now() + 120_000).toISOString()
        })
      });
      expect(commandResponse.statusCode).toBe(202);
      const task = requireObject(commandResponse.body.task, "accepted task");
      const taskId = requireString(task.id, "task.id");

      const riskUnitLock = new RedisRiskUnitLock(redis);
      const workerLeaseUnitOfWork = new MysqlWorkerLeaseUnitOfWork(activePool);
      const claimOptions = {
        workerId: "real-e2e-worker",
        taskLeaseMs: 5000,
        riskLockTtlMs: 3000,
        priorityAgingIntervalSeconds: 60,
        recoveryBatchSize: 10
      } as const;
      const claimUseCase = new ClaimLiquidationTask(
        { unitOfWork: workerLeaseUnitOfWork, riskUnitLock },
        claimOptions
      );
      const claimed = await claimUseCase.execute();
      expect(claimed.status).toBe("CLAIMED");
      if (claimed.status !== "CLAIMED") {
        throw new Error("E2E task was not claimed");
      }

      const executor = new ExecuteStaticLiquidation(
        {
          unitOfWork: new MysqlStaticExecutionUnitOfWork(activePool),
          portfolioClient,
          marketDataClient: marketData,
          orderGateway
        },
        {
          snapshotTimeoutMs: 10_000,
          orderTimeoutMs: 10_000,
          maxMarketAgeMs: 60_000,
          maxFutureSkewMs: 1000,
          maxPriceDeviationBps: 10_000,
          maxSlippageBps: 200,
          maxOrderQuantity: "1000000",
          maxSteps: 32
        }
      );
      const renewer = new RenewClaimedTaskLease(
        { unitOfWork: workerLeaseUnitOfWork, riskUnitLock },
        claimOptions
      );
      let leaseRenewals = 0;
      try {
        const execution = await runWithRenewedTaskLease({
          claim: claimed.claim,
          renewer: {
            async execute(activeClaim) {
              leaseRenewals += 1;
              return renewer.execute(activeClaim);
            }
          },
          renewalIntervalMs: 1000,
          action: (signal) => executor.execute(claimed.claim, signal)
        });
        expect(execution.status).toBe("WAITING_ORDER_EVENT");
        expect(leaseRenewals).toBeGreaterThanOrEqual(1);
      } finally {
        await riskUnitLock.release(claimed.claim.riskUnitLease);
      }

      const order = requireObject(submittedOrder, "submitted order");
      expect(order.side).toBe("SELL");
      expect(order.quantity).toBe(quantity);
      expect(order.reduce_only).toBe(true);
      expect(order.time_in_force).toBe("IOC");
      expect(
        toDecimal(requireString(order.limit_price, "order.limit_price")).gte(bankruptcyPrice)
      ).toBe(true);
      const clientOrderId = requireString(order.client_order_id, "order.client_order_id");

      await redis.xadd(
        config.streams.orderEvents,
        "*",
        "payload",
        JSON.stringify({
          event_id: "real-e2e-order-event-1",
          correlation_id: "real-e2e-correlation-1",
          client_order_id: clientOrderId,
          exchange_order_id: "e2e-exchange-order-1",
          event_sequence: "1",
          event_type: "FILLED",
          cumulative_filled_quantity: quantity,
          occurred_at: new Date().toISOString()
        })
      );
      const orderBatch = await streamConsumer(
        redis,
        config,
        config.streams.orderEvents,
        new OrderEventStreamHandler(orderEventHandler)
      ).processNextBatch();
      expect(orderBatch).toMatchObject({ received: 1, processed: 1, dead: 0 });

      await redis.xadd(
        config.streams.settlementEvents,
        "*",
        "payload",
        JSON.stringify({
          event_id: "real-e2e-settlement-event-1",
          correlation_id: "real-e2e-correlation-1",
          client_order_id: clientOrderId,
          exchange_order_id: "e2e-exchange-order-1",
          settlement_sequence: "1",
          position_id: "position-real-e2e",
          previous_position_version: "1",
          new_position_version: "2",
          settled_quantity: quantity,
          occurred_at: new Date().toISOString()
        })
      );
      const settlementBatch = await streamConsumer(
        redis,
        config,
        config.streams.settlementEvents,
        new SettlementEventStreamHandler(settlementEventHandler)
      ).processNextBatch();
      expect(settlementBatch).toMatchObject({ received: 1, processed: 1, dead: 0 });

      const dispatch = new DispatchOutbox(
        {
          unitOfWork: new MysqlOutboxUnitOfWork(activePool),
          publisher: new HttpEventPublisher(
            new UndiciJsonHttpTransport({ baseUrl: publisherBaseUrl, ...transportOptions })
          )
        },
        {
          workerId: "real-e2e-outbox",
          batchSize: 50,
          lockMs: 10_000,
          publishTimeoutMs: 10_000,
          maxAttempts: 3,
          baseRetryMs: 100,
          maxRetryMs: 1000
        }
      );
      const dispatchResult = await dispatch.execute();
      expect(dispatchResult).toEqual({ claimed: 2, published: 2, deferred: 0, dead: 0 });

      const finalTaskResponse = await requestJson(`${apiBaseUrl}/v1/tasks/${taskId}`, {
        headers: { "x-service-token": AUTH_TOKEN }
      });
      expect(finalTaskResponse.statusCode).toBe(200);
      expect(finalTaskResponse.body.status).toBe("COMPLETED");

      const verification = await verifyPersistence(activePool, taskId);
      expect(verification).toEqual({
        taskStatus: "COMPLETED",
        stepStatus: "COMPLETED",
        attemptStatus: "FILLED"
      });
      const publishedTypes = publishedEvents.map((event) =>
        requireString(event.event_type, "published event_type")
      );
      expect(publishedTypes).toContain("LIQUIDATION_TASK_ACCEPTED");
      expect(publishedTypes).toContain("LIQUIDATION_EXECUTION_SETTLED");

      console.log(
        `REAL_E2E_RESULT ${JSON.stringify({
          market: realMarket,
          marketSource: "Binance data-api.binance.vision BTCUSDT public data",
          submittedOrder: order,
          leaseRenewals,
          dispatch: dispatchResult,
          publishedEventTypes: publishedTypes,
          persistence: verification,
          finalTaskStatus: finalTaskResponse.body.status
        })}`
      );
    } finally {
      await closeFastify(api);
      await closeFastify(marketProxyService);
      await closeFastify(publisherService);
      await closeFastify(orderService);
      await closeFastify(portfolioService);
      if (redis !== undefined) {
        redis.disconnect();
      }
      await pool?.end();
      await redisContainer?.stop();
      await mysqlContainer?.stop();
    }
  });
});

function e2eConfig(
  mysqlContainer: StartedTestContainer,
  redisContainer: StartedTestContainer,
  portfolioBaseUrl: string,
  orderBaseUrl: string,
  publisherBaseUrl: string,
  marketProxyBaseUrl: string
): AppConfig {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    SERVICE_AUTH_TOKEN: AUTH_TOKEN,
    MYSQL_HOST: mysqlContainer.getHost(),
    MYSQL_PORT: mysqlContainer.getMappedPort(3306).toString(),
    MYSQL_USER: "liquidation",
    MYSQL_PASSWORD: "liquidation-e2e",
    MYSQL_DATABASE: "perp_liquidation",
    REDIS_URL: `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`,
    PORTFOLIO_BASE_URL: portfolioBaseUrl,
    ORDER_GATEWAY_BASE_URL: orderBaseUrl,
    EVENT_PUBLISHER_BASE_URL: publisherBaseUrl,
    BINANCE_TIMEOUT_MS: "10000",
    BINANCE_MAX_GET_ATTEMPTS: "2",
    TASK_LEASE_MS: "5000",
    RISK_LOCK_TTL_MS: "3000",
    SERVICE_TIMEOUT_MS: "10000",
    MAX_MARKET_AGE_MS: "60000",
    MAX_PRICE_DEVIATION_BPS: "10000",
    MAX_SLIPPAGE_BPS: "200",
    MAX_ORDER_QUANTITY: "1000000",
    STREAM_GROUP: "real-e2e-group",
    STREAM_CONSUMER: "real-e2e-consumer",
    STREAM_BLOCK_MS: "100"
  });
  return {
    ...config,
    binance: {
      ...config.binance,
      baseUrl: marketProxyBaseUrl
    }
  };
}

async function publicBinanceJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`Binance public data request failed with HTTP ${response.status}`);
  }
  return requireObject(await response.json(), "Binance public response");
}

async function startMysql(): Promise<StartedTestContainer> {
  return new GenericContainer("mysql:8.4")
    .withEnvironment({
      MYSQL_ROOT_PASSWORD: "root-e2e",
      MYSQL_DATABASE: "perp_liquidation",
      MYSQL_USER: "liquidation",
      MYSQL_PASSWORD: "liquidation-e2e",
      TZ: "UTC"
    })
    .withExposedPorts(3306)
    .withHealthCheck({
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -proot-e2e --silent"],
      interval: 1000,
      timeout: 3000,
      retries: 60,
      startPeriod: 1000
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(120_000)
    .start();
}

async function startRedis(): Promise<StartedTestContainer> {
  return new GenericContainer("redis:7.4-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(60_000)
    .start();
}

async function applyMigrations(container: StartedTestContainer): Promise<void> {
  const migrationPool = mysql.createPool({
    host: container.getHost(),
    port: container.getMappedPort(3306),
    user: "root",
    password: "root-e2e",
    database: "perp_liquidation",
    multipleStatements: true
  });
  try {
    const migrationDirectory = resolve(process.cwd(), "db", "migrations");
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      await migrationPool.query(await readFile(resolve(migrationDirectory, file), "utf8"));
    }
  } finally {
    await migrationPool.end();
  }
}

function streamConsumer(
  redis: ReturnType<typeof createRedisClient>,
  config: AppConfig,
  stream: string,
  handler: OrderEventStreamHandler | SettlementEventStreamHandler
): ConsumeStream {
  return new ConsumeStream(
    {
      source: new RedisStreamMessageSource(redis, {
        stream,
        deadLetterStream: config.streams.deadLetter,
        group: config.streams.group,
        consumer: config.streams.consumer
      }),
      handler
    },
    {
      batchSize: 10,
      blockMs: 100,
      reclaimMinIdleMs: 1000,
      maxDeliveries: 3,
      errorBackoffMs: 10
    }
  );
}

async function verifyPersistence(
  pool: Pool,
  taskId: string
): Promise<{ taskStatus: string; stepStatus: string; attemptStatus: string }> {
  type VerificationRow = RowDataPacket & {
    readonly task_status: string;
    readonly step_status: string;
    readonly attempt_status: string;
  };
  const [rows] = await pool.query<VerificationRow[]>(
    `SELECT t.status AS task_status, s.status AS step_status, a.status AS attempt_status
     FROM tasks t
     JOIN execution_steps s ON s.task_id = t.id
     JOIN order_attempts a ON a.execution_step_id = s.id
     WHERE t.id = ?`,
    [taskId]
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("E2E persistence verification returned no rows");
  }
  return {
    taskStatus: row.task_status,
    stepStatus: row.step_status,
    attemptStatus: row.attempt_status
  };
}

async function requestJson(
  url: string,
  init: RequestInit = {}
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  const body = requireObject(await response.json(), "HTTP response");
  return { statusCode: response.status, body };
}

function authenticatedHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-service-token": AUTH_TOKEN,
    "x-command-source": "real-e2e"
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

async function closeFastify(app: { close(): Promise<void> } | undefined): Promise<void> {
  if (app !== undefined) {
    await app.close();
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

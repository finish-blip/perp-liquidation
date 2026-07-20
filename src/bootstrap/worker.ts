import {
  ClaimLiquidationTask,
  RenewClaimedTaskLease,
  type ClaimedLiquidationTask
} from "../application/claim-liquidation-task.js";
import { DispatchOutbox } from "../application/dispatch-outbox.js";
import { ExecuteStaticLiquidation } from "../application/execute-static-liquidation.js";
import { HandleOrderEvent } from "../application/handle-order-event.js";
import { ReconcileUnknownOrder } from "../application/reconcile-unknown-order.js";
import { runWithRenewedTaskLease } from "../application/run-with-renewed-task-lease.js";
import { loadConfig } from "../config/env.js";
import { BinanceFuturesMarketDataClient } from "../infrastructure/http-clients/binance-futures-market-data-client.js";
import { HttpEventPublisher } from "../infrastructure/http-clients/event-publisher.js";
import { RoutingEventPublisher } from "../infrastructure/http-clients/routing-event-publisher.js";
import { UndiciJsonHttpTransport } from "../infrastructure/http-clients/json-http-transport.js";
import { HttpOrderGateway } from "../infrastructure/http-clients/order-gateway.js";
import { HttpPortfolioClient } from "../infrastructure/http-clients/portfolio-client.js";
import { closeMysqlPool, createMysqlPool } from "../infrastructure/mysql/pool.js";
import { MysqlExecutionEventUnitOfWork } from "../infrastructure/mysql/execution-event-unit-of-work.js";
import { MysqlOutboxUnitOfWork } from "../infrastructure/mysql/outbox-unit-of-work.js";
import { MysqlStaticExecutionUnitOfWork } from "../infrastructure/mysql/static-execution-unit-of-work.js";
import { MysqlWorkerLeaseUnitOfWork } from "../infrastructure/mysql/worker-lease-unit-of-work.js";
import { closeRedisClient, createRedisClient } from "../infrastructure/redis/client.js";
import { RedisRiskUnitLock } from "../infrastructure/redis/risk-unit-lock.js";
import { RabbitLiquidationResultPublisher } from "../infrastructure/rabbitmq/result-event-publisher.js";
import { connect } from "amqplib";
import { createLogger } from "../observability/logger.js";
import { installGracefulShutdown } from "./lifecycle.js";

const config = loadConfig();
const logger = createLogger(config, { component: "worker" });
const mysqlPool = createMysqlPool(config);
const redis = createRedisClient(config);
const rabbitConnection = await connect(config.rabbit.url);
const rabbitResultChannel = await rabbitConnection.createConfirmChannel();
const riskUnitLock = new RedisRiskUnitLock(redis);
const workerLeaseUnitOfWork = new MysqlWorkerLeaseUnitOfWork(mysqlPool);
const staticUnitOfWork = new MysqlStaticExecutionUnitOfWork(mysqlPool);
const serviceTransportOptions = {
  timeoutMs: config.worker.serviceTimeoutMs,
  maxGetAttempts: 2
};
const portfolioClient = new HttpPortfolioClient(
  new UndiciJsonHttpTransport({
    baseUrl: config.services.portfolioBaseUrl,
    ...serviceTransportOptions
  })
);
const orderGateway = new HttpOrderGateway(
  new UndiciJsonHttpTransport({
    baseUrl: config.services.orderGatewayBaseUrl,
    ...serviceTransportOptions
  })
);
const marketDataClient = new BinanceFuturesMarketDataClient(
  new UndiciJsonHttpTransport({
    baseUrl: config.binance.baseUrl,
    timeoutMs: config.binance.timeoutMs,
    maxGetAttempts: config.binance.maxGetAttempts
  }),
  { exchangeInfoTtlMs: config.binance.exchangeInfoTtlMs }
);
const orderEventHandler = new HandleOrderEvent(
  new MysqlExecutionEventUnitOfWork(mysqlPool)
);
const executeStatic = new ExecuteStaticLiquidation(
  {
    unitOfWork: staticUnitOfWork,
    portfolioClient,
    marketDataClient,
    orderGateway
  },
  {
    snapshotTimeoutMs: config.worker.serviceTimeoutMs,
    orderTimeoutMs: config.worker.serviceTimeoutMs,
    maxMarketAgeMs: config.worker.maxMarketAgeMs,
    maxFutureSkewMs: 1000,
    maxPriceDeviationBps: config.worker.maxPriceDeviationBps,
    maxSlippageBps: config.worker.maxSlippageBps,
    maxOrderQuantity: config.worker.maxOrderQuantity,
    maxSteps: config.worker.maxSteps
  }
);
const reconcile = new ReconcileUnknownOrder(
  { unitOfWork: staticUnitOfWork, orderGateway, orderEventHandler },
  config.worker.serviceTimeoutMs
);
const commonClaimOptions = {
  workerId: config.worker.id,
  taskLeaseMs: config.worker.taskLeaseMs,
  riskLockTtlMs: config.worker.riskLockTtlMs,
  priorityAgingIntervalSeconds: 60,
  recoveryBatchSize: 50
};
const recoveryClaim = new ClaimLiquidationTask(
  { unitOfWork: workerLeaseUnitOfWork, riskUnitLock },
  { ...commonClaimOptions, claimStatuses: ["NEEDS_RECONCILIATION"] }
);
const executionClaim = new ClaimLiquidationTask(
  { unitOfWork: workerLeaseUnitOfWork, riskUnitLock },
  { ...commonClaimOptions, claimStatuses: ["READY"] }
);
const taskLeaseRenewer = new RenewClaimedTaskLease(
  { unitOfWork: workerLeaseUnitOfWork, riskUnitLock },
  commonClaimOptions
);
const leaseRenewalIntervalMs = Math.max(
  10,
  Math.floor(config.worker.riskLockTtlMs / 3)
);
const outbox = new DispatchOutbox(
  {
    unitOfWork: new MysqlOutboxUnitOfWork(mysqlPool),
    publisher: new RoutingEventPublisher(
      new HttpEventPublisher(
        new UndiciJsonHttpTransport({
          baseUrl: config.services.eventPublisherBaseUrl,
          ...serviceTransportOptions
        })
      ),
      new RabbitLiquidationResultPublisher(
        rabbitResultChannel,
        config.rabbit.exchange,
        config.rabbit.resultRoutingKey
      )
    )
  },
  {
    workerId: `${config.worker.id}/outbox`,
    batchSize: 50,
    lockMs: 30_000,
    publishTimeoutMs: config.worker.serviceTimeoutMs,
    maxAttempts: 10,
    baseRetryMs: 1000,
    maxRetryMs: 60_000
  }
);
const abortController = new AbortController();

await redis.connect();
const runPromise = Promise.all([
  runTaskLoop(abortController.signal),
  runOutboxLoop(abortController.signal)
]);
installGracefulShutdown({
  logger,
  timeoutMs: config.shutdownTimeoutMs,
  hooks: [
    async () => {
      abortController.abort();
      await runPromise;
      await rabbitResultChannel.close();
      await rabbitConnection.close();
      await closeRedisClient(redis, logger);
      await closeMysqlPool(mysqlPool, logger);
    }
  ]
});

logger.info({ worker_id: config.worker.id }, "liquidation worker started");
await runPromise;

async function runTaskLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      let processed = false;
      const recovery = await recoveryClaim.execute();
      if (recovery.status === "CLAIMED") {
        const outcome = await withManagedRiskLock(recovery.claim, async (signal) => {
          const outcome = await reconcile.execute(recovery.claim, signal);
          logger.info({ task_id: recovery.claim.task.id, outcome: outcome.status }, "task reconciled");
          return outcome;
        });
        processed = true;
        if (outcome.status === "DEFERRED") {
          await delay(config.worker.pollMs, signal);
        }
      }

      const execution = await executionClaim.execute();
      if (execution.status === "CLAIMED") {
        await withManagedRiskLock(execution.claim, async (signal) => {
          const outcome = await executeStatic.execute(execution.claim, signal);
          logger.info({ task_id: execution.claim.task.id, outcome: outcome.status }, "task executed");
        });
        processed = true;
      }
      if (!processed) {
        await delay(config.worker.pollMs, signal);
      }
    } catch (error) {
      logger.error({ error }, "worker task loop failed");
      await delay(config.worker.pollMs, signal);
    }
  }
}

async function runOutboxLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await outbox.execute();
      if (result.claimed === 0) {
        await delay(config.worker.pollMs, signal);
      } else {
        logger.debug(result, "outbox batch dispatched");
      }
    } catch (error) {
      logger.error({ error }, "outbox loop failed");
      await delay(config.worker.pollMs, signal);
    }
  }
}

async function withManagedRiskLock<T>(
  claim: ClaimedLiquidationTask,
  action: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  try {
    return await runWithRenewedTaskLease({
      claim,
      renewer: taskLeaseRenewer,
      renewalIntervalMs: leaseRenewalIntervalMs,
      action
    });
  } finally {
    try {
      await riskUnitLock.release(claim.riskUnitLease);
    } catch (error) {
      logger.warn(
        { error, risk_unit_id: claim.riskUnitLease.riskUnitId },
        "risk-unit lock release failed"
      );
    }
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

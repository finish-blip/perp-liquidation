import { buildServer } from "../api/server.js";
import { HandleOrderEvent } from "../application/handle-order-event.js";
import { HandleSettlementEvent } from "../application/handle-settlement-event.js";
import { OperationApprovals } from "../application/operation-approvals.js";
import { ReceiveLiquidationCommand } from "../application/receive-liquidation-command.js";
import { loadConfig } from "../config/env.js";
import { MysqlApprovalUnitOfWork } from "../infrastructure/mysql/approval-unit-of-work.js";
import { MysqlCommandIntakeUnitOfWork } from "../infrastructure/mysql/command-intake-unit-of-work.js";
import { MysqlExecutionEventUnitOfWork } from "../infrastructure/mysql/execution-event-unit-of-work.js";
import { closeMysqlPool, createMysqlPool } from "../infrastructure/mysql/pool.js";
import { MysqlTaskReader } from "../infrastructure/mysql/task-reader.js";
import { BinanceFuturesMarketDataClient } from "../infrastructure/http-clients/binance-futures-market-data-client.js";
import { UndiciJsonHttpTransport } from "../infrastructure/http-clients/json-http-transport.js";
import { installGracefulShutdown } from "./lifecycle.js";
import { createLogger } from "../observability/logger.js";

const config = loadConfig();
const logger = createLogger(config, { component: "api" });
const mysqlPool = createMysqlPool(config);
const executionEvents = new MysqlExecutionEventUnitOfWork(mysqlPool);
const app = buildServer(config, logger, {
  commands: new ReceiveLiquidationCommand({
    unitOfWork: new MysqlCommandIntakeUnitOfWork(mysqlPool)
  }),
  orderEvents: new HandleOrderEvent(executionEvents),
  settlementEvents: new HandleSettlementEvent(executionEvents),
  tasks: new MysqlTaskReader(mysqlPool),
  marketData: new BinanceFuturesMarketDataClient(
    new UndiciJsonHttpTransport({
      baseUrl: config.binance.baseUrl,
      timeoutMs: config.binance.timeoutMs,
      maxGetAttempts: config.binance.maxGetAttempts
    }),
    { exchangeInfoTtlMs: config.binance.exchangeInfoTtlMs }
  ),
  approvals: new OperationApprovals(new MysqlApprovalUnitOfWork(mysqlPool)),
  readiness: {
    async check() {
      await mysqlPool.query("SELECT 1");
    }
  }
});

installGracefulShutdown({
  logger,
  timeoutMs: config.shutdownTimeoutMs,
  hooks: [
    async () => {
      await app.close();
      await closeMysqlPool(mysqlPool, logger);
    }
  ]
});

await app.listen({
  host: config.api.host,
  port: config.api.port
});

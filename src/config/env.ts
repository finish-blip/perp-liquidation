import { Ajv, type JSONSchemaType } from "ajv";

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type AppConfig = {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly api: {
    readonly host: string;
    readonly port: number;
    readonly serviceAuthToken: string | undefined;
  };
  readonly mysql: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
    readonly connectionLimit: number;
  };
  readonly redis: {
    readonly url: string;
  };
  readonly rabbit: {
    readonly url: string;
    readonly exchange: string;
    readonly commandQueue: string;
    readonly commandRoutingKey: string;
    readonly resultRoutingKey: string;
    readonly deadLetterExchange: string;
    readonly deadLetterQueue: string;
    readonly deadLetterRoutingKey: string;
    readonly retryExchange: string;
    readonly retryQueue: string;
    readonly retryRoutingKey: string;
    readonly retryDelayMs: number;
    readonly maxRetries: number;
    readonly prefetch: number;
  };
  readonly streams: {
    readonly commands: string;
    readonly orderEvents: string;
    readonly settlementEvents: string;
    readonly deadLetter: string;
    readonly group: string;
    readonly consumer: string;
    readonly batchSize: number;
    readonly blockMs: number;
    readonly reclaimMinIdleMs: number;
    readonly maxDeliveries: number;
    readonly errorBackoffMs: number;
  };
  readonly binance: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly maxGetAttempts: number;
    readonly exchangeInfoTtlMs: number;
    readonly smokeMarket: string;
  };
  readonly services: {
    readonly portfolioBaseUrl: string;
    readonly orderGatewayBaseUrl: string;
    readonly eventPublisherBaseUrl: string;
  };
  readonly worker: {
    readonly id: string;
    readonly pollMs: number;
    readonly taskLeaseMs: number;
    readonly riskLockTtlMs: number;
    readonly serviceTimeoutMs: number;
    readonly maxMarketAgeMs: number;
    readonly maxPriceDeviationBps: number;
    readonly maxSlippageBps: number;
    readonly maxOrderQuantity: string;
    readonly maxSteps: number;
  };
  readonly shutdownTimeoutMs: number;
};

type RawConfig = {
  NODE_ENV: NodeEnv;
  LOG_LEVEL: LogLevel;
  API_HOST: string;
  API_PORT: number;
  SERVICE_AUTH_TOKEN: string;
  MYSQL_HOST: string;
  MYSQL_PORT: number;
  MYSQL_USER: string;
  MYSQL_PASSWORD: string;
  MYSQL_DATABASE: string;
  MYSQL_CONNECTION_LIMIT: number;
  REDIS_URL: string;
  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
  RABBITMQ_COMMAND_QUEUE: string;
  RABBITMQ_COMMAND_ROUTING_KEY: string;
  RABBITMQ_RESULT_ROUTING_KEY: string;
  RABBITMQ_DEAD_LETTER_EXCHANGE: string;
  RABBITMQ_DEAD_LETTER_QUEUE: string;
  RABBITMQ_DEAD_LETTER_ROUTING_KEY: string;
  RABBITMQ_RETRY_EXCHANGE: string;
  RABBITMQ_RETRY_QUEUE: string;
  RABBITMQ_RETRY_ROUTING_KEY: string;
  RABBITMQ_RETRY_DELAY_MS: number;
  RABBITMQ_MAX_RETRIES: number;
  RABBITMQ_PREFETCH: number;
  STREAM_COMMANDS: string;
  STREAM_ORDER_EVENTS: string;
  STREAM_SETTLEMENT_EVENTS: string;
  STREAM_DEAD_LETTER: string;
  STREAM_GROUP: string;
  STREAM_CONSUMER: string;
  STREAM_BATCH_SIZE: number;
  STREAM_BLOCK_MS: number;
  STREAM_RECLAIM_MIN_IDLE_MS: number;
  STREAM_MAX_DELIVERIES: number;
  STREAM_ERROR_BACKOFF_MS: number;
  BINANCE_FUTURES_BASE_URL: string;
  BINANCE_TIMEOUT_MS: number;
  BINANCE_MAX_GET_ATTEMPTS: number;
  BINANCE_EXCHANGE_INFO_TTL_MS: number;
  BINANCE_SMOKE_MARKET: string;
  PORTFOLIO_BASE_URL: string;
  ORDER_GATEWAY_BASE_URL: string;
  EVENT_PUBLISHER_BASE_URL: string;
  WORKER_ID: string;
  WORKER_POLL_MS: number;
  TASK_LEASE_MS: number;
  RISK_LOCK_TTL_MS: number;
  SERVICE_TIMEOUT_MS: number;
  MAX_MARKET_AGE_MS: number;
  MAX_PRICE_DEVIATION_BPS: number;
  MAX_SLIPPAGE_BPS: number;
  MAX_ORDER_QUANTITY: string;
  MAX_EXECUTION_STEPS: number;
  SHUTDOWN_TIMEOUT_MS: number;
};

const schema: JSONSchemaType<RawConfig> = {
  type: "object",
  additionalProperties: false,
  required: [
    "NODE_ENV",
    "LOG_LEVEL",
    "API_HOST",
    "API_PORT",
    "SERVICE_AUTH_TOKEN",
    "MYSQL_HOST",
    "MYSQL_PORT",
    "MYSQL_USER",
    "MYSQL_PASSWORD",
    "MYSQL_DATABASE",
    "MYSQL_CONNECTION_LIMIT",
    "REDIS_URL",
    "RABBITMQ_URL",
    "RABBITMQ_EXCHANGE",
    "RABBITMQ_COMMAND_QUEUE",
    "RABBITMQ_COMMAND_ROUTING_KEY",
    "RABBITMQ_RESULT_ROUTING_KEY",
    "RABBITMQ_DEAD_LETTER_EXCHANGE",
    "RABBITMQ_DEAD_LETTER_QUEUE",
    "RABBITMQ_DEAD_LETTER_ROUTING_KEY",
    "RABBITMQ_RETRY_EXCHANGE",
    "RABBITMQ_RETRY_QUEUE",
    "RABBITMQ_RETRY_ROUTING_KEY",
    "RABBITMQ_RETRY_DELAY_MS",
    "RABBITMQ_MAX_RETRIES",
    "RABBITMQ_PREFETCH",
    "STREAM_COMMANDS",
    "STREAM_ORDER_EVENTS",
    "STREAM_SETTLEMENT_EVENTS",
    "STREAM_DEAD_LETTER",
    "STREAM_GROUP",
    "STREAM_CONSUMER",
    "STREAM_BATCH_SIZE",
    "STREAM_BLOCK_MS",
    "STREAM_RECLAIM_MIN_IDLE_MS",
    "STREAM_MAX_DELIVERIES",
    "STREAM_ERROR_BACKOFF_MS",
    "BINANCE_FUTURES_BASE_URL",
    "BINANCE_TIMEOUT_MS",
    "BINANCE_MAX_GET_ATTEMPTS",
    "BINANCE_EXCHANGE_INFO_TTL_MS",
    "BINANCE_SMOKE_MARKET",
    "PORTFOLIO_BASE_URL",
    "ORDER_GATEWAY_BASE_URL",
    "EVENT_PUBLISHER_BASE_URL",
    "WORKER_ID",
    "WORKER_POLL_MS",
    "TASK_LEASE_MS",
    "RISK_LOCK_TTL_MS",
    "SERVICE_TIMEOUT_MS",
    "MAX_MARKET_AGE_MS",
    "MAX_PRICE_DEVIATION_BPS",
    "MAX_SLIPPAGE_BPS",
    "MAX_ORDER_QUANTITY",
    "MAX_EXECUTION_STEPS",
    "SHUTDOWN_TIMEOUT_MS"
  ],
  properties: {
    NODE_ENV: { type: "string", enum: ["development", "test", "production"] },
    LOG_LEVEL: {
      type: "string",
      enum: ["trace", "debug", "info", "warn", "error", "fatal"]
    },
    API_HOST: { type: "string", minLength: 1 },
    API_PORT: { type: "integer", minimum: 1, maximum: 65535 },
    SERVICE_AUTH_TOKEN: { type: "string", maxLength: 512 },
    MYSQL_HOST: { type: "string", minLength: 1 },
    MYSQL_PORT: { type: "integer", minimum: 1, maximum: 65535 },
    MYSQL_USER: { type: "string", minLength: 1 },
    MYSQL_PASSWORD: { type: "string" },
    MYSQL_DATABASE: { type: "string", minLength: 1 },
    MYSQL_CONNECTION_LIMIT: { type: "integer", minimum: 1, maximum: 100 },
    REDIS_URL: { type: "string", pattern: "^redis(s)?://" },
    RABBITMQ_URL: { type: "string", pattern: "^amqps?://" },
    RABBITMQ_EXCHANGE: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_COMMAND_QUEUE: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_COMMAND_ROUTING_KEY: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_RESULT_ROUTING_KEY: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_DEAD_LETTER_EXCHANGE: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_DEAD_LETTER_QUEUE: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_DEAD_LETTER_ROUTING_KEY: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_RETRY_EXCHANGE: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_RETRY_QUEUE: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_RETRY_ROUTING_KEY: { type: "string", minLength: 1, maxLength: 255 },
    RABBITMQ_RETRY_DELAY_MS: { type: "integer", minimum: 100, maximum: 3600000 },
    RABBITMQ_MAX_RETRIES: { type: "integer", minimum: 0, maximum: 100 },
    RABBITMQ_PREFETCH: { type: "integer", minimum: 1, maximum: 1000 },
    STREAM_COMMANDS: { type: "string", minLength: 1, maxLength: 512 },
    STREAM_ORDER_EVENTS: { type: "string", minLength: 1, maxLength: 512 },
    STREAM_SETTLEMENT_EVENTS: { type: "string", minLength: 1, maxLength: 512 },
    STREAM_DEAD_LETTER: { type: "string", minLength: 1, maxLength: 512 },
    STREAM_GROUP: { type: "string", minLength: 1, maxLength: 128 },
    STREAM_CONSUMER: { type: "string", minLength: 1, maxLength: 128 },
    STREAM_BATCH_SIZE: { type: "integer", minimum: 1, maximum: 1000 },
    STREAM_BLOCK_MS: { type: "integer", minimum: 1, maximum: 60000 },
    STREAM_RECLAIM_MIN_IDLE_MS: { type: "integer", minimum: 1000, maximum: 3600000 },
    STREAM_MAX_DELIVERIES: { type: "integer", minimum: 1, maximum: 100 },
    STREAM_ERROR_BACKOFF_MS: { type: "integer", minimum: 10, maximum: 60000 },
    BINANCE_FUTURES_BASE_URL: { type: "string", pattern: "^https://" },
    BINANCE_TIMEOUT_MS: { type: "integer", minimum: 100, maximum: 30000 },
    BINANCE_MAX_GET_ATTEMPTS: { type: "integer", minimum: 1, maximum: 3 },
    BINANCE_EXCHANGE_INFO_TTL_MS: {
      type: "integer",
      minimum: 1000,
      maximum: 86400000
    },
    BINANCE_SMOKE_MARKET: { type: "string", pattern: "^[A-Z0-9]{2,32}$" },
    PORTFOLIO_BASE_URL: { type: "string", pattern: "^https?://" },
    ORDER_GATEWAY_BASE_URL: { type: "string", pattern: "^https?://" },
    EVENT_PUBLISHER_BASE_URL: { type: "string", pattern: "^https?://" },
    WORKER_ID: { type: "string", minLength: 1, maxLength: 64 },
    WORKER_POLL_MS: { type: "integer", minimum: 10, maximum: 60000 },
    TASK_LEASE_MS: { type: "integer", minimum: 1000, maximum: 300000 },
    RISK_LOCK_TTL_MS: { type: "integer", minimum: 1000, maximum: 300000 },
    SERVICE_TIMEOUT_MS: { type: "integer", minimum: 100, maximum: 30000 },
    MAX_MARKET_AGE_MS: { type: "integer", minimum: 0, maximum: 60000 },
    MAX_PRICE_DEVIATION_BPS: { type: "integer", minimum: 0, maximum: 10000 },
    MAX_SLIPPAGE_BPS: { type: "integer", minimum: 0, maximum: 5000 },
    MAX_ORDER_QUANTITY: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" },
    MAX_EXECUTION_STEPS: { type: "integer", minimum: 1, maximum: 32 },
    SHUTDOWN_TIMEOUT_MS: { type: "integer", minimum: 1000, maximum: 60000 }
  }
};

const ajv = new Ajv({ allErrors: true, coerceTypes: true });
const validate = ajv.compile<RawConfig>(schema);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw: Record<string, unknown> = {
    NODE_ENV: env.NODE_ENV ?? "development",
    LOG_LEVEL: env.LOG_LEVEL ?? "info",
    API_HOST: env.API_HOST ?? "0.0.0.0",
    API_PORT: env.API_PORT ?? "3000",
    SERVICE_AUTH_TOKEN: env.SERVICE_AUTH_TOKEN ?? "",
    MYSQL_HOST: env.MYSQL_HOST ?? "127.0.0.1",
    MYSQL_PORT: env.MYSQL_PORT ?? "3306",
    MYSQL_USER: env.MYSQL_USER ?? "liquidation",
    MYSQL_PASSWORD: env.MYSQL_PASSWORD ?? "liquidation",
    MYSQL_DATABASE: env.MYSQL_DATABASE ?? "perp_liquidation",
    MYSQL_CONNECTION_LIMIT: env.MYSQL_CONNECTION_LIMIT ?? "10",
    REDIS_URL: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    RABBITMQ_URL: env.RABBITMQ_URL ?? "amqp://guest:guest@127.0.0.1:5672",
    RABBITMQ_EXCHANGE: env.RABBITMQ_EXCHANGE ?? "perpetual.events",
    RABBITMQ_COMMAND_QUEUE: env.RABBITMQ_COMMAND_QUEUE ?? "liquidation.commands.q",
    RABBITMQ_COMMAND_ROUTING_KEY:
      env.RABBITMQ_COMMAND_ROUTING_KEY ?? "risk.liquidation.requested.v1",
    RABBITMQ_RESULT_ROUTING_KEY:
      env.RABBITMQ_RESULT_ROUTING_KEY ?? "liquidation.execution.result.v1",
    RABBITMQ_DEAD_LETTER_EXCHANGE:
      env.RABBITMQ_DEAD_LETTER_EXCHANGE ?? "perpetual.dead-letter",
    RABBITMQ_DEAD_LETTER_QUEUE:
      env.RABBITMQ_DEAD_LETTER_QUEUE ?? "liquidation.commands.dlq",
    RABBITMQ_DEAD_LETTER_ROUTING_KEY:
      env.RABBITMQ_DEAD_LETTER_ROUTING_KEY ?? "liquidation.failed",
    RABBITMQ_RETRY_EXCHANGE: env.RABBITMQ_RETRY_EXCHANGE ?? "perpetual.retry",
    RABBITMQ_RETRY_QUEUE: env.RABBITMQ_RETRY_QUEUE ?? "liquidation.commands.retry.q",
    RABBITMQ_RETRY_ROUTING_KEY:
      env.RABBITMQ_RETRY_ROUTING_KEY ?? "liquidation.retry",
    RABBITMQ_RETRY_DELAY_MS: env.RABBITMQ_RETRY_DELAY_MS ?? "1000",
    RABBITMQ_MAX_RETRIES: env.RABBITMQ_MAX_RETRIES ?? "5",
    RABBITMQ_PREFETCH: env.RABBITMQ_PREFETCH ?? "10",
    STREAM_COMMANDS: env.STREAM_COMMANDS ?? "liquidation:{engine}:commands",
    STREAM_ORDER_EVENTS: env.STREAM_ORDER_EVENTS ?? "liquidation:{engine}:order-events",
    STREAM_SETTLEMENT_EVENTS:
      env.STREAM_SETTLEMENT_EVENTS ?? "liquidation:{engine}:settlement-events",
    STREAM_DEAD_LETTER: env.STREAM_DEAD_LETTER ?? "liquidation:{engine}:dead-letter",
    STREAM_GROUP: env.STREAM_GROUP ?? "liquidation-engine",
    STREAM_CONSUMER: env.STREAM_CONSUMER ?? "stream-consumer-1",
    STREAM_BATCH_SIZE: env.STREAM_BATCH_SIZE ?? "50",
    STREAM_BLOCK_MS: env.STREAM_BLOCK_MS ?? "1000",
    STREAM_RECLAIM_MIN_IDLE_MS: env.STREAM_RECLAIM_MIN_IDLE_MS ?? "30000",
    STREAM_MAX_DELIVERIES: env.STREAM_MAX_DELIVERIES ?? "5",
    STREAM_ERROR_BACKOFF_MS: env.STREAM_ERROR_BACKOFF_MS ?? "1000",
    BINANCE_FUTURES_BASE_URL:
      env.BINANCE_FUTURES_BASE_URL ?? "https://fapi.binance.com",
    BINANCE_TIMEOUT_MS: env.BINANCE_TIMEOUT_MS ?? "5000",
    BINANCE_MAX_GET_ATTEMPTS: env.BINANCE_MAX_GET_ATTEMPTS ?? "2",
    BINANCE_EXCHANGE_INFO_TTL_MS: env.BINANCE_EXCHANGE_INFO_TTL_MS ?? "300000",
    BINANCE_SMOKE_MARKET: env.BINANCE_SMOKE_MARKET ?? "BTCUSDT",
    PORTFOLIO_BASE_URL: env.PORTFOLIO_BASE_URL ?? "http://portfolio:3000",
    ORDER_GATEWAY_BASE_URL: env.ORDER_GATEWAY_BASE_URL ?? "http://order-gateway:3000",
    EVENT_PUBLISHER_BASE_URL: env.EVENT_PUBLISHER_BASE_URL ?? "http://event-publisher:3000",
    WORKER_ID: env.WORKER_ID ?? "liquidation-worker-1",
    WORKER_POLL_MS: env.WORKER_POLL_MS ?? "250",
    TASK_LEASE_MS: env.TASK_LEASE_MS ?? "30000",
    RISK_LOCK_TTL_MS: env.RISK_LOCK_TTL_MS ?? "20000",
    SERVICE_TIMEOUT_MS: env.SERVICE_TIMEOUT_MS ?? "3000",
    MAX_MARKET_AGE_MS: env.MAX_MARKET_AGE_MS ?? "5000",
    MAX_PRICE_DEVIATION_BPS: env.MAX_PRICE_DEVIATION_BPS ?? "500",
    MAX_SLIPPAGE_BPS: env.MAX_SLIPPAGE_BPS ?? "200",
    MAX_ORDER_QUANTITY: env.MAX_ORDER_QUANTITY ?? "1",
    MAX_EXECUTION_STEPS: env.MAX_EXECUTION_STEPS ?? "32",
    SHUTDOWN_TIMEOUT_MS: env.SHUTDOWN_TIMEOUT_MS ?? "10000"
  };

  if (!validate(raw)) {
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(`Invalid application configuration: ${details}`);
  }
  if (raw.RISK_LOCK_TTL_MS > raw.TASK_LEASE_MS) {
    throw new Error("Invalid application configuration: RISK_LOCK_TTL_MS exceeds TASK_LEASE_MS");
  }
  if (raw.NODE_ENV === "production" && raw.SERVICE_AUTH_TOKEN.length < 16) {
    throw new Error(
      "Invalid application configuration: SERVICE_AUTH_TOKEN must contain at least 16 characters in production"
    );
  }

  return {
    nodeEnv: raw.NODE_ENV,
    logLevel: raw.LOG_LEVEL,
    api: {
      host: raw.API_HOST,
      port: raw.API_PORT,
      serviceAuthToken:
        raw.SERVICE_AUTH_TOKEN.length === 0 ? undefined : raw.SERVICE_AUTH_TOKEN
    },
    mysql: {
      host: raw.MYSQL_HOST,
      port: raw.MYSQL_PORT,
      user: raw.MYSQL_USER,
      password: raw.MYSQL_PASSWORD,
      database: raw.MYSQL_DATABASE,
      connectionLimit: raw.MYSQL_CONNECTION_LIMIT
    },
    redis: {
      url: raw.REDIS_URL
    },
    rabbit: {
      url: raw.RABBITMQ_URL,
      exchange: raw.RABBITMQ_EXCHANGE,
      commandQueue: raw.RABBITMQ_COMMAND_QUEUE,
      commandRoutingKey: raw.RABBITMQ_COMMAND_ROUTING_KEY,
      resultRoutingKey: raw.RABBITMQ_RESULT_ROUTING_KEY,
      deadLetterExchange: raw.RABBITMQ_DEAD_LETTER_EXCHANGE,
      deadLetterQueue: raw.RABBITMQ_DEAD_LETTER_QUEUE,
      deadLetterRoutingKey: raw.RABBITMQ_DEAD_LETTER_ROUTING_KEY,
      retryExchange: raw.RABBITMQ_RETRY_EXCHANGE,
      retryQueue: raw.RABBITMQ_RETRY_QUEUE,
      retryRoutingKey: raw.RABBITMQ_RETRY_ROUTING_KEY,
      retryDelayMs: raw.RABBITMQ_RETRY_DELAY_MS,
      maxRetries: raw.RABBITMQ_MAX_RETRIES,
      prefetch: raw.RABBITMQ_PREFETCH
    },
    streams: {
      commands: raw.STREAM_COMMANDS,
      orderEvents: raw.STREAM_ORDER_EVENTS,
      settlementEvents: raw.STREAM_SETTLEMENT_EVENTS,
      deadLetter: raw.STREAM_DEAD_LETTER,
      group: raw.STREAM_GROUP,
      consumer: raw.STREAM_CONSUMER,
      batchSize: raw.STREAM_BATCH_SIZE,
      blockMs: raw.STREAM_BLOCK_MS,
      reclaimMinIdleMs: raw.STREAM_RECLAIM_MIN_IDLE_MS,
      maxDeliveries: raw.STREAM_MAX_DELIVERIES,
      errorBackoffMs: raw.STREAM_ERROR_BACKOFF_MS
    },
    binance: {
      baseUrl: raw.BINANCE_FUTURES_BASE_URL,
      timeoutMs: raw.BINANCE_TIMEOUT_MS,
      maxGetAttempts: raw.BINANCE_MAX_GET_ATTEMPTS,
      exchangeInfoTtlMs: raw.BINANCE_EXCHANGE_INFO_TTL_MS,
      smokeMarket: raw.BINANCE_SMOKE_MARKET
    },
    services: {
      portfolioBaseUrl: raw.PORTFOLIO_BASE_URL,
      orderGatewayBaseUrl: raw.ORDER_GATEWAY_BASE_URL,
      eventPublisherBaseUrl: raw.EVENT_PUBLISHER_BASE_URL
    },
    worker: {
      id: raw.WORKER_ID,
      pollMs: raw.WORKER_POLL_MS,
      taskLeaseMs: raw.TASK_LEASE_MS,
      riskLockTtlMs: raw.RISK_LOCK_TTL_MS,
      serviceTimeoutMs: raw.SERVICE_TIMEOUT_MS,
      maxMarketAgeMs: raw.MAX_MARKET_AGE_MS,
      maxPriceDeviationBps: raw.MAX_PRICE_DEVIATION_BPS,
      maxSlippageBps: raw.MAX_SLIPPAGE_BPS,
      maxOrderQuantity: raw.MAX_ORDER_QUANTITY,
      maxSteps: raw.MAX_EXECUTION_STEPS
    },
    shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS
  };
}

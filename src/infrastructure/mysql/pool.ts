import mysql, { type Pool, type PoolOptions } from "mysql2/promise";

import type { AppConfig } from "../../config/env.js";
import type { AppLogger } from "../../observability/logger.js";

export function createMysqlPool(config: AppConfig): Pool {
  const options: PoolOptions = {
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    connectionLimit: config.mysql.connectionLimit,
    waitForConnections: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    decimalNumbers: false,
    namedPlaceholders: true
  };

  return mysql.createPool(options);
}

export async function closeMysqlPool(pool: Pool, logger?: AppLogger): Promise<void> {
  logger?.info("closing mysql pool");
  await pool.end();
}

import { pino, type Logger, type LoggerOptions } from "pino";

import type { AppConfig } from "../config/env.js";

export type AppLogger = Logger;

export function createLogger(
  config: AppConfig,
  bindings: Record<string, string> = {}
): AppLogger {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: {
      service: "perp-liquidation-node",
      environment: config.nodeEnv,
      ...bindings
    },
    timestamp: pino.stdTimeFunctions.isoTime
  };

  return pino(options);
}

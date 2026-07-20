import type { AppLogger } from "../observability/logger.js";

export type ShutdownHook = (signal: NodeJS.Signals) => Promise<void> | void;

export type GracefulShutdownOptions = {
  readonly logger: AppLogger;
  readonly timeoutMs: number;
  readonly hooks: readonly ShutdownHook[];
};

export function installGracefulShutdown(options: GracefulShutdownOptions): () => void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    options.logger.info({ signal }, "shutdown requested");

    const timeout = setTimeout(() => {
      options.logger.error({ signal, timeoutMs: options.timeoutMs }, "shutdown timed out");
      process.exit(1);
    }, options.timeoutMs);
    timeout.unref();

    try {
      for (const hook of options.hooks) {
        await hook(signal);
      }

      clearTimeout(timeout);
      options.logger.info({ signal }, "shutdown complete");
      process.exit(0);
    } catch (error) {
      clearTimeout(timeout);
      options.logger.error({ error, signal }, "shutdown failed");
      process.exit(1);
    }
  };

  const onSigint = (): void => {
    void shutdown("SIGINT");
  };
  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

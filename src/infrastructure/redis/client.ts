import { Redis } from "ioredis";

import type { AppConfig } from "../../config/env.js";
import type { AppLogger } from "../../observability/logger.js";

export function createRedisClient(config: AppConfig): Redis {
  return new Redis(config.redis.url, {
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    stringNumbers: true
  });
}

export async function closeRedisClient(client: Redis, logger?: AppLogger): Promise<void> {
  logger?.info("closing redis client");

  if (client.status === "wait" || client.status === "end") {
    client.disconnect();
    return;
  }

  await client.quit();
}

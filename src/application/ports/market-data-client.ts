import type { MarketSnapshot } from "../../domain/execution/market-snapshot.js";

export type GetMarketSnapshotInput = {
  readonly market: string;
  readonly correlationId: string;
  readonly signal: AbortSignal | undefined;
};

export type MarketDataClient = {
  getSnapshot(input: GetMarketSnapshotInput): Promise<MarketSnapshot>;
};

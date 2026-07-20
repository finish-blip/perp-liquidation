import type { PositionSnapshot } from "../../domain/portfolio/position-snapshot.js";

export type GetPositionInput = {
  readonly positionId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal | undefined;
};

export type PortfolioClient = {
  getPosition(input: GetPositionInput): Promise<PositionSnapshot>;
};

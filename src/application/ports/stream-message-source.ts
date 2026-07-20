import type { UtcIsoString } from "../../domain/shared/time.js";

export type StreamMessage = {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly deliveryCount: number;
  readonly reclaimed: boolean;
};

export type ReclaimedStreamMessages = {
  readonly nextCursor: string;
  readonly messages: readonly StreamMessage[];
};

export type StreamMessageSource = {
  ensureGroup(): Promise<void>;
  readNew(input: {
    readonly count: number;
    readonly blockMs: number;
  }): Promise<readonly StreamMessage[]>;
  reclaim(input: {
    readonly cursor: string;
    readonly count: number;
    readonly minIdleMs: number;
  }): Promise<ReclaimedStreamMessages>;
  acknowledge(messageId: string): Promise<void>;
  deadLetter(input: {
    readonly message: StreamMessage;
    readonly error: string;
    readonly failedAt: UtcIsoString;
  }): Promise<void>;
};

import type { ReceiveLiquidationCommand } from "./receive-liquidation-command.js";
import {
  mapRiskLiquidationEventToCommand,
  parseRiskLiquidationRequestedV1
} from "../domain/integration/risk-liquidation-event.js";
import { nowUtcIso, toEpochMillis, type UtcIsoString } from "../domain/shared/time.js";

export type ReceiveRiskLiquidationEventOutcome =
  | Awaited<ReturnType<ReceiveLiquidationCommand["execute"]>>
  | {
      readonly status: "EXPIRED";
      readonly eventId: string;
      readonly riskDecisionId: string;
    };

export type ReceiveRiskLiquidationEventResult = {
  readonly outcome: ReceiveRiskLiquidationEventOutcome;
  readonly context: {
    readonly eventId: string;
    readonly riskDecisionId: string;
    readonly positionId: string;
    readonly positionVersion: string;
    readonly requestedSize: string;
  };
  readonly usedDerivedDecisionSequence: boolean;
  readonly usedDerivedRiskUnitId: boolean;
};

export class ReceiveRiskLiquidationEvent {
  private readonly clock: () => Date;

  constructor(
    private readonly receiver: Pick<ReceiveLiquidationCommand, "execute">,
    clock: () => Date = () => new Date()
  ) {
    this.clock = clock;
  }

  async execute(input: {
    readonly payload: unknown;
    readonly receivedAt?: UtcIsoString;
  }): Promise<ReceiveRiskLiquidationEventResult> {
    const event = parseRiskLiquidationRequestedV1(input.payload);
    const mapped = mapRiskLiquidationEventToCommand(event);
    const receivedAt = input.receivedAt ?? nowUtcIso(this.clock);
    const context = {
      eventId: event.eventId,
      riskDecisionId: event.data.riskDecisionId,
      positionId: event.data.positionId,
      positionVersion: mapped.payload.position_version,
      requestedSize: mapped.payload.quantity
    };

    if (toEpochMillis(event.data.expireAt) <= toEpochMillis(receivedAt)) {
      return {
        outcome: {
          status: "EXPIRED",
          eventId: event.eventId,
          riskDecisionId: event.data.riskDecisionId
        },
        context,
        usedDerivedDecisionSequence: mapped.usedDerivedDecisionSequence,
        usedDerivedRiskUnitId: mapped.usedDerivedRiskUnitId
      };
    }

    return {
      outcome: await this.receiver.execute({
        source: mapped.source,
        payload: mapped.payload,
        receivedAt
      }),
      context,
      usedDerivedDecisionSequence: mapped.usedDerivedDecisionSequence,
      usedDerivedRiskUnitId: mapped.usedDerivedRiskUnitId
    };
  }
}

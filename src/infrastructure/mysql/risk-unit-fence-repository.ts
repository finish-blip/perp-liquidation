import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { ConflictError, InvariantViolationError } from "../../domain/shared/errors.js";
import { toEpochMillis } from "../../domain/shared/time.js";
import type {
  ActivateRiskUnitFenceInput,
  AssertRiskUnitFenceInput,
  RiskUnitFence,
  RiskUnitFenceRepository
} from "../../repositories/risk-unit-fence-repository.js";
import { fromMysqlDateTime, toMysqlDateTime } from "./mapping.js";

type RiskUnitFenceRow = RowDataPacket & {
  readonly risk_unit_id: string;
  readonly fencing_token: string;
  readonly owner: string;
  readonly expires_at: string;
};

export class MysqlRiskUnitFenceRepository implements RiskUnitFenceRepository {
  constructor(private readonly connection: PoolConnection) {}

  async activate(input: ActivateRiskUnitFenceInput): Promise<RiskUnitFence> {
    assertPositiveToken(input.fencingToken);
    if (toEpochMillis(input.expiresAt) <= toEpochMillis(input.now)) {
      throw new ConflictError("Risk-unit fence expiry must be in the future", {
        riskUnitId: input.riskUnitId
      });
    }
    const current = await this.findForUpdate(input.riskUnitId);
    const now = toMysqlDateTime(input.now);
    const expiresAt = toMysqlDateTime(input.expiresAt);

    if (current === undefined) {
      await this.connection.execute(
        `INSERT INTO risk_unit_leases (
          risk_unit_id, fencing_token, owner, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.riskUnitId,
          input.fencingToken.toString(),
          input.owner,
          expiresAt,
          now,
          now
        ]
      );
      return toFence(input);
    }

    if (
      input.fencingToken < current.fencingToken ||
      (input.fencingToken === current.fencingToken && input.owner !== current.owner)
    ) {
      throw staleFenceError(input, current);
    }

    if (input.fencingToken === current.fencingToken) {
      if (toEpochMillis(current.expiresAt) <= toEpochMillis(input.now)) {
        throw staleFenceError(input, current);
      }
      if (toEpochMillis(input.expiresAt) <= toEpochMillis(current.expiresAt)) {
        return current;
      }
    }

    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE risk_unit_leases
       SET fencing_token = ?, owner = ?, expires_at = ?, updated_at = ?
       WHERE risk_unit_id = ? AND fencing_token <= ?`,
      [
        input.fencingToken.toString(),
        input.owner,
        expiresAt,
        now,
        input.riskUnitId,
        input.fencingToken.toString()
      ]
    );
    if (result.affectedRows !== 1) {
      throw new ConflictError("Risk-unit fence changed during activation", {
        riskUnitId: input.riskUnitId
      });
    }

    return toFence(input);
  }

  async assertCurrent(input: AssertRiskUnitFenceInput): Promise<void> {
    assertPositiveToken(input.fencingToken);
    const current = await this.findForUpdate(input.riskUnitId);
    if (current === undefined) {
      throw new ConflictError("Risk-unit fence does not exist", {
        riskUnitId: input.riskUnitId
      });
    }

    if (
      current.owner !== input.owner ||
      current.fencingToken !== input.fencingToken ||
      toEpochMillis(current.expiresAt) <= toEpochMillis(input.now)
    ) {
      throw staleFenceError(input, current);
    }
  }

  private async findForUpdate(riskUnitId: string): Promise<RiskUnitFence | undefined> {
    const [rows] = await this.connection.execute<RiskUnitFenceRow[]>(
      `SELECT risk_unit_id, fencing_token, owner, expires_at
       FROM risk_unit_leases
       WHERE risk_unit_id = ?
       FOR UPDATE`,
      [riskUnitId]
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }

    return {
      riskUnitId: row.risk_unit_id,
      owner: row.owner,
      fencingToken: BigInt(row.fencing_token),
      expiresAt: fromMysqlDateTime(row.expires_at)
    };
  }

  async revoke(riskUnitId: string): Promise<void> {
    await this.connection.execute(
      `DELETE FROM risk_unit_leases WHERE risk_unit_id = ?`,
      [riskUnitId]
    );
  }
}

function toFence(input: ActivateRiskUnitFenceInput): RiskUnitFence {
  return {
    riskUnitId: input.riskUnitId,
    owner: input.owner,
    fencingToken: input.fencingToken,
    expiresAt: input.expiresAt
  };
}

function assertPositiveToken(token: bigint): void {
  if (token <= 0n) {
    throw new InvariantViolationError("Fencing token must be positive", {
      fencingToken: token.toString()
    });
  }
}

function staleFenceError(
  attempted: AssertRiskUnitFenceInput,
  current: RiskUnitFence
): ConflictError {
  return new ConflictError("Risk-unit fencing token is stale", {
    riskUnitId: attempted.riskUnitId,
    attemptedOwner: attempted.owner,
    attemptedFencingToken: attempted.fencingToken.toString(),
    currentOwner: current.owner,
    currentFencingToken: current.fencingToken.toString()
  });
}

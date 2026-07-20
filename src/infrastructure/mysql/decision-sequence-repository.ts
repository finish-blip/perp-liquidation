import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { InvariantViolationError } from "../../domain/shared/errors.js";
import { assertEntityId } from "../../domain/shared/id.js";
import type {
  ClaimDecisionSequenceInput,
  DecisionSequenceClaim,
  DecisionSequenceRepository
} from "../../repositories/decision-sequence-repository.js";
import { toMysqlDateTime } from "./mapping.js";

type DecisionSequenceRow = RowDataPacket & {
  readonly latest_decision_sequence: string;
  readonly latest_task_id: string;
};

export class MysqlDecisionSequenceRepository implements DecisionSequenceRepository {
  constructor(private readonly connection: PoolConnection) {}

  async claim(input: ClaimDecisionSequenceInput): Promise<DecisionSequenceClaim> {
    const claimedAt = toMysqlDateTime(input.claimedAt);
    const [insertResult] = await this.connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO risk_unit_command_sequences (
        risk_unit_id, latest_decision_sequence, latest_message_id, latest_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.riskUnitId,
        input.decisionSequence.toString(),
        input.messageId,
        input.taskId,
        claimedAt,
        claimedAt
      ]
    );

    if (insertResult.affectedRows === 1) {
      return {
        status: "ACCEPTED",
        supersededTaskId: undefined
      };
    }

    const [rows] = await this.connection.execute<DecisionSequenceRow[]>(
      `SELECT latest_decision_sequence, latest_task_id
       FROM risk_unit_command_sequences
       WHERE risk_unit_id = ?
       FOR UPDATE`,
      [input.riskUnitId]
    );
    const current = rows[0];

    if (current === undefined) {
      throw new InvariantViolationError("Risk-unit sequence row disappeared during claim", {
        riskUnitId: input.riskUnitId
      });
    }

    const latestDecisionSequence = BigInt(current.latest_decision_sequence);
    const existingTaskId = assertEntityId(current.latest_task_id, "task");

    if (input.decisionSequence <= latestDecisionSequence) {
      return {
        status: "STALE_SEQUENCE",
        latestDecisionSequence,
        existingTaskId
      };
    }

    const [updateResult] = await this.connection.execute<ResultSetHeader>(
      `UPDATE risk_unit_command_sequences
       SET latest_decision_sequence = ?, latest_message_id = ?, latest_task_id = ?, updated_at = ?
       WHERE risk_unit_id = ? AND latest_decision_sequence = ?`,
      [
        input.decisionSequence.toString(),
        input.messageId,
        input.taskId,
        claimedAt,
        input.riskUnitId,
        latestDecisionSequence.toString()
      ]
    );

    if (updateResult.affectedRows !== 1) {
      throw new InvariantViolationError("Risk-unit sequence changed while its row was locked", {
        riskUnitId: input.riskUnitId
      });
    }

    return {
      status: "ACCEPTED",
      supersededTaskId: existingTaskId
    };
  }
}

import { describe, expect, it } from "vitest";

import {
  InvalidStateTransitionError,
  canTransition,
  isFinalStatus,
  transition,
  type TaskState
} from "../../../../src/domain/liquidation/task-state.js";
import { deterministicEntityId } from "../../../../src/domain/shared/id.js";
import { assertUtcIsoString } from "../../../../src/domain/shared/time.js";

describe("task state machine", () => {
  const initialState: TaskState = {
    id: deterministicEntityId("task", ["message-1"]),
    status: "RECEIVED",
    version: 0,
    updatedAt: assertUtcIsoString("2026-07-18T00:00:00.000Z")
  };

  it("transitions through the happy path", () => {
    const ready = transition(initialState, "READY", {
      at: assertUtcIsoString("2026-07-18T00:00:01.000Z")
    });
    const claimed = transition(ready, "CLAIMED", {
      at: assertUtcIsoString("2026-07-18T00:00:02.000Z")
    });

    expect(ready.status).toBe("READY");
    expect(claimed.status).toBe("CLAIMED");
    expect(claimed.version).toBe(2);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("RECEIVED", "COMPLETED")).toBe(false);
    expect(() =>
      transition(initialState, "COMPLETED", {
        at: assertUtcIsoString("2026-07-18T00:00:01.000Z")
      })
    ).toThrow(InvalidStateTransitionError);
  });

  it("treats completed, failed, and cancelled as final", () => {
    expect(isFinalStatus("COMPLETED")).toBe(true);
    expect(isFinalStatus("FAILED")).toBe(true);
    expect(isFinalStatus("CANCELLED")).toBe(true);
    expect(isFinalStatus("READY")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  assertEntityId,
  deterministicClientOrderId,
  deterministicEntityId,
  newTaskId
} from "../../../../src/domain/shared/id.js";

describe("id primitives", () => {
  it("creates prefixed ids", () => {
    const taskId = newTaskId();

    expect(taskId.startsWith("task_")).toBe(true);
    expect(assertEntityId(taskId, "task")).toBe(taskId);
  });

  it("creates deterministic ids from stable parts", () => {
    expect(deterministicEntityId("risk", ["account-1", "BTCUSDT"])).toBe(
      deterministicEntityId("risk", ["account-1", "BTCUSDT"])
    );
  });

  it("creates deterministic client order ids for retries", () => {
    const taskId = deterministicEntityId("task", ["command-1"]);

    expect(
      deterministicClientOrderId({
        taskId,
        stepSequence: 1,
        attemptSequence: 1
      })
    ).toBe(
      deterministicClientOrderId({
        taskId,
        stepSequence: 1,
        attemptSequence: 1
      })
    );
  });
});

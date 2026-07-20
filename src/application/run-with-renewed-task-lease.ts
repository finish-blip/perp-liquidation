import type { ClaimedLiquidationTask } from "./claim-liquidation-task.js";
import { ConflictError, ValidationError } from "../domain/shared/errors.js";

export type TaskLeaseRenewer = {
  execute(claim: ClaimedLiquidationTask): Promise<boolean>;
};

export async function runWithRenewedTaskLease<T>(input: {
  readonly claim: ClaimedLiquidationTask;
  readonly renewer: TaskLeaseRenewer;
  readonly renewalIntervalMs: number;
  readonly action: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  validateInterval(input.renewalIntervalMs);
  const stopController = new AbortController();
  const actionController = new AbortController();
  let leaseFailure: unknown;
  let outcome: { readonly succeeded: true; readonly value: T } | {
    readonly succeeded: false;
    readonly error: unknown;
  };

  const heartbeat = renewUntilStopped(
    input,
    stopController.signal,
    actionController,
    (error) => {
      leaseFailure = error;
    }
  );

  try {
    outcome = {
      succeeded: true,
      value: await input.action(actionController.signal)
    };
  } catch (error) {
    outcome = { succeeded: false, error };
  } finally {
    stopController.abort();
    await heartbeat;
  }

  if (!outcome.succeeded && leaseFailure !== undefined) {
    throw toError(leaseFailure);
  }
  if (!outcome.succeeded) {
    throw toError(outcome.error);
  }
  return outcome.value;
}

async function renewUntilStopped(
  input: Pick<
    Parameters<typeof runWithRenewedTaskLease>[0],
    "claim" | "renewer" | "renewalIntervalMs"
  >,
  stopSignal: AbortSignal,
  actionController: AbortController,
  recordFailure: (error: unknown) => void
): Promise<void> {
  while (!stopSignal.aborted) {
    if (!(await delay(input.renewalIntervalMs, stopSignal))) {
      return;
    }

    try {
      const renewed = await input.renewer.execute(input.claim);
      if (!renewed) {
        throw new ConflictError("Task lease was lost during execution", {
          taskId: input.claim.task.id
        });
      }
    } catch (error) {
      recordFailure(error);
      actionController.abort(error);
      return;
    }
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const finish = (elapsed: boolean): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(elapsed);
    };
    const abort = (): void => {
      finish(false);
    };
    const timeout = setTimeout(() => {
      finish(true);
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Task lease execution failed", { cause: value });
}

function validateInterval(value: number): void {
  if (!Number.isInteger(value) || value < 10 || value > 300_000) {
    throw new ValidationError("renewalIntervalMs must be between 10 and 300000");
  }
}

// Real-boundary regression coverage: a genuine worker-pool deadline must stop
// model fallback (coordination), while a genuine provider HTTP timeout must
// still rotate. The deadline fires through the pool's production timer
// (worker-task-pool-core.ts:522) while runWithModelFallback is awaiting the
// candidate attempt, so the context-worker failure reaches the fallback owner
// during one connected turn. Only the deadline timers are faked; the worker
// spawn and IPC stay real, and the check never depends on CI scheduling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveModelFallbackError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

const workerUrl = resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker);
const pools: WorkerTaskPool<unknown, { label: string }>[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.useRealTimers();
});

/**
 * A task input factory that never resolves keeps the task in preparation, so
 * the pool's own deadline timer aborts it with the production
 * WorkerTaskError("worker task timed out", "timeout").
 */
async function runPoolTaskWithDeadline(
  pool: WorkerTaskPool<unknown, { label: string }>,
): Promise<Error> {
  let releasePreparation: (() => void) | undefined;
  const pending = pool.run(
    () =>
      new Promise<void>((resolve) => {
        releasePreparation = resolve;
      }),
    { timeoutMs: 50 },
  );
  try {
    return (await pending.catch((value: unknown) => value)) as Error & { code?: string };
  } finally {
    releasePreparation?.();
  }
}

const fallbackOptions = {
  cfg: undefined,
  provider: "fixture-primary",
  model: "fixture-model",
  manifestPlugins: [],
  fallbacksOverride: ["fixture-next/fixture-model"],
  sessionId: "worker-deadline-session",
  lane: "worker-deadline-lane",
};

describe("model fallback with a real local worker deadline", () => {
  it("stops fallback when a real pool deadline fires during the connected turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pool = new WorkerTaskPool<unknown, { label: string }>({ workerUrl, maxWorkers: 1 });
    pools.push(pool);
    try {
      // The candidate attempt performs context-worker work during the turn; that
      // work hangs and the host deadline aborts it while the fallback owner is
      // awaiting this attempt.
      const run = vi.fn<() => Promise<string>>().mockImplementation(async () => {
        throw await runPoolTaskWithDeadline(pool);
      });
      const attempt = runWithModelFallback({ ...fallbackOptions, run });
      // Attach the handler before advancing so the rejection that the deadline
      // triggers is always handled, then let the owner reach the candidate
      // attempt (microtask-only path when cfg is unset) and fire the production
      // deadline timer deterministically.
      const errorPromise = attempt.catch((value: unknown) => value);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      const error = (await errorPromise) as Error & { code?: string };
      expect(error).toMatchObject({
        name: "WorkerTaskError",
        code: "timeout",
        message: "worker task timed out",
      });
      expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rotates models for a genuine provider HTTP 408 timeout", async () => {
    const provider408 = Object.assign(new Error("request timed out"), { status: 408 });
    const resolution = resolveModelFallbackError(provider408);
    expect(resolution.kind).toBe("failover");
    if (resolution.kind === "failover") {
      expect(resolution.error.reason).toBe("timeout");
      expect(resolution.error.status).toBe(408);
    }

    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(provider408)
      .mockResolvedValueOnce("fallback candidate ran");
    const result = await runWithModelFallback({ ...fallbackOptions, run });
    expect(result.outcome).toBe("completed");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

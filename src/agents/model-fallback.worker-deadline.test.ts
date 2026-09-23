// Real-boundary regression coverage: a genuine worker-pool deadline is detected
// as local infrastructure (so reply copy stays accurate) while the configured
// fallback chain is preserved — a later candidate rebuilds its own context and
// can recover from an intermittent worker deadline. A genuine provider HTTP
// timeout also keeps rotating. Only the deadline timers are faked; the worker
// spawn and IPC stay real, and the check never depends on CI scheduling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { hasLocalWorkerTaskTimeout, resolveModelFallbackError } from "./failover-error.js";
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
  it("preserves configured fallback when a real pool deadline fires during the turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pool = new WorkerTaskPool<unknown, { label: string }>({ workerUrl, maxWorkers: 1 });
    pools.push(pool);
    try {
      // The first candidate performs context-worker work during the turn; that
      // work hangs and the host deadline aborts it while the fallback owner is
      // awaiting this attempt. The deadline is still detected as local, but the
      // configured chain must advance so a later candidate can recover.
      const run = vi.fn<() => Promise<string>>().mockImplementation(async () => {
        if (run.mock.calls.length === 1) {
          const deadline = await runPoolTaskWithDeadline(pool);
          expect(hasLocalWorkerTaskTimeout(deadline)).toBe(true);
          expect(resolveModelFallbackError(deadline).kind).toBe("failover");
          throw deadline;
        }
        return "fallback candidate ran";
      });
      const attempt = runWithModelFallback({ ...fallbackOptions, run });
      // Attach the handler before advancing so the rejection that the deadline
      // triggers is always handled, then let the owner reach the candidate
      // attempt (microtask-only path when cfg is unset) and fire the production
      // deadline timer deterministically.
      const resultPromise = attempt.then(
        (value) => ({ ok: true as const, value }),
        (value) => ({ ok: false as const, value }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe("completed");
      }
      expect(run).toHaveBeenCalledTimes(2);
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

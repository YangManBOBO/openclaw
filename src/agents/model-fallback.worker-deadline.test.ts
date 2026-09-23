// Real-boundary regression coverage: a genuine worker-pool deadline must stop
// model fallback (coordination), while a genuine provider HTTP timeout must
// still rotate. Unlike the classifier unit tests, this drives the actual
// WorkerTaskPool deadline path (worker-task-pool-core.ts) into the production
// runWithModelFallback owner.
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
});

/**
 * Produces a real WorkerTaskError from the pool's own deadline timer: a task
 * input factory that never resolves keeps the task in preparation, so the
 * deadline (worker-task-pool-core.ts:525) aborts it with the production error.
 */
async function produceRealWorkerDeadline(): Promise<Error> {
  const pool = new WorkerTaskPool<unknown, { label: string }>({ workerUrl, maxWorkers: 1 });
  pools.push(pool);
  let releasePreparation: (() => void) | undefined;
  try {
    const pending = pool.run(
      () =>
        new Promise<void>((resolve) => {
          releasePreparation = resolve;
        }),
      { timeoutMs: 50 },
    );
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
  it("stops fallback on a real pool deadline without rotating to another model", async () => {
    const realDeadline = await produceRealWorkerDeadline();
    expect(realDeadline).toMatchObject({
      name: "WorkerTaskError",
      code: "timeout",
      message: "worker task timed out",
    });

    const resolution = resolveModelFallbackError(realDeadline);
    expect(resolution).toEqual({ kind: "coordination", error: realDeadline });

    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(realDeadline)
      .mockResolvedValueOnce("must not run");
    await expect(runWithModelFallback({ ...fallbackOptions, run })).rejects.toBe(realDeadline);
    expect(run).toHaveBeenCalledTimes(1);
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

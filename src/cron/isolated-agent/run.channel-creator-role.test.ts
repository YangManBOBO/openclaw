import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const { prepareCronRunContext } = await import("./run-prepare.js");
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeRolesCfg() {
  return {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: [],
            scopes: [],
            sandbox: "required",
          },
        },
      },
    },
  };
}
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

describe("cron channel-created jobs under gateway.roles", () => {
  it("prepares a run for a channel-created job instead of failing on the creator profile", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-channel-creator-role-"));
    const scope = { agentId: "main", env: process.env };
    const database = openOpenClawAgentDatabase(scope);
    const sourceKey = "agent:main:source";
    const now = Date.now();
    runOpenClawAgentWriteTransaction((current) => {
      writeSessionEntry(current, sourceKey, {
        sessionId: "source-session",
        lifecycleRevision: "source-revision",
        updatedAt: now,
        sessionStartedAt: now,
        skillsSnapshot: { prompt: "source prompt", skills: [] },
      });
    }, scope);

    // resolveCreatorSandbox runs before session preparation, so reaching this
    // boundary proves a channel-native creator id no longer fails the run before
    // any session writes or tool execution. The stamped sandbox value itself is
    // covered by the operator-role-policy unit test.
    const preparedBoundary = new Error("cron session preparation complete");
    resolveCronSessionMock.mockImplementation(async () => {
      throw preparedBoundary;
    });

    await expect(
      prepareCronRunContext({
        input: makeIsolatedAgentParamsFixture({
          agentId: "main",
          cfg: {
            session: { store: database.path },
            gateway: {
              roles: {
                default: "guest",
                definitions: {
                  guest: {
                    sessions: { others: "view" },
                    agents: [],
                    scopes: [],
                    sandbox: "required",
                  },
                },
              },
            },
          },
          sessionKey: sourceKey,
          job: makeIsolatedAgentJobFixture({
            sessionTarget: "current",
            sessionKey: sourceKey,
            delivery: { mode: "none" },
            createdActor: { type: "human", source: "channel", id: "U-CHANNEL-SENDER" },
          }),
        }),
        isFastTestEnv: true,
        onLifecycleInterrupt: () => {},
      }),
    ).rejects.toBe(preparedBoundary);
  });

  it("runs a channel-created job through model execution with the default-role sandbox stamped", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-channel-creator-run-"));
    const dir = tempDirs.make("openclaw-cron-channel-creator-store-");
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const jobId = "channel-reminder";
    const sessionId = "channel-creator-run";
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        sessionEntry: makeCronSessionEntry({ sessionId }),
      }),
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: `cron:${jobId}`,
        cfg: makeRolesCfg(),
        job: makeIsolatedAgentJobFixture({
          id: jobId,
          sessionTarget: "isolated",
          delivery: { mode: "none" },
          createdActor: { type: "human", source: "channel", id: "U-CHANNEL-SENDER" },
        }),
      }),
    );

    // The scheduled turn reaches final model execution instead of dying in setup.
    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalled();
    expect(runEmbeddedAgentMock).toHaveBeenCalled();

    // The default role's sandbox requirement is stamped onto the executed run session.
    const accessor = await vi.importActual<
      typeof import("../../config/sessions/session-accessor.js")
    >("../../config/sessions/session-accessor.js");
    const persisted = accessor.loadSessionEntry({
      agentId: "main",
      sessionKey: `agent:main:cron:${jobId}:run:${sessionId}`,
      storePath,
    });
    expect(persisted?.sandbox).toBe("required");
  });

  it("rejects a job whose verified profile creator no longer exists before model execution", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-stale-creator-run-"));

    // A removed profile creator must fail closed: resuming under the default role could
    // drop the profile's required sandbox, so the run stops before any tool I/O.
    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          agentId: "main",
          sessionKey: "cron:stale-profile-job",
          cfg: makeRolesCfg(),
          job: makeIsolatedAgentJobFixture({
            id: "stale-profile-job",
            sessionTarget: "isolated",
            delivery: { mode: "none" },
            createdActor: { type: "human", source: "profile", id: "U-REMOVED-PROFILE" },
          }),
        }),
      ),
    ).rejects.toThrow(/user profile not found/i);
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
});

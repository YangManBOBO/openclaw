// Node screen command tests cover RPC handling and option validation.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesScreenCommands } from "./register.screen.js";
import * as rpc from "./rpc.js";

const capturedInvokeParams: Record<string, unknown>[] = [];

vi.mock("./cli-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./cli-utils.js")>("./cli-utils.js");
  return {
    ...actual,
    runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
  };
});

vi.mock("../nodes-screen.js", async () => {
  const actual = await vi.importActual<typeof import("../nodes-screen.js")>("../nodes-screen.js");
  return {
    ...actual,
    writeScreenRecordToFile: vi.fn(async () => ({ path: "screen.mp4" })),
  };
});

vi.mock("../../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");
  return {
    ...actual,
    defaultRuntime: {
      log: vi.fn(),
      error: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    },
  };
});

vi.mock("./rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./rpc.js")>("./rpc.js");
  return {
    ...actual,
    resolveCliNodeId: vi.fn(async () => "node-abc123"),
    callNodesGatewayCli: vi.fn(async (_method, _opts, invokeParams) => {
      capturedInvokeParams.push(invokeParams as Record<string, unknown>);
      return {
        payload: {
          format: "mp4",
          base64: "cmVkYWN0ZWQ=",
          durationMs: 10_000,
          fps: 10,
          screenIndex: 0,
          hasAudio: true,
        },
      };
    }),
  };
});

function buildRootCommand(): Command {
  const nodes = new Command("nodes");
  registerNodesScreenCommands(nodes);
  return nodes.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
}

function screenRecordArgs(extra: string[]): string[] {
  return ["node", "nodes", "screen", "record", ...extra];
}

describe("nodes screen record CLI option validation", () => {
  beforeEach(() => {
    capturedInvokeParams.length = 0;
    vi.clearAllMocks();
  });

  it.each(["0", "0ms", "0s"])(
    "rejects non-positive screen record --duration %j before dispatch",
    async (duration) => {
      const nodes = buildRootCommand();
      await expect(
        nodes.parseAsync(screenRecordArgs(["--node", "test-node", "--duration", duration])),
      ).rejects.toThrow("--duration must be a positive duration");
      expect(rpc.resolveCliNodeId).not.toHaveBeenCalled();
      expect(rpc.callNodesGatewayCli).not.toHaveBeenCalled();
    },
  );

  it("forwards a positive screen record --duration before dispatch", async () => {
    await buildRootCommand().parseAsync(
      screenRecordArgs(["--node", "test-node", "--duration", "10s"]),
    );
    expect(capturedInvokeParams).toHaveLength(1);
    const firstInvokeParams = capturedInvokeParams[0];
    if (!firstInvokeParams) {
      throw new Error("expected at least one screen.record node.invoke call");
    }
    expect((firstInvokeParams.params as Record<string, unknown>).durationMs).toBe(10_000);
  });
});

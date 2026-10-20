import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { ChannelManager } from "./server-channels.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
  type TestAccount,
} from "./server-channels.test-support.js";

describe("channel stop-timeout recovery (real clock)", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  function account(manager: ChannelManager, accountId = DEFAULT_ACCOUNT_ID) {
    return manager.getRuntimeSnapshot().channelAccounts.discord?.[accountId];
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  it(
    "recovers a manual stop that timed out against an abort-ignoring task",
    { timeout: 30_000 },
    async () => {
      const trace: string[] = [];
      const startAccount = vi.fn(async ({ abortSignal }: ChannelGatewayContextV2<TestAccount>) => {
        if (startAccount.mock.calls.length === 1) {
          trace.push("startAccount #1 entered (ignoring abort)");
          await new Promise<void>(() => {});
          return;
        }
        trace.push("startAccount #2 entered (waiting for abort)");
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const registry = createTestChannelRegistry(createTestPlugin({ startAccount }));
      const manager = createTestChannelManager({ getPluginRegistry: () => registry });
      try {
        await manager.startChannels();
        trace.push("channels started; issuing manual stop");
        const stop = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
        await sleep(6_000);
        await stop;
        trace.push(
          `stop settled; running=${account(manager)?.running} restartPending=${account(manager)?.restartPending} lastError=${account(manager)?.lastError}`,
        );
        expect(startAccount).toHaveBeenCalledTimes(1);
        expect(account(manager)).toMatchObject({
          running: true,
          restartPending: false,
          lastError: "channel stop timed out after 5000ms",
        });
        await sleep(1_000);
        expect(startAccount).toHaveBeenCalledTimes(1);
        trace.push("no automatic restart observed after timeout");

        trace.push("issuing explicit start");
        await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
        trace.push(
          `explicit start settled; running=${account(manager)?.running} restartPending=${account(manager)?.restartPending}`,
        );
        expect(startAccount).toHaveBeenCalledTimes(2);
        expect(account(manager)).toMatchObject({ running: true, restartPending: false });
      } finally {
        await manager.stopChannel("discord").catch(() => {});
      }
      console.log(`stop-timeout recovery trace:\n${trace.map((line) => `  ${line}`).join("\n")}`);
    },
  );
});

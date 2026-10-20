import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const TEST_TIMEOUT_MS = 120_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CHANNEL_ID = "stuck-channel";
const ACCOUNT_ID = "default";
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function setupTempHome() {
  const env = captureEnv([...ENV_KEYS]);
  const home = tempDirs.make("openclaw-stop-timeout-");
  const stateDir = path.join(home, ".openclaw");
  const workspace = path.join(home, "workspace");
  const bundledPlugins = path.join(home, "empty-bundled-plugins");
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(bundledPlugins, { recursive: true }),
  ]);
  setTestEnvValue("HOME", home);
  setTestEnvValue("USERPROFILE", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPlugins);
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  return { configPath: path.join(stateDir, "openclaw.json"), env, home, workspace };
}

async function writePluginFixture(home: string) {
  const pluginDir = path.join(home, "stuck-channel-plugin");
  const fixtureDir = path.join(
    process.cwd(),
    "test/e2e/qa-lab/runtime/fixtures/stuck-channel-plugin",
  );
  await fs.mkdir(pluginDir, { recursive: true });
  for (const name of ["package.json", "openclaw.plugin.json", "index.mjs"]) {
    await fs.copyFile(path.join(fixtureDir, name), path.join(pluginDir, name));
  }
  return pluginDir;
}

function readStatusAccounts(payload: unknown): Record<string, Record<string, unknown>> {
  const record = payload as { channelAccounts?: Record<string, unknown> };
  const channelAccounts = record.channelAccounts?.[CHANNEL_ID];
  const accounts = Array.isArray(channelAccounts)
    ? (channelAccounts as Array<Record<string, unknown>>)
    : [];
  return Object.fromEntries(accounts.map((state) => [String(state.accountId), state]));
}

it(
  "recovers a manual stop timeout through the shipped Gateway",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const temp = await setupTempHome();
    const token = `stop-timeout-${process.pid}`;
    const pluginDir = await writePluginFixture(temp.home);
    const trace: string[] = [];
    let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      started = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: {
              workspace: temp.workspace,
              model: { primary: "fixture/catalog-model" },
              models: { "fixture/catalog-model": {} },
            },
          },
          gateway: { auth: { mode: "token", token } },
          models: {
            mode: "replace",
            providers: {
              fixture: {
                apiKey: "stuck-channel-secret",
                baseUrl: "http://127.0.0.1:9/v1",
                models: [
                  {
                    id: "catalog-model",
                    name: "Catalog Model",
                    contextWindow: 8192,
                    reasoning: true,
                    compat: { supportsTools: true },
                  },
                ],
              },
            },
          },
          plugins: { load: { paths: [pluginDir] } },
          channels: {
            [CHANNEL_ID]: { enabled: true, accounts: { [ACCOUNT_ID]: { enabled: true } } },
          },
        },
        configPath: temp.configPath,
        token,
        clientDisplayName: "stop-timeout-proof",
      });

      await started.server.startupSettled;

      trace.push("waiting for ambient start of the abort-ignoring account");
      const deadline = Date.now() + 30_000;
      let running = false;
      while (Date.now() < deadline) {
        const payload = await started.client.request("channels.status", {
          channel: CHANNEL_ID,
          probe: false,
          timeoutMs: 2_000,
        });
        const account = readStatusAccounts(payload)[ACCOUNT_ID];
        if (account?.running === true) {
          running = true;
          trace.push(`ambient start visible: running=true (${JSON.stringify(account)})`);
          break;
        }
        await sleep(200);
      }
      expect(running).toBe(true);

      trace.push("issuing manual channels.stop");
      const stopStartedAt = Date.now();
      await started.client.request("channels.stop", { channel: CHANNEL_ID, accountId: ACCOUNT_ID });
      const stopElapsedMs = Date.now() - stopStartedAt;
      trace.push(`channels.stop settled after ${stopElapsedMs}ms`);
      expect(stopElapsedMs).toBeGreaterThanOrEqual(5_000);

      let account = readStatusAccounts(
        await started.client.request("channels.status", {
          channel: CHANNEL_ID,
          probe: false,
          timeoutMs: 2_000,
        }),
      )[ACCOUNT_ID];
      trace.push(`status after stop: ${JSON.stringify(account)}`);
      expect(account).toMatchObject({
        running: true,
        restartPending: false,
        lastError: "channel stop timed out after 5000ms",
      });

      await sleep(2_000);
      account = readStatusAccounts(
        await started.client.request("channels.status", {
          channel: CHANNEL_ID,
          probe: false,
          timeoutMs: 2_000,
        }),
      )[ACCOUNT_ID];
      trace.push(`status after 2s (no automatic restart expected): ${JSON.stringify(account)}`);
      expect(account).toMatchObject({
        running: true,
        restartPending: false,
        lastError: "channel stop timed out after 5000ms",
      });

      trace.push("issuing explicit channels.start");
      const startReply = await started.client.request("channels.start", {
        channel: CHANNEL_ID,
        accountId: ACCOUNT_ID,
      });
      trace.push(`channels.start reply: ${JSON.stringify(startReply)}`);

      const finalDeadline = Date.now() + 15_000;
      let recovered = false;
      while (Date.now() < finalDeadline) {
        account = readStatusAccounts(
          await started.client.request("channels.status", {
            channel: CHANNEL_ID,
            probe: false,
            timeoutMs: 2_000,
          }),
        )[ACCOUNT_ID];
        if (account?.running === true) {
          recovered = true;
          break;
        }
        await sleep(200);
      }
      trace.push(`status after explicit start: ${JSON.stringify(account)}`);
      expect(recovered).toBe(true);
    } finally {
      if (started) {
        await disconnectGatewayClient(started.client).catch(() => undefined);
        await started.server
          .close({ reason: "stop-timeout recovery proof complete" })
          .catch(() => undefined);
      }
      temp.env.restore();
    }
    console.log(
      `stop-timeout recovery trace (shipped Gateway):\n${trace.map((line) => `  ${line}`).join("\n")}`,
    );
  },
);

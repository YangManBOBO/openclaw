// Telegram ingress rotation tests: a bot identity change resets the bot's
// update_id sequence while the account-scoped ingress queue still holds the
// previous bot's completed tombstones. Without a purge, the new bot's first
// updates collide with those rows and are silently dropped as duplicates.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
  createPluginStateKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import {
  openTelegramIngressQueue,
  resolveTelegramIngressSpoolDir,
  telegramQueueEventId,
} from "./telegram-ingress-spool.js";
import { writeTelegramSpooledUpdate } from "./telegram-ingress-spool.test-support.js";
import {
  applyTelegramRotationCleanup,
  readTelegramUpdateOffset,
  recordTelegramAccountBotIdentity,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

const BOT_A_TOKEN = "111111:token-a";
const BOT_B_TOKEN = "222222:token-b";

function botMessage(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      chat: { id: 1234, type: "private" },
      from: { id: 555, first_name: "User" },
      message_id: updateId,
      text,
    },
  };
}

async function withRotationState<T>(fn: (stateDir: string, spoolDir: string) => Promise<T>) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-rotation-"));
  const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
  setTelegramRuntime({
    channel: {},
    state: {
      resolveStateDir: () => stateDir,
      openKeyedStore: <StoreValue>(
        options: Parameters<typeof createPluginStateKeyedStoreForTests<StoreValue>>[1],
      ) => createPluginStateKeyedStoreForTests<StoreValue>("telegram", options),
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
      ) => createChannelIngressQueue({ ...options, channelId: "telegram" }),
    },
  } as never);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    const spoolDir = resolveTelegramIngressSpoolDir({ accountId: "default", env });
    return await fn(stateDir, spoolDir);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    clearTelegramRuntimeForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  clearTelegramRuntimeForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("telegram ingress spool bot rotation", () => {
  it("purges the account spool on bot identity change so the new bot's updates are not dropped", async () => {
    await withRotationState(async (stateDir, spoolDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 1500,
        botToken: BOT_A_TOKEN,
      });

      // Bot A already received and processed updates 1..3; their completed
      // tombstones remain in the account-scoped ingress queue.
      const queue = openTelegramIngressQueue(spoolDir);
      for (const updateId of [1, 2, 3]) {
        await writeTelegramSpooledUpdate({
          spoolDir,
          update: botMessage(updateId, `old ${updateId}`),
        });
        await queue.complete(telegramQueueEventId(updateId));
      }
      // Before the fix, a duplicate of a completed update id is deduplicated.
      expect((await queue.enqueue(telegramQueueEventId(1), {} as never)).kind).toBe("completed");

      // Restart with a different bot token: rotation detection fires and the
      // rotation cleanup purges the stale spool before polling begins.
      const rotations: string[] = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: BOT_B_TOKEN,
        env,
        onRotationDetected: async (info) => {
          rotations.push(info.reason);
          await applyTelegramRotationCleanup(info, { accountId: "default", env });
        },
      });
      expect(offset).toBeNull();
      expect(rotations).toEqual(["bot-id-changed"]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);

      // Bot B's first update reuses update_id 1 and must be accepted, not dropped.
      const admitted = await writeTelegramSpooledUpdate({
        spoolDir,
        update: botMessage(1, "new bot"),
      });
      expect(admitted).toBe(1);
      const pending = await queue.listPending({ limit: "all" });
      expect(pending.map((record) => record.id)).toEqual([telegramQueueEventId(1)]);
    });
  });

  it("keeps the spool intact for a same-bot token rotation so replay dedup survives", async () => {
    await withRotationState(async (stateDir, spoolDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 1500,
        botToken: BOT_A_TOKEN,
      });
      const queue = openTelegramIngressQueue(spoolDir);
      await writeTelegramSpooledUpdate({ spoolDir, update: botMessage(7, "replayed") });
      await queue.complete(telegramQueueEventId(7));

      // Same bot, rotated token: the rotation cleanup must NOT clear the queue,
      // because the replayed recent updates still deduplicate against it.
      const rotations: string[] = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:token-a-rotated",
        env,
        onRotationDetected: async (info) => {
          rotations.push(info.reason);
          await applyTelegramRotationCleanup(info, { accountId: "default", env });
        },
      });
      expect(offset).toBeNull();
      expect(rotations).toEqual(["token-rotated"]);
      expect((await queue.enqueue(telegramQueueEventId(7), {} as never)).kind).toBe("completed");
    });
  });

  it("purges the spool when the bot switches before any offset was saved", async () => {
    await withRotationState(async (stateDir, spoolDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
      // Bot A admitted updates but crashed before the offset write; only the
      // account bot-identity marker is persisted (lastUpdateId null).
      await recordTelegramAccountBotIdentity({
        accountId: "default",
        botToken: BOT_A_TOKEN,
      });
      const queue = openTelegramIngressQueue(spoolDir);
      await writeTelegramSpooledUpdate({ spoolDir, update: botMessage(1, "old") });
      await queue.complete(telegramQueueEventId(1));
      expect((await queue.enqueue(telegramQueueEventId(1), {} as never)).kind).toBe("completed");

      // A different bot starts with no saved offset: the marker still identifies
      // the previous bot, so the stale spool is purged before polling.
      const rotations: string[] = [];
      const offset = await readTelegramUpdateOffset({
        accountId: "default",
        botToken: BOT_B_TOKEN,
        env,
        onRotationDetected: async (info) => {
          rotations.push(info.reason);
          await applyTelegramRotationCleanup(info, { accountId: "default", env });
        },
      });
      expect(offset).toBeNull();
      expect(rotations).toEqual(["bot-id-changed"]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect((await queue.enqueue(telegramQueueEventId(1), {} as never)).kind).toBe("accepted");
    });
  });
});

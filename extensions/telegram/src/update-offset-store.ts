import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getTelegramRuntime } from "./runtime.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import { clearTelegramIngressSpool } from "./telegram-ingress-spool.js";
import {
  fingerprintTelegramBotToken,
  resolveTelegramBotUserIdFromToken,
} from "./token-fingerprint.js";

const STORE_VERSION = 3;
const TELEGRAM_UPDATE_OFFSET_NAMESPACE = "telegram.update-offsets";
const TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES = 1_000;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
  tokenFingerprint: string | null;
};

type TelegramUpdateOffsetStore = PluginStateKeyedStore<TelegramUpdateOffsetState>;

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function openUpdateOffsetStore(env?: NodeJS.ProcessEnv): TelegramUpdateOffsetStore {
  return getTelegramRuntime().state.openKeyedStore<TelegramUpdateOffsetState>({
    namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
    maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

function extractBotIdFromToken(token?: string): string | null {
  const botUserId = resolveTelegramBotUserIdFromToken(token);
  return botUserId === undefined ? null : String(botUserId);
}

function fingerprintFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  return fingerprintTelegramBotToken(trimmed);
}

function safeParseState(parsed: unknown): TelegramUpdateOffsetState | null {
  try {
    const state = parsed as {
      version?: number;
      lastUpdateId?: number | null;
      botId?: string | null;
      tokenFingerprint?: string | null;
    };
    if (state?.version !== STORE_VERSION && state?.version !== 2 && state?.version !== 1) {
      return null;
    }
    if (state.lastUpdateId !== null && !isValidUpdateId(state.lastUpdateId)) {
      return null;
    }
    if (state.version >= 2 && state.botId !== null && typeof state.botId !== "string") {
      return null;
    }
    if (
      state.version === STORE_VERSION &&
      state.tokenFingerprint !== null &&
      typeof state.tokenFingerprint !== "string"
    ) {
      return null;
    }
    return {
      version: state.version,
      lastUpdateId: state.lastUpdateId ?? null,
      botId: state.version >= 2 ? (state.botId ?? null) : null,
      tokenFingerprint: state.version === STORE_VERSION ? (state.tokenFingerprint ?? null) : null,
    };
  } catch {
    return null;
  }
}

export type TelegramOffsetRotationReason = "bot-id-changed" | "token-rotated" | "legacy-state";

export type TelegramUpdateOffsetRotationInfo = {
  reason: TelegramOffsetRotationReason;
  previousBotId: string | null;
  currentBotId: string;
  staleLastUpdateId: number | null;
};

function rotationForToken(
  parsed: TelegramUpdateOffsetState,
  botToken?: string,
): TelegramUpdateOffsetRotationInfo | null {
  const currentBotId = extractBotIdFromToken(botToken);
  if (!currentBotId) {
    return null;
  }
  // A marker row (no saved offset yet) still records the previous bot identity,
  // so a switch is detectable even when queue admission preceded any offset
  // write. Only bail when there is nothing to compare: no offset and no bot.
  if (parsed.lastUpdateId === null && parsed.botId === null) {
    return null;
  }
  let reason: TelegramOffsetRotationReason | null = null;
  if (parsed.botId === null) {
    reason = "legacy-state";
  } else if (parsed.botId !== currentBotId) {
    reason = "bot-id-changed";
  } else if (parsed.tokenFingerprint === null) {
    reason = "legacy-state";
  } else if (parsed.tokenFingerprint !== fingerprintFromToken(botToken)) {
    reason = "token-rotated";
  }
  return reason
    ? {
        reason,
        previousBotId: parsed.botId,
        currentBotId,
        staleLastUpdateId: parsed.lastUpdateId,
      }
    : null;
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
  onRotationDetected?: (info: TelegramUpdateOffsetRotationInfo) => void | Promise<void>;
}): Promise<number | null> {
  const key = normalizeTelegramStateAccountId(params.accountId);
  let storedValue: unknown;
  try {
    storedValue = await openUpdateOffsetStore(params.env).lookup(key);
  } catch (err) {
    // A failed read is not the same as an absent offset: the caller must not
    // mistake a transient read failure for a fresh account and overwrite saved
    // state with a null-offset marker (which would replay from the beginning).
    throw new Error(`telegram: failed to read update offset: ${String(err)}`);
  }
  const parsed = safeParseState(storedValue);
  if (!parsed) {
    return null;
  }
  const rotation = rotationForToken(parsed, params.botToken);
  if (rotation) {
    await params.onRotationDetected?.(rotation);
    return null;
  }
  return parsed.lastUpdateId;
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!isValidUpdateId(params.updateId)) {
    throw new Error("Telegram update offset must be a non-negative safe integer.");
  }
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
    tokenFingerprint: fingerprintFromToken(params.botToken),
  };
  await openUpdateOffsetStore(params.env).register(
    normalizeTelegramStateAccountId(params.accountId),
    payload,
  );
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await openUpdateOffsetStore(params.env).delete(normalizeTelegramStateAccountId(params.accountId));
}

/**
 * Record which bot the account is currently using even when no update offset has
 * been saved yet. Ingress admission commits to the durable queue before the
 * offset write is scheduled, so a crash can leave old-bot rows without any
 * offset state; the marker lets a later bot switch be detected from the queue's
 * bot identity instead of requiring a completed offset write.
 */
export async function recordTelegramAccountBotIdentity(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: null,
    botId: extractBotIdFromToken(params.botToken),
    tokenFingerprint: fingerprintFromToken(params.botToken),
  };
  await openUpdateOffsetStore(params.env).register(
    normalizeTelegramStateAccountId(params.accountId),
    payload,
  );
}

export type TelegramRotationCleanupOptions = {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  onSpoolPurged?: (removed: number) => void | Promise<void>;
};

/**
 * Discard the state that belongs to the previous bot identity after a rotation:
 * the stale update offset and, on a bot identity change, the previous bot's
 * spooled ingress rows. A new bot restarts its update_id sequence at low values
 * while the account-scoped ingress queue still holds the old bot's tombstones;
 * purging them prevents the new bot's first updates from being silently dropped
 * as duplicates. A same-bot token rotation keeps the spool intact so its dedup
 * still guards the post-reset replay window.
 */
export async function applyTelegramRotationCleanup(
  info: TelegramUpdateOffsetRotationInfo,
  options: TelegramRotationCleanupOptions = {},
): Promise<void> {
  const failures: string[] = [];
  // Purge the previous bot's spooled rows BEFORE discarding the offset. If the
  // purge fails, the stale offset (with its old-bot identity) must survive so a
  // restart re-detects the rotation and retries; deleting the offset first
  // would drop that retry signal and leave old rows colliding with the new bot.
  if (info.reason === "bot-id-changed") {
    try {
      const removed = await clearTelegramIngressSpool({
        accountId: options.accountId,
        env: options.env,
      });
      await options.onSpoolPurged?.(removed);
    } catch (err) {
      failures.push(`stale ingress spool: ${String(err)}`);
    }
  }
  if (failures.length === 0) {
    try {
      await deleteTelegramUpdateOffset({ accountId: options.accountId, env: options.env });
    } catch (err) {
      failures.push(`stale update offset: ${String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

import { describe, expect, it } from "vitest";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import { installDeliveryQueueTmpDirHooks } from "./outbound/delivery-queue.test-helpers.js";

describe("delivery queue SQLite update atomicity", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const queueName = "test-update-atomicity";

  const enqueueRetained = (id: string) =>
    upsertDeliveryQueueEntry({
      queueName,
      entry: { id, enqueuedAt: Date.now(), retryCount: 0, retainOnFailure: true },
      stateDir: tmpDir(),
    });

  it("preserves an independently committed terminal outcome", () => {
    const id = "committed-terminalize";
    enqueueRetained(id);

    moveDeliveryQueueEntryToFailed(queueName, id, tmpDir());
    expect(getDeliveryQueueEntryStatus(queueName, id, tmpDir())).toBe("failed");

    expect(() =>
      updateDeliveryQueueEntry(queueName, id, tmpDir(), (entry) => ({
        ...entry,
        retryCount: 999,
        lastError: "stale",
      })),
    ).toThrow(new RegExp(`No pending test-update-atomicity delivery queue entry ${id}`));

    expect(getDeliveryQueueEntryStatus(queueName, id, tmpDir())).toBe("failed");
    expect(loadDeliveryQueueEntry(queueName, id, tmpDir())).toBeNull();
  });

  it("fails closed when a concurrent terminalize lands inside the update window", () => {
    const id = "race-terminalize";
    enqueueRetained(id);

    expect(() =>
      updateDeliveryQueueEntry(queueName, id, tmpDir(), (entry) => {
        moveDeliveryQueueEntryToFailed(queueName, id, tmpDir());
        return { ...entry, retryCount: 999, lastError: "stale" };
      }),
    ).toThrow(new RegExp(`No pending test-update-atomicity delivery queue entry ${id}`));

    const loaded = loadDeliveryQueueEntry(queueName, id, tmpDir());
    expect(loaded?.retryCount).toBe(0);
    expect(loaded?.lastError).toBeUndefined();
  });
});

import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  channelIngressPrefixRowFingerprint,
  xorChannelIngressPrefixFingerprints,
} from "./ingress-queue.codec.js";
import type { ChannelIngressClaimCursor } from "./ingress-queue.types.js";

const getQueue = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);

/**
 * Authoritative count and membership fingerprint of the scan-visible pending rows
 * strictly before a keyset cursor, read in one pinned query. A retained direct-scan
 * resume cursor is only valid while these are unchanged; a write from any handle
 * that inserted, removed, or replaced a row before the cursor changes one of them.
 * The fingerprint detects offsetting writes (one row removed, another inserted)
 * that preserve the count, which count alone cannot observe.
 */
export function readChannelIngressPrefixInDatabase(
  db: DatabaseSync,
  input: {
    queueName: string;
    candidateIds?: string[];
    blockedLaneKeys: string[];
    reconcileStoredLaneKey?: boolean;
    orderBy?: "received" | "id";
    claimAfter: ChannelIngressClaimCursor;
  },
): { count: number; fingerprint: string } {
  const cursor = input.claimAfter;
  let before = getQueue(db)
    .selectFrom("channel_ingress_events")
    .select(["event_id", "received_at", "lane_key", "status"])
    .where("queue_name", "=", input.queueName)
    .where("status", "=", "pending");
  if (input.candidateIds) {
    before = before.where("event_id", "in", input.candidateIds);
  }
  if (!input.reconcileStoredLaneKey && input.blockedLaneKeys.length) {
    before = before.where((eb) =>
      eb.or([
        eb("lane_key", "is", null),
        eb("lane_key", "not in", sqliteStringSet(input.blockedLaneKeys)),
      ]),
    );
  }
  before =
    input.orderBy === "id"
      ? before.where("event_id", "<", cursor.eventId)
      : before.where((eb) =>
          eb.or([
            eb("received_at", "<", cursor.receivedAt),
            eb.and([
              eb("received_at", "=", cursor.receivedAt),
              eb("event_id", "<", cursor.eventId),
            ]),
          ]),
        );
  const prefixRows = executeSqliteQuerySync(db, before).rows;
  return {
    count: prefixRows.length,
    fingerprint: xorChannelIngressPrefixFingerprints(
      ...prefixRows.map((row) => channelIngressPrefixRowFingerprint(row)),
    ),
  };
}

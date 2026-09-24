// Senders whose latest pairing reply failed ambiguously. The shared issuer
// deliberately sends nothing while a request is pending, so a challenge whose
// first delivery was uncertain could otherwise be lost for the pending request's
// one-hour lifetime. A later message from such a sender re-sends the same code
// once; a successful first delivery never marks the sender, so it is not repeated.
const LINE_PAIRING_RECOVERY_TTL_MS = 60 * 60 * 1000;
const linePairingRecovery = new Map<string, number>();

export function markLinePairingRecoveryNeeded(senderId: string): void {
  const now = Date.now();
  for (const [staleSenderId, markedAt] of linePairingRecovery) {
    if (now - markedAt > LINE_PAIRING_RECOVERY_TTL_MS) {
      linePairingRecovery.delete(staleSenderId);
    }
  }
  linePairingRecovery.set(senderId, now);
}

export function consumeLinePairingRecovery(senderId: string): boolean {
  const markedAt = linePairingRecovery.get(senderId);
  if (markedAt === undefined) {
    return false;
  }
  linePairingRecovery.delete(senderId);
  return Date.now() - markedAt <= LINE_PAIRING_RECOVERY_TTL_MS;
}

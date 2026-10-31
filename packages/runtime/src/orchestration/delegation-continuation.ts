import { isDeepStrictEqual } from "node:util";
import type { DelegationSnapshot } from "@covel/shared";
import type { DataStore, SuspensionRecord } from "@covel/store";

/** Capture the host's live claim once, before any resumed work can run. */
export async function captureSuspensionClaim(
  store: DataStore,
  suspension: SuspensionRecord,
): Promise<SuspensionRecord["resolvedAt"]> {
  const live = await store.getSuspension(suspension.id);
  if (
    !live ||
    live.sessionId !== suspension.sessionId ||
    (live.resolvedAt !== undefined &&
      !live.resolvedAt.startsWith("claimed:")) ||
    (suspension.resolvedAt !== undefined &&
      suspension.resolvedAt !== live.resolvedAt)
  )
    throw new Error("Suspension claim changed before resuming delegation");
  // A caller may pass the record it read immediately before claiming it.
  // Only this entry read may adopt that claim; settlement compares it exactly.
  return live.resolvedAt;
}

/** The host holds the session lock throughout load, resume and settlement. */
export async function latestDelegationSnapshot(
  store: DataStore,
  suspension: SuspensionRecord,
): Promise<DelegationSnapshot | undefined> {
  const saved = suspension.pendingContinuation.delegation;
  if (!saved) return undefined;
  const siblings = await store.listSuspensions(suspension.sessionId);
  return siblings.reduce((latest, row) => {
    const candidate = row.pendingContinuation.delegation;
    return candidate?.scopeId === saved.scopeId &&
      candidate.calls > latest.calls
      ? candidate
      : latest;
  }, saved);
}

/** Persist spent admissions even on a failed leg, without reopening a claim. */
export async function persistDelegationSnapshot(
  store: DataStore,
  suspension: SuspensionRecord,
  delegation: DelegationSnapshot,
  previous: DelegationSnapshot,
): Promise<void> {
  if (isDeepStrictEqual(previous, delegation)) {
    const own = await store.getSuspension(suspension.id);
    if (!own || own.resolvedAt !== suspension.resolvedAt)
      throw new Error("Suspension claim changed while recording delegation");
    return;
  }
  await store.withTransaction(async (tx) => {
    const own = await tx.getSuspension(suspension.id);
    if (!own || own.resolvedAt !== suspension.resolvedAt)
      throw new Error("Suspension claim changed while recording delegation");
    const rows = await tx.listSuspensions(suspension.sessionId);
    for (const row of rows) {
      if (
        row.id !== suspension.id &&
        row.pendingContinuation.delegation?.scopeId !== delegation.scopeId
      )
        continue;
      if (
        row.resolvedAt !== undefined &&
        !row.resolvedAt.startsWith("claimed:") &&
        row.id !== suspension.id
      )
        continue;
      if (
        !(await tx.updateSuspensionContinuation(
          row.id,
          { ...row.pendingContinuation, delegation },
          row.resolvedAt,
        ))
      )
        throw new Error("Suspension claim changed while recording delegation");
    }
  });
}

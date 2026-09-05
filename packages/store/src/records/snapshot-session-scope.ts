import type { SnapshotPayload } from "./snapshot-records.js";

/** Rebind trusted snapshot state when copying it into another session. */
export function rebindSnapshotPayloadSession(
  payload: SnapshotPayload,
  sessionId: string,
): SnapshotPayload {
  const rebind = <T extends { readonly sessionId: string }>(
    records: readonly T[],
  ): T[] => records.map((record) => ({ ...record, sessionId }));
  return {
    ...payload,
    characters: rebind(payload.characters),
    stateEntries: rebind(payload.stateEntries),
    pluginData: rebind(payload.pluginData),
    workingMemory: rebind(payload.workingMemory),
    lorebookEntries: rebind(payload.lorebookEntries),
    suspensions: payload.suspensions.map((record) => ({
      ...record,
      // Suspension IDs are global. Historical fork payloads kept the parent
      // ID, so scope their replacement deterministically across exports.
      id:
        record.sessionId === sessionId
          ? record.id
          : `fork:${encodeURIComponent(sessionId)}:${encodeURIComponent(record.id)}`,
      sessionId,
    })),
    ...(payload.sessionSummaries === undefined
      ? {}
      : { sessionSummaries: rebind(payload.sessionSummaries) }),
  };
}

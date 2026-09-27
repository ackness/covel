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
    characterSchema: payload.characterSchema
      ? { ...payload.characterSchema, sessionId }
      : null,
    characters: rebind(payload.characters),
    stateEntries: rebind(payload.stateEntries),
    stateSchemas: rebind(payload.stateSchemas),
    runtimeExports: rebind(payload.runtimeExports),
    pluginData: rebind(payload.pluginData),
    lorebookEntries: rebind(payload.lorebookEntries),
    suspensions: payload.suspensions.map((record) => ({
      ...record,
      // Suspension IDs are global, so copying into another session requires
      // a distinct ID while repeated rebinding of the same payload stays stable.
      id:
        record.sessionId === sessionId
          ? record.id
          : `fork:${encodeURIComponent(sessionId)}:${encodeURIComponent(record.id)}`,
      sessionId,
    })),
    sessionSummaries: rebind(payload.sessionSummaries),
  };
}

import { SessionRecordScopeConflictError } from "../errors.js";

export function assertSessionRecordScope(
  recordType: string,
  record: { readonly id: string; readonly sessionId: string },
  existingSessionId: string | undefined,
): void {
  if (
    existingSessionId !== undefined &&
    existingSessionId !== record.sessionId
  ) {
    throw new SessionRecordScopeConflictError(recordType, record.id);
  }
}

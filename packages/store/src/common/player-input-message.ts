import { SessionRecordScopeConflictError } from "../errors.js";
import type { MessageRecord } from "../types.js";

function metadata(record: MessageRecord): Record<string, unknown> {
  if (record.metadata == null) return {};
  if (typeof record.metadata !== "object" || Array.isArray(record.metadata)) {
    throw new Error("Player input metadata must be an object");
  }
  return record.metadata as Record<string, unknown>;
}

/** Only a finalized player turn may adopt a browser's durable input row. */
export function assertCommittedPlayerInput(record: MessageRecord): void {
  const turnId = metadata(record).turnId;
  if (
    record.role !== "user" ||
    typeof turnId !== "string" ||
    turnId.length === 0
  ) {
    throw new Error("Player input commit requires a user message and turnId");
  }
}

export function adoptPlayerInputMessage(
  existing: MessageRecord,
  committed: MessageRecord,
): MessageRecord {
  assertCommittedPlayerInput(committed);
  if (existing.sessionId !== committed.sessionId) {
    throw new SessionRecordScopeConflictError("message", committed.id);
  }
  const existingMetadata = metadata(existing);
  const committedMetadata = metadata(committed);
  if (
    existing.role !== "user" ||
    existing.content !== committed.content ||
    (existingMetadata.turnId !== undefined &&
      existingMetadata.turnId !== committedMetadata.turnId)
  ) {
    throw new Error(
      "Player input id does not identify matching uncommitted input",
    );
  }
  if (existingMetadata.turnId === committedMetadata.turnId) return existing;
  return {
    ...existing,
    metadata: { ...existingMetadata, ...committedMetadata },
  };
}

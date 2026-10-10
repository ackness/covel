interface MessageHistoryRecord {
  readonly role: string;
  readonly content: string;
}

interface BranchReplyPluginDataRecord {
  readonly key: string;
  readonly value: unknown;
}

interface BranchReplyHistoryMessage extends MessageHistoryRecord {
  readonly turnId?: string;
  readonly sourceType?: string;
  readonly sourceRuntimeId?: string;
}

interface AcceptedBranchReply {
  readonly turnId: string;
  readonly text: string;
  readonly runtimeId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAcceptedBranchReply(
  record: BranchReplyPluginDataRecord,
): AcceptedBranchReply | undefined {
  const value = asRecord(record.value);
  if (!value) return undefined;

  const turnId = normalizeString(value.turnId) ?? normalizeString(record.key);
  const text = normalizeString(value.text);
  if (!turnId || !text) return undefined;

  return {
    turnId,
    text,
    ...(normalizeString(value.runtimeId)
      ? { runtimeId: normalizeString(value.runtimeId) }
      : {}),
  };
}

function isReplaceableAssistantMessage(
  message: BranchReplyHistoryMessage,
  accepted: AcceptedBranchReply,
): boolean {
  if (message.turnId !== accepted.turnId) return false;
  if (message.role !== "assistant") return false;
  if (message.sourceType !== undefined && message.sourceType !== "runtime")
    return false;
  if (
    accepted.runtimeId &&
    message.sourceRuntimeId &&
    message.sourceRuntimeId !== accepted.runtimeId
  )
    return false;
  return true;
}

/**
 * Project branch-reply accepted candidates onto prompt history.
 *
 * The append-only message table stays authoritative for audit and replay.
 * This function only rewrites the transient history array sent to LLM prompt
 * assembly, using `plugin_data[branch-reply][accepted]` rows (one per adopted turn) as
 * the player-selected assistant text for the matching turn.
 */
export function applyBranchReplyAcceptedCandidates<
  T extends BranchReplyHistoryMessage,
>(
  messageHistory: readonly T[],
  acceptedRecords: readonly BranchReplyPluginDataRecord[],
): readonly T[] {
  const acceptedByTurn = new Map<string, AcceptedBranchReply>();
  for (const record of acceptedRecords) {
    const accepted = normalizeAcceptedBranchReply(record);
    if (!accepted) continue;
    acceptedByTurn.set(accepted.turnId, accepted);
  }

  if (acceptedByTurn.size === 0) return messageHistory;

  const replacements = new Map<number, string>();
  for (const accepted of acceptedByTurn.values()) {
    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];
      if (!message) continue;
      if (!isReplaceableAssistantMessage(message, accepted)) continue;
      if (message.content !== accepted.text) {
        replacements.set(index, accepted.text);
      }
      break;
    }
  }

  if (replacements.size === 0) return messageHistory;

  return messageHistory.map((message, index) => {
    const replacement = replacements.get(index);
    return replacement === undefined
      ? message
      : { ...message, content: replacement };
  });
}

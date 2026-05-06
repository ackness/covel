import type { MessageHistoryRecord } from './types.js';

interface BranchReplyPluginDataRecord {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt?: string;
}

interface BranchReplyHistoryMessage extends MessageHistoryRecord {
  readonly turnId?: string;
  readonly sourceType?: string;
  readonly sourceRuntimeId?: string;
}

interface AcceptedBranchReply {
  readonly turnId: string;
  readonly candidateId?: string;
  readonly text: string;
  readonly runtimeId?: string;
  readonly updatedAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readCandidateText(
  candidates: unknown,
  candidateId: string | undefined,
): string | undefined {
  if (!candidateId || !Array.isArray(candidates)) return undefined;
  for (const raw of candidates) {
    const candidate = asRecord(raw);
    if (!candidate) continue;
    if (candidate.id !== candidateId) continue;
    return normalizeString(candidate.text ?? candidate.content);
  }
  return undefined;
}

function normalizeAcceptedBranchReply(
  record: BranchReplyPluginDataRecord,
): AcceptedBranchReply | undefined {
  const value = asRecord(record.value);
  if (!value) return undefined;
  if (value.status !== 'accepted') return undefined;

  const turnId = normalizeString(value.turnId) ?? normalizeString(record.key);
  if (!turnId) return undefined;

  const candidateId = normalizeString(value.acceptedCandidateId);
  const text =
    normalizeString(value.acceptedText) ??
    readCandidateText(value.candidates, candidateId);
  if (!text) return undefined;

  return {
    turnId,
    ...(candidateId ? { candidateId } : {}),
    text,
    ...(normalizeString(value.runtimeId) ? { runtimeId: normalizeString(value.runtimeId) } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
  };
}

function isReplaceableAssistantMessage(
  message: BranchReplyHistoryMessage,
  accepted: AcceptedBranchReply,
): boolean {
  if (message.turnId !== accepted.turnId) return false;
  if (message.role !== 'assistant') return false;
  if (message.sourceType !== undefined && message.sourceType !== 'runtime') return false;
  if (accepted.runtimeId && message.sourceRuntimeId && message.sourceRuntimeId !== accepted.runtimeId) return false;
  return true;
}

function sortAcceptedByUpdatedAt(a: AcceptedBranchReply, b: AcceptedBranchReply): number {
  const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
  const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
  return aTime - bTime;
}

/**
 * Project branch-reply accepted candidates onto prompt history.
 *
 * The append-only message table stays authoritative for audit and replay.
 * This function only rewrites the transient history array sent to LLM prompt
 * assembly, using `plugin_data[branch-reply][turns]` accepted state as the
 * player-selected assistant text for the matching turn.
 */
export function applyBranchReplyAcceptedCandidates<T extends BranchReplyHistoryMessage>(
  messageHistory: readonly T[],
  branchReplyTurnRecords: readonly BranchReplyPluginDataRecord[],
): readonly T[] {
  const acceptedByTurn = new Map<string, AcceptedBranchReply>();
  for (const record of branchReplyTurnRecords) {
    const accepted = normalizeAcceptedBranchReply(record);
    if (!accepted) continue;
    const existing = acceptedByTurn.get(accepted.turnId);
    if (!existing || sortAcceptedByUpdatedAt(existing, accepted) <= 0) {
      acceptedByTurn.set(accepted.turnId, accepted);
    }
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
    return replacement === undefined ? message : { ...message, content: replacement };
  });
}

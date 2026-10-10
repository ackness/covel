import type { SnapshotSubmittedInteraction } from "@covel/shared";

/**
 * The turn and interaction a message block answers to, as the `submit-form`
 * request names them. One reader for the form that submits and for the restore
 * that matches the server's record back to blocks.
 */
export function readBlockInteractionRef(
  block: Record<string, unknown>,
  messageTurnId: string | undefined,
): { turnId: string; interactionId: string } {
  const data = (block.data ?? block) as Record<string, unknown>;
  const meta = (block.meta ?? {}) as Record<string, unknown>;
  return {
    turnId: (meta.turnId as string | undefined) ?? messageTurnId ?? "",
    interactionId:
      (data.interactionId as string | undefined) ??
      (data.formId as string | undefined) ??
      "form",
  };
}

/**
 * The blocks among `messages` that the server holds an answer for, with the
 * stored values. Blocks whose message is outside the loaded window are left
 * out; they are loaded as history and read as answered by their position.
 */
export function submittedBlocksFromServer(
  messages: readonly {
    id: string;
    turnId?: string;
    block?: Record<string, unknown>;
  }[],
  submitted: readonly SnapshotSubmittedInteraction[],
): { blockId: string; values: Record<string, unknown> }[] {
  if (submitted.length === 0) return [];
  const byKey = new Map(
    submitted.map((item) => [`${item.turnId}\0${item.interactionId}`, item]),
  );
  const out: { blockId: string; values: Record<string, unknown> }[] = [];
  for (const message of messages) {
    if (!message.block) continue;
    const ref = readBlockInteractionRef(message.block, message.turnId);
    const match = byKey.get(`${ref.turnId}\0${ref.interactionId}`);
    if (match)
      out.push({
        blockId: message.id,
        values: match.values as Record<string, unknown>,
      });
  }
  return out;
}

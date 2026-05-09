import type { StreamMessage } from "@/stores/session-store.js";

export function isPendingInteractionMessage(
  msg: StreamMessage,
  allMessages: StreamMessage[],
  submittedBlockIds: ReadonlySet<string>,
): boolean {
  if (!msg.block || submittedBlockIds.has(msg.id)) return false;
  if (hasLaterUserMessage(msg, allMessages)) return false;
  return isInteractiveBlock(msg.block);
}

function hasLaterUserMessage(
  msg: StreamMessage,
  allMessages: StreamMessage[],
): boolean {
  const idx = allMessages.findIndex((m) => m.id === msg.id);
  if (idx < 0) return false;
  for (let i = idx + 1; i < allMessages.length; i += 1) {
    if (allMessages[i].role === "user") return true;
  }
  return false;
}

function isInteractiveBlock(block: Record<string, unknown>): boolean {
  const type = block.type as string | undefined;
  const data = (block.data ?? block) as Record<string, unknown>;
  const innerType = data.type as string | undefined;
  if (
    innerType === "form" ||
    innerType === "choice" ||
    innerType === "confirmation" ||
    type === "interactive_form" ||
    type === "interactive_choice" ||
    type === "interactive_confirmation" ||
    (Array.isArray(data.fields) && data.fields.length > 0)
  ) {
    return true;
  }

  if (type === "plugin_message") {
    const specs = data.specs;
    return Array.isArray(specs) && specs.some(hasInteractiveAction);
  }

  return hasInteractiveAction(data.spec);
}

function hasInteractiveAction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasInteractiveAction);

  const record = value as Record<string, unknown>;
  const action = record.action;
  if (
    action === "submitForm" ||
    action === "selectChoice" ||
    action === "selectSuggestion" ||
    action === "draftMessage"
  ) {
    return true;
  }

  return Object.values(record).some(hasInteractiveAction);
}

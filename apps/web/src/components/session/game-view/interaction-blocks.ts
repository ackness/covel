import type { StreamMessage } from "@/stores/session-store.js";

export function isPendingInteractionMessage(
  msg: StreamMessage,
  allMessages: readonly StreamMessage[],
  submittedBlockIds: ReadonlySet<string>,
): boolean {
  if (!msg.block || submittedBlockIds.has(msg.id)) return false;
  if (hasLaterUserMessage(msg, allMessages)) return false;
  return isInteractiveBlock(msg.block);
}

interface MessagePositions {
  readonly index: ReadonlyMap<string, number>;
  readonly lastUser: number;
}

// Callers check every message of one list; work out its positions once.
const positions = new WeakMap<readonly StreamMessage[], MessagePositions>();

function hasLaterUserMessage(
  msg: StreamMessage,
  allMessages: readonly StreamMessage[],
): boolean {
  let known = positions.get(allMessages);
  if (!known) {
    const index = new Map<string, number>();
    let lastUser = -1;
    allMessages.forEach((m, at) => {
      if (!index.has(m.id)) index.set(m.id, at);
      if (m.role === "user") lastUser = at;
    });
    known = { index, lastUser };
    positions.set(allMessages, known);
  }
  const idx = known.index.get(msg.id);
  return idx !== undefined && idx < known.lastUser;
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

// Only actions the player MUST answer count as pending. `selectSuggestion` /
// `draftMessage` are optional shortcuts (guide) — treating them
// as pending locked the main composer on every turn that offered suggestions,
// so the player could no longer type their own action.
function hasInteractiveAction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasInteractiveAction);

  const record = value as Record<string, unknown>;
  const action = record.action;
  if (action === "submitForm" || action === "selectChoice") return true;

  return Object.values(record).some(hasInteractiveAction);
}

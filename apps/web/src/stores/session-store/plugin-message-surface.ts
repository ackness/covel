import type { SessionState, StreamMessage } from "./types.js";

function stripPrivateMessageKeys(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([k]) => !k.startsWith("__")),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectPluginMessageStates(
  namespaceState: Record<string, unknown>,
): Array<{ turnId: string; state: Record<string, unknown> }> {
  const directTurnId =
    typeof namespaceState.__turnId === "string" ? namespaceState.__turnId : "";
  if (directTurnId) return [{ turnId: directTurnId, state: namespaceState }];

  return Object.entries(namespaceState).flatMap(([key, value]) => {
    const record = asRecord(value);
    if (!record) return [];
    const turnId =
      (typeof record.__turnId === "string" && record.__turnId) ||
      (typeof record.turnId === "string" && record.turnId) ||
      key;
    if (!turnId) return [];
    return [{ turnId, state: record }];
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function applyPluginMessageSurface(
  state: SessionState,
  pluginId: string,
): SessionState {
  const uiEntry = state.messageUiSpecs.find(
    (entry) => entry.pluginId === pluginId,
  );
  if (!uiEntry || uiEntry.specs.length === 0) return state;

  const namespaceState = state.pluginData[pluginId]?.message ?? {};
  const messageStates = collectPluginMessageStates(namespaceState);
  const desiredIds = new Set(
    messageStates.map(({ turnId }) => `plugin-message:${pluginId}:${turnId}`),
  );
  let messages = state.messages.filter((message) => {
    if (!message.id.startsWith(`plugin-message:${pluginId}:`)) return true;
    return desiredIds.has(message.id);
  });
  if (messageStates.length === 0) return { ...state, messages };

  const timestamp = new Date().toISOString();
  for (const { turnId, state: messageState } of messageStates) {
    const blockState = stripPrivateMessageKeys(messageState);
    const messageId = `plugin-message:${pluginId}:${turnId}`;
    const block = {
      type: "plugin_message",
      data: {
        pluginId,
        specs: cloneJson(uiEntry.specs) as unknown,
        state: cloneJson(blockState),
      },
      meta: { pluginId, turnId },
    } as Record<string, unknown>;

    const existingIdx = messages.findIndex((m) => m.id === messageId);
    if (existingIdx >= 0) {
      const next = [...messages];
      next[existingIdx] = {
        ...next[existingIdx],
        block,
        timestamp,
      };
      messages = next;
      continue;
    }

    const nextMessage: StreamMessage = {
      id: messageId,
      role: "assistant",
      content: "",
      timestamp,
      turnId,
      kind: "plugin-message",
      block,
      runtimeId: pluginId,
    };

    let anchorIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (
        m.turnId === turnId &&
        (m.kind === "story" || m.kind === "plugin-message")
      ) {
        anchorIndex = i;
        break;
      }
    }
    const next = [...messages];
    if (anchorIndex < 0) next.push(nextMessage);
    else next.splice(anchorIndex + 1, 0, nextMessage);
    messages = next;
  }

  return { ...state, messages };
}

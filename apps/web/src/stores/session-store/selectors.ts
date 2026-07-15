import type { SessionState, StreamMessage } from "./types.js";

export function selectSessionId(state: SessionState): string | null {
  return state.session?.id ?? null;
}

export function canRunSessionAction(state: SessionState): boolean {
  return state.session?.status === "active" && !state.executing;
}

/**
 * Resolve a message's display content, overlaying the live streaming buffer
 * when the message is an in-flight streaming placeholder.
 *
 * Streaming text is held in `state.streamingText` (keyed by the placeholder id
 * `stream_<turnId>_<runtimeId>`), NOT in the `messages` array — see reducer
 * APPEND_DELTA (M-03). The placeholder message carries empty `content`, so any
 * view that reads `msg.content` directly must overlay through this helper to
 * show the text as it streams. Returns `msg.content` verbatim for every
 * non-streaming (or already-completed) message.
 */
export function resolveStreamContent(
  msg: Pick<StreamMessage, "id" | "content">,
  streamingText: Readonly<Record<string, string>>,
): string {
  return streamingText[msg.id] ?? msg.content;
}

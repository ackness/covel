import { useCallback, useSyncExternalStore } from "react";

type Listener = () => void;

const textByMessageId = new Map<string, string>();
const listenersByMessageId = new Map<string, Set<Listener>>();
export interface StreamingTextChange {
  readonly messageId: string;
  readonly type: "append" | "reset" | "complete";
}
const globalListeners = new Set<(change: StreamingTextChange) => void>();

function notify(messageId: string, type: StreamingTextChange["type"]): void {
  for (const listener of listenersByMessageId.get(messageId) ?? []) listener();
  for (const listener of globalListeners) listener({ messageId, type });
}

/** Append text and return true for the first chunk after creation or reset. */
export function appendStreamingText(messageId: string, delta: string): boolean {
  const first = !textByMessageId.get(messageId);
  textByMessageId.set(
    messageId,
    (textByMessageId.get(messageId) ?? "") + delta,
  );
  notify(messageId, "append");
  return first;
}

export function getStreamingText(messageId: string): string | undefined {
  return textByMessageId.get(messageId);
}

/** A discarded draft starts a new text generation on the same placeholder. */
export function resetStreamingText(messageId: string): void {
  textByMessageId.set(messageId, "");
  notify(messageId, "reset");
}

export function clearStreamingText(messageId: string): void {
  if (!textByMessageId.delete(messageId)) return;
  notify(messageId, "complete");
}

export function clearStreamingTextsForTurn(turnId: string): void {
  const prefix = `stream_${turnId}_`;
  for (const messageId of [...textByMessageId.keys()]) {
    if (messageId.startsWith(prefix)) clearStreamingText(messageId);
  }
}

export function clearAllStreamingText(): void {
  for (const messageId of [...textByMessageId.keys()]) {
    clearStreamingText(messageId);
  }
}

export function subscribeToStreamingText(
  messageId: string,
  listener: Listener,
): () => void {
  let listeners = listenersByMessageId.get(messageId);
  if (!listeners) {
    listeners = new Set();
    listenersByMessageId.set(messageId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) listenersByMessageId.delete(messageId);
  };
}

/** Imperative high-frequency signal for sticky-bottom scrolling. */
export function subscribeToStreamingChanges(
  listener: (change: StreamingTextChange) => void,
): () => void {
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

/** Subscribe one rendered message row to its own live text only. */
export function useStreamingText(messageId: string): string | undefined {
  // Stabilise the subscribe closure so useSyncExternalStore doesn't
  // unsubscribe/resubscribe on every render (audit re-review B-1).
  const subscribe = useCallback(
    (listener: Listener) => subscribeToStreamingText(messageId, listener),
    [messageId],
  );
  return useSyncExternalStore(
    subscribe,
    () => getStreamingText(messageId),
    () => undefined,
  );
}

export function __clearStreamingTextForTest(): void {
  textByMessageId.clear();
  listenersByMessageId.clear();
  globalListeners.clear();
}

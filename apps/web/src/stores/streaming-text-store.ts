import { useSyncExternalStore } from "react";

type Listener = () => void;

const textByMessageId = new Map<string, string>();
const listenersByMessageId = new Map<string, Set<Listener>>();
const globalListeners = new Set<Listener>();

function notify(messageId: string): void {
  for (const listener of listenersByMessageId.get(messageId) ?? []) listener();
  for (const listener of globalListeners) listener();
}

/** Append text and return true when this is the stream's first chunk. */
export function appendStreamingText(messageId: string, delta: string): boolean {
  const first = !textByMessageId.has(messageId);
  textByMessageId.set(
    messageId,
    (textByMessageId.get(messageId) ?? "") + delta,
  );
  notify(messageId);
  return first;
}

export function getStreamingText(messageId: string): string | undefined {
  return textByMessageId.get(messageId);
}

export function clearStreamingText(messageId: string): void {
  if (!textByMessageId.delete(messageId)) return;
  notify(messageId);
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
export function subscribeToStreamingChanges(listener: Listener): () => void {
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

/** Subscribe one rendered message row to its own live text only. */
export function useStreamingText(messageId: string): string | undefined {
  return useSyncExternalStore(
    (listener) => subscribeToStreamingText(messageId, listener),
    () => getStreamingText(messageId),
    () => undefined,
  );
}

export function __clearStreamingTextForTest(): void {
  textByMessageId.clear();
  listenersByMessageId.clear();
  globalListeners.clear();
}

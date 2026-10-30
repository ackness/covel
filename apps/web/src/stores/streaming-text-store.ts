import { useCallback, useSyncExternalStore } from "react";
import { storySegmentKinds, type NarrativeDeltaSegment } from "@covel/shared";

type Listener = () => void;

/** Live metadata of one streaming story paragraph, as `narrative.delta` sends it. */
export type StreamSegmentMeta = NarrativeDeltaSegment;

const textByMessageId = new Map<string, string>();
/** Per message: each paragraph's metadata, by paragraph index. */
const segmentsByMessageId = new Map<
  string,
  (StreamSegmentMeta | undefined)[]
>();
/** Per message: the speakers derived from the metadata, kept stable for React. */
const speakersByMessageId = new Map<string, readonly (string | null)[]>();
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
  segmentsByMessageId.delete(messageId);
  speakersByMessageId.delete(messageId);
  notify(messageId, "reset");
}

export function clearStreamingText(messageId: string): void {
  const hadText = textByMessageId.delete(messageId);
  const hadSegments = segmentsByMessageId.delete(messageId);
  speakersByMessageId.delete(messageId);
  if (!hadText && !hadSegments) return;
  notify(messageId, "complete");
}

/** The paragraph metadata of a delta, or undefined when it is malformed. */
export function parseStreamSegmentMeta(
  value: unknown,
): StreamSegmentMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { index, kind, speaker } = value as Record<string, unknown>;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
    return undefined;
  if (!(storySegmentKinds as readonly unknown[]).includes(kind))
    return undefined;
  return {
    index,
    kind: kind as StreamSegmentMeta["kind"],
    ...(typeof speaker === "string" && speaker ? { speaker } : {}),
  };
}

/**
 * Record what a streaming paragraph's metadata now says. Only the message's
 * own subscribers hear it; the text change in the same flush moves the
 * scroll.
 */
export function setStreamingSegment(
  messageId: string,
  meta: StreamSegmentMeta,
): void {
  const segments = [...(segmentsByMessageId.get(messageId) ?? [])];
  segments[meta.index] = meta;
  segmentsByMessageId.set(messageId, segments);
  speakersByMessageId.set(
    messageId,
    Array.from(segments, (segment) => segment?.speaker ?? null),
  );
  for (const listener of listenersByMessageId.get(messageId) ?? []) listener();
}

/**
 * The speaker of each paragraph streamed so far (`null` for narration and
 * unattributed lines), or undefined when no paragraph metadata arrived.
 */
export function getStreamingSpeakers(
  messageId: string,
): readonly (string | null)[] | undefined {
  return speakersByMessageId.get(messageId);
}

export function clearStreamingTextsForTurn(turnId: string): void {
  const prefix = `stream_${turnId}_`;
  for (const messageId of streamingMessageIds()) {
    if (messageId.startsWith(prefix)) clearStreamingText(messageId);
  }
}

export function clearAllStreamingText(): void {
  for (const messageId of streamingMessageIds()) {
    clearStreamingText(messageId);
  }
}

function streamingMessageIds(): string[] {
  return [
    ...new Set([...textByMessageId.keys(), ...segmentsByMessageId.keys()]),
  ];
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

/** Subscribe to the live paragraph speakers of one streaming message. */
export function useStreamingSpeakers(
  messageId: string,
): readonly (string | null)[] | undefined {
  const subscribe = useCallback(
    (listener: Listener) => subscribeToStreamingText(messageId, listener),
    [messageId],
  );
  return useSyncExternalStore(
    subscribe,
    () => getStreamingSpeakers(messageId),
    () => undefined,
  );
}

export function __clearStreamingTextForTest(): void {
  textByMessageId.clear();
  segmentsByMessageId.clear();
  speakersByMessageId.clear();
  listenersByMessageId.clear();
  globalListeners.clear();
}

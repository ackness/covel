import { useSyncExternalStore } from "react";

export interface DomainEventPreview {
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly toolCallId?: string;
  readonly topic: string;
  readonly data: Readonly<Record<string, unknown>>;
}

type Listener = () => void;

const previews = new Map<string, Map<string, DomainEventPreview>>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDomainEventPreview(
  sessionId: string,
  topic: string,
): DomainEventPreview | undefined {
  return previews.get(sessionId)?.get(topic);
}

export function applyDomainEventPreview(
  sessionId: string,
  preview: DomainEventPreview,
): void {
  const session = previews.get(sessionId) ?? new Map();
  session.set(preview.topic, preview);
  previews.set(sessionId, session);
  notify();
}

export function clearDomainEventPreviewsForTurn(
  sessionId: string,
  turnId: string | undefined,
): void {
  if (!turnId) return;
  const session = previews.get(sessionId);
  if (!session) return;
  let changed = false;
  for (const [topic, preview] of session) {
    if (preview.turnId !== turnId) continue;
    session.delete(topic);
    changed = true;
  }
  if (session.size === 0) previews.delete(sessionId);
  if (changed) notify();
}

export function clearDomainEventPreviews(sessionId: string): void {
  if (!previews.delete(sessionId)) return;
  notify();
}

export function __clearDomainEventPreviewsForTest(): void {
  if (previews.size === 0) return;
  previews.clear();
  notify();
}

export function useDomainEventPreview(
  sessionId: string,
  topic: string,
): DomainEventPreview | undefined {
  return useSyncExternalStore(subscribe, () =>
    getDomainEventPreview(sessionId, topic),
  );
}

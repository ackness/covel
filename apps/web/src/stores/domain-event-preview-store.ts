export interface DomainEventPreview {
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly toolCallId?: string;
  readonly topic: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const previews = new Map<string, Map<string, DomainEventPreview>>();

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
}

export function clearDomainEventPreviewsForTurn(
  sessionId: string,
  turnId: string | undefined,
): void {
  if (!turnId) return;
  const session = previews.get(sessionId);
  if (!session) return;
  for (const [topic, preview] of session) {
    if (preview.turnId !== turnId) continue;
    session.delete(topic);
  }
  if (session.size === 0) previews.delete(sessionId);
}

export function clearDomainEventPreviews(sessionId: string): void {
  previews.delete(sessionId);
}

export function __clearDomainEventPreviewsForTest(): void {
  previews.clear();
}

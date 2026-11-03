/** Ephemeral renderer admissions. Nothing here is serialized with a session. */
export interface CommittedStory {
  readonly id: string;
  readonly content: string;
  readonly segments?: readonly unknown[];
}
export const storyRevision = (message: CommittedStory): string =>
  JSON.stringify([message.id, message.content, message.segments]);

export function createStoryRevealVisit(history: readonly CommittedStory[]) {
  const known = new Set(history.map((message) => message.id));
  const pending = new Set<string>();
  // Revisions the player already read as a draft on surfaces that show drafts.
  const drafted = new Set<string>();
  const listeners = new Set<() => void>();
  let latest = "";
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => latest,
    admit(message: CommittedStory, shownAsDraft = false) {
      // A known durable ID is either duplicate delivery or authoritative
      // replacement. Neither is eligible for a new animation.
      if (known.has(message.id)) return;
      known.add(message.id);
      const revision = storyRevision(message);
      pending.clear();
      drafted.clear();
      latest = revision;
      pending.add(revision);
      if (shownAsDraft) drafted.add(revision);
      for (const listener of listeners) listener();
    },
    eligible: (revision: string) => pending.has(revision),
    shownAsDraft: (revision: string) => drafted.has(revision),
    claim(revision: string) {
      pending.delete(revision);
    },
    afterRender(messages: readonly CommittedStory[]) {
      for (const message of messages) known.add(message.id);
      // Views that were inactive when delivery rendered must not replay it later.
      pending.clear();
      drafted.clear();
    },
  };
}
export type StoryRevealVisit = ReturnType<typeof createStoryRevealVisit>;
const visits = new Map<string, Set<StoryRevealVisit>>();
export function registerStoryRevealVisit(
  sessionId: string,
  visit: StoryRevealVisit,
) {
  const entries = visits.get(sessionId) ?? new Set<StoryRevealVisit>();
  entries.add(visit);
  visits.set(sessionId, entries);
  return () => {
    entries.delete(visit);
    if (!entries.size) visits.delete(sessionId);
  };
}
/**
 * Only the committed live-delivery path calls this; snapshot hydration never
 * does. `shownAsDraft` says the player already read it while it was written.
 */
export function admitCommittedStory(
  sessionId: string,
  message: CommittedStory,
  shownAsDraft = false,
): void {
  for (const visit of visits.get(sessionId) ?? [])
    visit.admit(message, shownAsDraft);
}

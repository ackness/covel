/**
 * The `story-context@1` kernel input: notes that pre-turn runtimes hand to
 * the story of the same turn.
 *
 * A pre-turn runtime declares `io.storyContext` and the kernel reads one
 * value from its validated output (a {@link StoryContextContribution}). A
 * runtime that runs later binds `from: { kernel: story-context@1 }` and
 * receives every contribution of the turn as one {@link StoryContextValue}:
 * ranked, deduplicated and fitted to a token budget by the kernel. An agent
 * reads the notes in a `<story-context>` block of its turn context; a
 * function reads `ctx.inputs.<name>.value`.
 */
import { z } from "zod";

/** The kernel input a reader binds: `from: { kernel: story-context@1 }`. */
export const STORY_CONTEXT_INPUT = "story-context@1";

export const STORY_CONTEXT_LIMITS = {
  /** Characters of one contribution's text. */
  content: 6_000,
  /** Characters of one contribution's title. */
  title: 80,
  /** Estimated tokens of all notes of one turn, at most. */
  maxTokens: 3_000,
  /** Share of the story model's input window the notes may take, at most. */
  windowShare: 0.1,
} as const;

/** Ranking tier of a contribution: `high` notes come first. */
export const storyContextPriorities = ["high", "normal", "low"] as const;
export type StoryContextPriority = (typeof storyContextPriorities)[number];

/**
 * What a provider's `io.storyContext.select` points at. `null`, an empty
 * string or a missing value means the runtime has nothing to say this turn.
 * A string is the note's text; an object adds a title. Without one (or with
 * a blank one) the note takes the package's display name. Surrounding
 * whitespace of both is ignored.
 */
export type StoryContextContribution =
  string | { readonly title?: string; readonly content: string } | null;

/** Checks the value a provider contributes; use it in a provider's tests. */
export const storyContextContributionSchema = z.union([
  z.null(),
  z.string().max(STORY_CONTEXT_LIMITS.content),
  z.strictObject({
    title: z.string().max(STORY_CONTEXT_LIMITS.title).optional(),
    content: z.string().max(STORY_CONTEXT_LIMITS.content),
  }),
]);

/** The provider of a note: its package and runtime. */
export interface StoryContextSource {
  readonly pluginId: string;
  readonly runtimeId: string;
}

/** One note the reader receives, in ranked order. */
export interface StoryContextItem {
  readonly title: string;
  readonly content: string;
  readonly priority: StoryContextPriority;
  readonly source: StoryContextSource;
}

/** Why a contribution was left out. */
export type StoryContextOmissionReason = "budget" | "invalid" | "duplicate";

/** A contribution left out whole: over budget, malformed, or a repeat. */
export interface StoryContextOmission {
  readonly title: string;
  readonly source: StoryContextSource;
  readonly reason: StoryContextOmissionReason;
}

/** The value of the `story-context@1` input. It is always present. */
export interface StoryContextValue {
  readonly items: readonly StoryContextItem[];
  readonly omitted: readonly StoryContextOmission[];
}

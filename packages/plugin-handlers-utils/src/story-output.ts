/**
 * The story a runtime with `outputKind: story` returns. The kernel validates
 * it, renders the segment texts into `narrativeOutput` (joined by blank
 * lines) and commits it as one narrative message.
 */

export type StorySegmentKind = "narration" | "dialogue" | "action";

/** Who acts after this reply. `continue` is reserved for later and not used yet. */
export type StoryYield = "user" | "continue";

export interface StorySegment {
  readonly kind: StorySegmentKind;
  /** A character's name as written in the profiles, never an ID. */
  readonly speaker?: string;
  /** Complete prose with no blank line inside. */
  readonly text: string;
}

export interface StoryCues {
  readonly scene?: string;
  /** Names of the characters present, never IDs. */
  readonly present?: readonly string[];
  readonly mood?: string;
}

export interface StoryOutput {
  readonly segments: readonly StorySegment[];
  readonly cues?: StoryCues;
  readonly yield?: StoryYield;
  readonly [field: string]: unknown;
}

/**
 * A committed story segment as clients read it: `speaker` is the character's
 * current name when the written name resolved, and `speakerId` names that
 * character. An unresolved speaker keeps the written name and has no ID.
 */
export interface StoryMessageSegment {
  readonly kind: StorySegmentKind;
  readonly speaker?: string;
  readonly speakerId?: string;
  readonly text: string;
}

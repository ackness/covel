export const WORLD_EXPERIENCE_MODES = [
  "traditional-story",
  "dialogue-mode",
] as const;

export type WorldExperienceMode = (typeof WORLD_EXPERIENCE_MODES)[number];

export const WORLD_PACKAGE_CONTENT_KINDS = [
  "characters",
  "lorebook",
  "rules",
  "opening-kit",
] as const;

export type WorldPackageContentKind =
  (typeof WORLD_PACKAGE_CONTENT_KINDS)[number];

/**
 * Player-facing creative brief for AI world generation.
 *
 * The vocabulary stays product-level: callers choose the experience and
 * authored content they want without knowing plugin IDs or worldData URIs.
 */
export interface WorldCreationBrief {
  readonly experienceMode?: WorldExperienceMode;
  /** Kernel-owned content: characters, lorebook, rules, opening resources. */
  readonly content?: readonly WorldPackageContentKind[];
  /**
   * Plugin-owned content, as data contract IDs. The choices come from the
   * installed plugins' authoring declarations, never from a fixed list.
   */
  readonly contracts?: readonly string[];
  readonly additionalInstructions?: string;
}

/**
 * How long AI world authoring waits for the next output of the model. A
 * request that keeps writing is not cut off, so a slow model can finish a
 * long answer; only silence ends it. The player may set the wait.
 *
 * A request may ask for a wait from one second, so a test of the timeout
 * does not have to wait long. The app's own setting starts at `settingMin`:
 * a real model often needs several seconds before its first words.
 */
export const WORLD_AUTHORING_IDLE_TIMEOUT_MS = {
  default: 120_000,
  min: 1_000,
  max: 1_800_000,
  settingMin: 15_000,
} as const;

/**
 * One model request of a world generation, as the player sees it. A new
 * world is written one part at a time; a revision is one part.
 */
export interface WorldGenerationPart {
  /** `manifest`, `lore`, `characters`, `lorebook`, `rules`, `contract:<id>` or `revision`. */
  readonly id: string;
  /** Name of plugin-owned content. The caller names the other parts. */
  readonly title?: string;
  readonly state: "pending" | "active" | "done" | "failed";
  /** 1 for the first request of the part. */
  readonly attempt?: number;
  /** Characters of the answer received in the current request. */
  readonly chars?: number;
}

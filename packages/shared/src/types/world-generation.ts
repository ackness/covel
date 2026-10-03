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

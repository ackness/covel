/**
 * Mirror of `REASONING_EFFORT_VALUES` in `@covel/ai-provider` (the web app
 * deliberately does not depend on that package's runtime). Keep both lists
 * in sync when a provider adds a new level.
 *
 * Leaf module with no imports: the settings registry consumes it while the
 * services/api barrel is still initialising, so it must not participate in
 * that import cycle.
 */
export const REASONING_EFFORT_VALUES = [
  "disabled",
  "automatic",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

/** Persisted reasoning selections shared by settings and provider adapters. */
export const REASONING_EFFORT_VALUES = [
  "provider-default",
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

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORT_VALUES as readonly string[]).includes(value)
  );
}

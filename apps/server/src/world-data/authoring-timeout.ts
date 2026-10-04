import { WORLD_AUTHORING_IDLE_TIMEOUT_MS } from "@covel/shared";

/**
 * The idle timeout a world authoring request asks for. Absent means the
 * default. A value outside the range is an error and not a silent clamp, so
 * the caller learns that its setting does not apply.
 */
export function parseIdleTimeoutMs(value: unknown): {
  value?: number;
  error?: string;
} {
  if (value === undefined) return {};
  const { min, max } = WORLD_AUTHORING_IDLE_TIMEOUT_MS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return { error: `idleTimeoutMs must be an integer from ${min} to ${max}` };
  }
  return { value };
}

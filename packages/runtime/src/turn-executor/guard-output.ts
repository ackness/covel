import type { RuntimeResult } from "@covel/shared";

/**
 * A guard that returns `{ skip: true, ...fields }` answers for its agent
 * without an LLM call. `skip` is the guard's control flag; the remaining
 * fields are the runtime's output, so they are what the output contract
 * validates and what consumers bind. Scheduling skips carry no such flag and
 * provide nothing.
 */
export function isGuardProvided(
  result: Pick<RuntimeResult, "status" | "output"> | undefined,
): boolean {
  const output = result?.output;
  return (
    result?.status === "skipped" &&
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    (output as Record<string, unknown>).skip === true
  );
}

/** The contract-facing value of a guard-provided output. */
export function guardProvidedValue(output: unknown): Record<string, unknown> {
  const { skip: _skip, ...value } = output as Record<string, unknown>;
  return value;
}

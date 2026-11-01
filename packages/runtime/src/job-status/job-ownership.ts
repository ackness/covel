import type { JobStatusRecord, JsonValue } from "@covel/shared";

/** Kernel correlation, kept in the existing JSON data column across checkpoints. */
export interface JobOwnership {
  readonly runId: string;
  readonly attemptId: string;
  readonly settled: boolean;
}

export function jobOwnership(
  record: JobStatusRecord,
): JobOwnership | undefined {
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const value = (data as Record<string, JsonValue>)._covel;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const fields = value as Record<string, JsonValue>;
  if (
    typeof fields.runId !== "string" ||
    typeof fields.attemptId !== "string" ||
    typeof fields.settled !== "boolean"
  )
    return;
  return {
    runId: fields.runId,
    attemptId: fields.attemptId,
    settled: fields.settled,
  };
}

export function jobOwnershipData(
  owner: JobOwnership,
): Record<string, JsonValue> {
  return { _covel: { ...owner } };
}

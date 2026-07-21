/**
 * Shared storage quota for working-memory writes.
 *
 * Working memory is session-scoped state rendered into prompts, not a general
 * data store: the prompt renderer already caps what it shows, but without a
 * storage quota a looping plugin (or a scripted API client) can grow the table
 * without bound and pay for it on every turn's read. Updates to an existing
 * entry are always allowed — only new keys are refused once the session is at
 * capacity, so nothing a session already relies on (core memory blocks
 * included) is ever evicted. Bulk state belongs in plugin-data, which is not
 * prompt-resident.
 *
 * Both write paths — the `working_memory.set` commit handler and the REST
 * `PUT /api/sessions/:id/working-memory/:scope/:key` route — enforce this
 * single definition so the limits cannot drift apart.
 */

export const MAX_WORKING_MEMORY_ENTRIES = 200;
export const MAX_WORKING_MEMORY_VALUE_CHARS = 8_000;

export interface WorkingMemoryQuotaViolation {
  readonly kind: "value-too-large" | "entries-exhausted";
  readonly message: string;
}

/**
 * Check a prospective working-memory write against the quota.
 *
 * `existing` is the session's current entry list; pass `undefined` when the
 * backing store cannot enumerate entries (the value-size check still runs,
 * the entry-count check is skipped). A session holding fewer than
 * {@link MAX_WORKING_MEMORY_ENTRIES} entries may add a new key (the write
 * that lands exactly at the limit is allowed); at capacity, only updates to
 * existing keys pass.
 */
export function workingMemoryQuotaViolation(
  scope: string,
  key: string,
  value: unknown,
  existing:
    ReadonlyArray<{ readonly scope: string; readonly key: string }> | undefined,
): WorkingMemoryQuotaViolation | null {
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length > MAX_WORKING_MEMORY_VALUE_CHARS) {
    return {
      kind: "value-too-large",
      message:
        `value for "${scope}.${key}" is ${serialized.length} chars, ` +
        `over the ${MAX_WORKING_MEMORY_VALUE_CHARS}-char limit — store bulk data in plugin data instead`,
    };
  }

  if (!existing || existing.length < MAX_WORKING_MEMORY_ENTRIES) return null;
  const isUpdate = existing.some((e) => e.scope === scope && e.key === key);
  if (isUpdate) return null;
  return {
    kind: "entries-exhausted",
    message:
      `session already holds ${existing.length} working-memory entries ` +
      `(limit ${MAX_WORKING_MEMORY_ENTRIES}) — delete stale entries or use plugin data`,
  };
}

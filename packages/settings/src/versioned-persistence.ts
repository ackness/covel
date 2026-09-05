import type { SettingsPersistenceBundle } from "@covel/shared/settings-persistence";
import {
  SettingsRevisionConflictError,
  type SettingsBackendAdapter,
} from "./types.js";

type Entries = Record<string, unknown>;
type Change = { key: string; before: Entries; after: Entries };

/** Settings keys are atomic: nested objects never merge implicitly. */
export function sameSettingValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Entries;
  const b = right as Entries;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(
      (key) => Object.hasOwn(b, key) && sameSettingValue(a[key], b[key]),
    )
  );
}

function sameEntry(left: Entries, right: Entries, key: string): boolean {
  return (
    Object.hasOwn(left, key) === Object.hasOwn(right, key) &&
    sameSettingValue(left[key], right[key])
  );
}

function applyChanges(entries: Entries, changes: readonly Change[]): Entries {
  const next = { ...entries };
  for (const { key, after } of changes) {
    if (Object.hasOwn(after, key)) next[key] = after[key];
    else delete next[key];
  }
  return next;
}

/**
 * Rebase each local mutation onto the latest confirmed revision. A CAS retry
 * only changes keys whose previous value still matches this mutation's base.
 * Secrets are deliberately outside this protocol and never loaded here.
 */
export class VersionedSettingsPersistence {
  private tail: Promise<void> = Promise.resolve();
  private readonly pending: Change[][] = [];

  constructor(
    private readonly adapter: SettingsBackendAdapter,
    private bundle: SettingsPersistenceBundle,
    private readonly validate: (entries: Entries) => void,
    private readonly replaceVisible: (entries: Entries) => void,
  ) {
    this.bundle = structuredClone(bundle);
  }

  persist(keys: readonly string[], after: Entries): Promise<void> {
    const before = structuredClone(this.bundle.entries);
    const desired = structuredClone(after);
    // Intent matters even when the optimistic value is identical. A previous
    // queued write may fail, so a repeated set/clear still owns a real promise.
    const changes = [...new Set(keys)].map((key) => ({
      key,
      before,
      after: desired,
    }));
    this.pending.push(changes);
    return this.enqueue(async () => {
      try {
        if (changes.length > 0) {
          await this.saveChanges(changes);
          this.advancePendingBases(changes);
        }
      } finally {
        this.pending.splice(this.pending.indexOf(changes), 1);
        this.updateVisible();
      }
    });
  }

  refresh(): Promise<void> {
    return this.enqueue(async () => {
      this.adopt(await this.adapter.loadWithRevision!());
      this.updateVisible();
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(work);
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private adopt(bundle: SettingsPersistenceBundle): void {
    this.validate(bundle.entries);
    this.bundle = structuredClone(bundle);
  }

  private updateVisible(): void {
    let entries = this.bundle.entries;
    for (const changes of this.pending)
      entries = applyChanges(entries, changes);
    // get() exposes mutable objects for existing callers. They must never
    // alias either the confirmed baseline or another queued mutation's target.
    this.replaceVisible(structuredClone(entries));
  }

  private advancePendingBases(committed: readonly Change[]): void {
    const committedKeys = new Set(committed.map(({ key }) => key));
    for (const changes of this.pending) {
      for (const change of changes) {
        if (!committedKeys.has(change.key)) continue;
        // Only a confirmed local write can advance an already queued edit's
        // base. Remote changes and failed writes cannot grant that authority.
        const nextBase = { ...change.before };
        if (Object.hasOwn(this.bundle.entries, change.key)) {
          nextBase[change.key] = structuredClone(
            this.bundle.entries[change.key],
          );
        } else delete nextBase[change.key];
        change.before = nextBase;
      }
    }
  }

  private async saveChanges(changes: Change[]): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const conflicts = changes.filter(
        ({ key, before, after }) =>
          !sameEntry(this.bundle.entries, before, key) &&
          !sameEntry(this.bundle.entries, after, key),
      );
      if (conflicts.length > 0) {
        throw new SettingsRevisionConflictError(
          this.bundle.revision,
          conflicts.map(({ key }) => key),
        );
      }
      const next = applyChanges(this.bundle.entries, changes);
      this.validate(next);
      try {
        this.adopt(
          await this.adapter.saveWithRevision!(next, this.bundle.revision),
        );
        return;
      } catch (error) {
        if (!(error instanceof SettingsRevisionConflictError)) throw error;
        // Loading precedes comparison; validation must succeed before either
        // publishing external values or retrying a write against their revision.
        this.adopt(await this.adapter.loadWithRevision!());
      }
    }
    throw new SettingsRevisionConflictError(this.bundle.revision);
  }
}

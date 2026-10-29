/**
 * What a suspension's buffered writes would overwrite.
 *
 * A suspended runtime keeps the proposals it buffered before it stopped, and
 * the resume commits them later. In between, a background job or a manual run
 * can write the same plugin data key, character or lorebook
 * entry. Committing the buffered value then would silently put back what the
 * runtime saw when it stopped.
 *
 * So the transaction that saves a suspension records a digest of every record
 * its buffered proposals write (`SuspensionBasis.writes`), and the resume's
 * commit transaction reads them again before it writes anything: when one
 * changed, nothing commits and the suspension is out of date. Dimension
 * proposals are left out: they carry the version they were built from and the
 * commit rejects them when it moved on. A `plugin.data.update` counts only
 * when its operations contain `set` or `delete`: relative operations (`inc`,
 * `merge`, array operations) apply to whatever value is stored at commit, so
 * they cannot put back a stale whole value.
 */

import { isRecord } from "../utils/is-record.js";
import type { Proposal } from "@covel/shared";
import type {
  SuspensionWriteBaseline,
  SuspensionWriteTarget,
} from "@covel/store";
import { readSuspensionWriteDigest } from "@covel/store/session";

/** The reads a baseline needs; a `StoreTransaction` reads inside its transaction. */
export type SuspensionWriteReader = Parameters<
  typeof readSuspensionWriteDigest
>[0];

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The records `proposals` write, each once. A malformed proposal names no
 * record: its commit fails on its own.
 */
export function suspensionWriteTargets(
  proposals: readonly unknown[],
): SuspensionWriteTarget[] {
  const targets = new Map<string, SuspensionWriteTarget>();
  const add = (target: SuspensionWriteTarget) =>
    targets.set(JSON.stringify(target), target);
  for (const raw of proposals) {
    if (!isRecord(raw) || !isRecord(raw.payload)) continue;
    const proposal = raw as Partial<Proposal> & {
      payload: Record<string, unknown>;
    };
    const pluginId = proposal.source?.pluginId;
    const { payload } = proposal;
    switch (proposal.type) {
      case "plugin.data":
      case "plugin.data.delete":
        if (
          nonEmpty(pluginId) &&
          nonEmpty(payload.namespace) &&
          nonEmpty(payload.key)
        )
          add({
            kind: "plugin-data",
            pluginId,
            namespace: payload.namespace,
            key: payload.key,
          });
        break;
      case "plugin.data.update":
        if (
          nonEmpty(pluginId) &&
          nonEmpty(payload.namespace) &&
          nonEmpty(payload.key) &&
          Array.isArray(payload.ops) &&
          (payload.ops as unknown[]).some(
            (op) => isRecord(op) && (op.op === "set" || op.op === "delete"),
          )
        )
          add({
            kind: "plugin-data",
            pluginId,
            namespace: payload.namespace,
            key: payload.key,
          });
        break;
      case "plugin.data.batch":
        if (!nonEmpty(pluginId) || !Array.isArray(payload.items)) break;
        for (const item of payload.items as unknown[]) {
          if (isRecord(item) && nonEmpty(item.namespace) && nonEmpty(item.key))
            add({
              kind: "plugin-data",
              pluginId,
              namespace: item.namespace,
              key: item.key,
            });
        }
        break;
      case "character.upsert":
        if (nonEmpty(payload.id)) add({ kind: "character", id: payload.id });
        break;
      case "character.schema.set":
        add({ kind: "character-schema" });
        break;
      case "lorebook.upsert":
        if (!nonEmpty(pluginId) || !Array.isArray(payload.entries)) break;
        for (const entry of payload.entries as unknown[]) {
          if (isRecord(entry) && nonEmpty(entry.id))
            add({ kind: "lorebook", pluginId, id: entry.id });
        }
        break;
      default:
        break;
    }
  }
  return [...targets.values()];
}

/** Read the records `proposals` write, as they are now. */
export async function takeSuspensionWriteBaseline(
  reader: SuspensionWriteReader,
  sessionId: string,
  proposals: readonly unknown[],
): Promise<SuspensionWriteBaseline[]> {
  const baseline: SuspensionWriteBaseline[] = [];
  // One read at a time: a transaction holds one connection.
  for (const target of suspensionWriteTargets(proposals)) {
    baseline.push({
      target,
      digest: await readSuspensionWriteDigest(reader, sessionId, target),
    });
  }
  return baseline;
}

/** The records of `baseline` whose content is no longer what it was. */
export async function changedSuspensionWrites(
  reader: SuspensionWriteReader,
  sessionId: string,
  baseline: readonly SuspensionWriteBaseline[],
): Promise<SuspensionWriteTarget[]> {
  const changed: SuspensionWriteTarget[] = [];
  for (const { target, digest } of baseline) {
    if ((await readSuspensionWriteDigest(reader, sessionId, target)) !== digest)
      changed.push(target);
  }
  return changed;
}

function describeTarget(target: SuspensionWriteTarget): string {
  switch (target.kind) {
    case "plugin-data":
      return `plugin data ${target.pluginId}/${target.namespace}/${target.key}`;
    case "character":
      return `character ${target.id}`;
    case "character-schema":
      return "the character schema";
    case "lorebook":
      return `lorebook entry ${target.pluginId}/${target.id}`;
  }
}

/** Thrown in a resume's commit transaction when a record it would write changed. */
export class SuspensionDataChangedError extends Error {
  readonly code = "suspension-data-changed" as const;
  constructor(readonly changed: readonly SuspensionWriteTarget[]) {
    super(
      `Records the suspension would write changed after it was taken: ${changed
        .map(describeTarget)
        .join(", ")}`,
    );
    this.name = "SuspensionDataChangedError";
  }
}

/** Throws {@link SuspensionDataChangedError} when a record of `baseline` changed. */
export async function assertSuspensionWritesUnchanged(
  reader: SuspensionWriteReader,
  sessionId: string,
  baseline: readonly SuspensionWriteBaseline[],
): Promise<void> {
  if (baseline.length === 0) return;
  const changed = await changedSuspensionWrites(reader, sessionId, baseline);
  if (changed.length > 0) throw new SuspensionDataChangedError(changed);
}

/**
 * Persistent `recordAs` export publishing (docs 02 §3.4).
 *
 * A runtime that declares `output.recordAs` publishes each successful result as
 * a session-scoped, read-only, cross-plugin, versioned export. Publishing runs
 * INSIDE `finalizeExecution`'s transaction, so a rolled-back execution never
 * leaves an orphan export and a committed one lands its export atomically with
 * the domain writes (docs 02 §3.4.1 / §3.4.5).
 *
 * The export boundary is always enforced: the value must pass the declared
 * `output.schema` before it is published. A legacy handler whose outcome stayed
 * "success" but whose value fails the schema keeps its success outcome — only
 * the export is withheld, with an `export-schema-invalid` diagnostic (docs 02
 * §4.3). No per-export failure (schema-invalid, revision race, store error) is
 * allowed to roll back an otherwise-committed execution, so every branch here
 * swallows and continues.
 */

import { createHash } from "node:crypto";
import type { JsonValue, RuntimeExportRecord } from "@covel/shared";
import { validateOutput } from "@covel/tools";
import type { MediaCanonicalization } from "../media/canonicalize-media-refs.js";

type Schema = Readonly<Record<string, unknown>>;

/** The store surface the publisher needs — satisfied by DataStore and StoreTransaction alike. */
interface ExportSink {
  getLatestRuntimeExport(
    sessionId: string,
    producerRuntimeId: string,
    recordAs: string,
  ): Promise<RuntimeExportRecord | null>;
  appendRuntimeExport(record: RuntimeExportRecord): Promise<boolean>;
}

/** Loose success-result shape the publisher reads (a superset of the finalize result). */
interface PublishableResult {
  readonly status?: string;
  readonly runtimeId: string;
  readonly runId?: string;
  readonly resultId?: string;
  readonly output?: unknown;
}

/** Per-runtime `recordAs` declaration plus producer provenance. */
export interface ExportDecl {
  readonly recordAs: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
}

export interface PublishExecutionExportsArgs {
  readonly sink: ExportSink;
  readonly sessionId: string;
  readonly results: readonly PublishableResult[];
  /** The runtime's `output.recordAs` declaration, or `undefined` if it has none. */
  readonly declFor: (runtimeId: string) => ExportDecl | undefined;
  /** Loads the runtime's declared `output.schema` (containment-checked by the loader). */
  readonly loadOutputSchema: (runtimeId: string) => Promise<Schema | undefined>;
  /** Publish instant — shared with the session-clock write so a series is monotonic in time. */
  readonly committedAt: string;
  /**
   * Canonicalize + ownership-check the export value's MediaRefs before it is
   * persisted (docs 02 §2.1 / §3.4): the transient `url` is stripped and each
   * ref is proven owned, so a consumer reads a canonical value with no second
   * pass. A rejection withholds the export (like `export-schema-invalid`) —
   * never rolls back the committed execution. Absent ⇒ no media processing.
   */
  readonly canonicalize?: (value: JsonValue) => Promise<MediaCanonicalization>;
}

/**
 * Canonical JSON with sorted object keys, so a schema's digest is stable
 * regardless of key order in the source file. Schemas are plain JSON, so this
 * narrow serialiser is sufficient; a MediaRef-aware canonicaliser is only
 * needed once export VALUES (not schemas) carry media refs (media wave).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

function digestOf(schema: Schema): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

/**
 * Publish an export revision for every `status: success` result whose runtime
 * declares `output.recordAs`. Runs to completion regardless of individual
 * failures; never throws (see file header). `revision` is the current max for
 * `(producerRuntimeId, recordAs)` + 1, read and written in the same store scope
 * — a lost race (append returns `false`) is re-read and retried once.
 */
export async function publishExecutionExports(
  args: PublishExecutionExportsArgs,
): Promise<void> {
  const {
    sink,
    sessionId,
    results,
    declFor,
    loadOutputSchema,
    committedAt,
    canonicalize,
  } = args;
  for (const result of results) {
    if (result.status !== "success") continue;
    const decl = declFor(result.runtimeId);
    if (!decl) continue;
    try {
      const schema = await loadOutputSchema(result.runtimeId);
      if (!schema) {
        // recordAs implies a schema (loader-enforced); a missing one here means
        // the producer could not be re-loaded. Withhold rather than publish an
        // unvalidated value.
        console.warn(
          `[runtime-export] ${result.runtimeId}: recordAs "${decl.recordAs}" has no loadable output.schema — export withheld`,
        );
        continue;
      }
      let value = (result.output ?? null) as JsonValue;
      // Canonicalize BEFORE schema validation (docs 02 §2): the stored value
      // has its transient url stripped and every MediaRef proven owned. A media
      // rejection withholds the export without touching the domain outcome.
      if (canonicalize) {
        const canon = await canonicalize(value);
        if (canon.rejections.length > 0) {
          console.warn(
            `[runtime-export] ${result.runtimeId}: media rejected for recordAs "${decl.recordAs}" — export withheld: ${canon.rejections
              .map((r) => `${r.id}:${r.reason}`)
              .join("; ")}`,
          );
          continue;
        }
        value = canon.value;
      }
      const validation = validateOutput(value, schema);
      if (!validation.valid) {
        // export-schema-invalid: the value fails the producer's own schema (or
        // a consumer's expected shape). Domain outcome is untouched — only the
        // public export face is withheld (docs 02 §4.3).
        console.warn(
          `[runtime-export] ${result.runtimeId}: export-schema-invalid for recordAs "${decl.recordAs}": ${(
            validation.errors ?? []
          )
            .slice(0, 3)
            .join("; ")}`,
        );
        continue;
      }

      const schemaDigest = digestOf(schema);
      const resultId = result.resultId ?? result.runId ?? "";
      const build = (revision: number): RuntimeExportRecord => ({
        sessionId,
        producerPluginId: decl.pluginId,
        producerRuntimeId: result.runtimeId,
        recordAs: decl.recordAs,
        revision,
        pluginVersion: decl.pluginVersion,
        schemaDigest,
        resultId,
        value,
        committedAt,
      });

      const latest = await sink.getLatestRuntimeExport(
        sessionId,
        result.runtimeId,
        decl.recordAs,
      );
      let inserted = await sink.appendRuntimeExport(
        build((latest?.revision ?? 0) + 1),
      );
      if (!inserted) {
        // Lost the race for that revision number — re-read and retry once. A
        // single execution never publishes the same series concurrently, so one
        // retry closes the only real window (a concurrent cross-execution write).
        const again = await sink.getLatestRuntimeExport(
          sessionId,
          result.runtimeId,
          decl.recordAs,
        );
        inserted = await sink.appendRuntimeExport(
          build((again?.revision ?? 0) + 1),
        );
      }
      if (!inserted) {
        console.warn(
          `[runtime-export] ${result.runtimeId}: could not claim a revision for recordAs "${decl.recordAs}" — export skipped`,
        );
      }
    } catch (err) {
      // A publish failure must never sink an already-committed execution.
      console.warn(
        `[runtime-export] ${result.runtimeId}: export publish failed for recordAs "${decl.recordAs}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Runtime-export contract type for the runtime-scheduling redesign.
 *
 * `output.recordAs` publishes a successful runtime result as a session-scoped,
 * read-only, cross-plugin, versioned persistent export. Consumers read the
 * latest committed revision that was frozen at execution start (see
 * `getLatestRuntimeExport`'s `atOrBefore`), so a producer that publishes a new
 * revision mid-plan does not change what an already-running consumer observes.
 *
 * This file only declares the persistence-facing shape; no kernel logic reads
 * or writes it yet (the finalizeExecution wiring is a later wave). The record is
 * immutable — a new publish is a new record at the next `revision`, never an
 * in-place edit.
 *
 * Identity / idempotency key: `(sessionId, producerRuntimeId, recordAs,
 * revision)`. `revision` is a per-`(producerRuntimeId, recordAs)` counter that
 * increases monotonically from 1; a re-insert of an existing key is a no-op.
 * `producerPluginId`, `pluginVersion`, `schemaDigest` and `resultId` are
 * provenance metadata (which plugin/version produced it, the value's schema
 * digest, and the originating runtime-result id) and do not participate in the
 * key.
 */

import type { JsonValue } from "./runtime-scheduling.js";

export interface RuntimeExportRecord {
  readonly sessionId: string;
  readonly producerPluginId: string;
  readonly producerRuntimeId: string;
  readonly recordAs: string;
  readonly revision: number;
  readonly pluginVersion: string;
  readonly schemaDigest: string;
  readonly resultId: string;
  readonly value: JsonValue;
  readonly committedAt: string;
}

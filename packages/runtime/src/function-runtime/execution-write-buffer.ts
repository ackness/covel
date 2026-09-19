/**
 * Execution-scoped write buffer for function-runtime handlers and agent
 * guards.
 *
 * These paths run OUTSIDE the agent tool loop, so they have no
 * `context.pendingProposals` channel. Their domain writes used to hit the
 * DataStore directly, escaping the whole-execution transaction: a handler that
 * wrote and then failed (or a sibling runtime that rolled back) left orphaned
 * rows behind.
 *
 * The buffer collects those writes as proposals instead. At execution end the
 * caller flushes them onto the runtime result's output via
 * `withPendingProposals`, so they commit through the same
 * `finalizeExecution` transaction as everything else — and a rollback discards
 * them.
 *
 * Reads consult the buffer first (read-through overlay) so a handler/guard sees
 * its own not-yet-committed writes within the same execution. The overlay is
 * per-execution only; cross-runtime same-turn reads are not merged.
 */

import type { CharacterRecord, PluginDataRecord } from "@covel/store";
import type { Proposal } from "@covel/shared";
import { overlayCharacters, overlayPluginDataRows } from "@covel/tools";
import type { HandlerHelperContext } from "./plugin-handler-helpers.js";

/** A mutable per-execution proposal buffer. */
export type ExecutionWriteBuffer = Proposal[];

export function createExecutionWriteBuffer(): ExecutionWriteBuffer {
  return [];
}

function proposalSource(ctx: HandlerHelperContext) {
  return { pluginId: ctx.pluginId, runtimeId: ctx.runtimeId };
}

/** Buffer a single plugin-data write. */
export function bufferPluginData(
  buffer: ExecutionWriteBuffer,
  ctx: HandlerHelperContext,
  namespace: string,
  key: string,
  value: unknown,
): void {
  buffer.push({
    id: crypto.randomUUID(),
    type: "plugin.data",
    source: proposalSource(ctx),
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    payload: { namespace, key, value: structuredClone(value) },
    timestamp: new Date().toISOString(),
  });
}

/** Buffer a batch plugin-data write. */
export function bufferPluginDataBatch(
  buffer: ExecutionWriteBuffer,
  ctx: HandlerHelperContext,
  items: readonly { namespace: string; key: string; value: unknown }[],
): void {
  buffer.push({
    id: crypto.randomUUID(),
    type: "plugin.data.batch",
    source: proposalSource(ctx),
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    payload: {
      items: items.map((i) => ({
        namespace: i.namespace,
        key: i.key,
        value: structuredClone(i.value),
      })),
    },
    timestamp: new Date().toISOString(),
  });
}

/** Buffer a plugin-data delete. */
export function bufferPluginDataDelete(
  buffer: ExecutionWriteBuffer,
  ctx: HandlerHelperContext,
  namespace: string,
  key: string,
): void {
  buffer.push({
    id: crypto.randomUUID(),
    type: "plugin.data.delete",
    source: proposalSource(ctx),
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    payload: { namespace, key },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Buffer a character upsert. No `mirrorPluginId` is set: trusted guards drive
 * their own plugin-data mirror through a separate `setPluginData` call (which
 * also buffers), so setting a mirror here would double-write the snapshot.
 */
export function bufferCharacterUpsert(
  buffer: ExecutionWriteBuffer,
  ctx: HandlerHelperContext,
  record: CharacterRecord,
): void {
  buffer.push({
    id: crypto.randomUUID(),
    type: "character.upsert",
    source: proposalSource(ctx),
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    payload: {
      id: record.id,
      name: record.name,
      type: record.type,
      ...(record.description !== undefined
        ? { description: record.description }
        : {}),
      ...(record.fields !== undefined
        ? { fields: structuredClone(record.fields) }
        : {}),
      version: record.version,
      createdAt: record.createdAt,
    },
    timestamp: new Date().toISOString(),
  });
}

/** Merge committed plugin-data rows with buffered writes (buffer wins). */
export function mergePluginDataRows(
  stored: readonly PluginDataRecord[],
  buffer: ExecutionWriteBuffer,
  sessionId: string,
  pluginId?: string,
  namespace?: string,
): PluginDataRecord[] {
  const pluginIds =
    pluginId === undefined
      ? new Set(buffer.map((proposal) => proposal.source.pluginId))
      : [pluginId];
  const now = new Date().toISOString();
  const byKey = new Map<string, PluginDataRecord>();
  const compositeKey = (owner: string, ns: string, key: string) =>
    JSON.stringify([owner, ns, key]);
  for (const row of stored)
    byKey.set(compositeKey(row.pluginId, row.namespace, row.key), row);
  for (const owner of pluginIds) {
    const overlay = overlayPluginDataRows(buffer, owner, namespace);
    for (const entry of overlay.values()) {
      const ck = compositeKey(owner, entry.namespace, entry.key);
      if (entry.deleted) {
        byKey.delete(ck);
        continue;
      }
      const base = byKey.get(ck);
      byKey.set(ck, {
        id: base?.id ?? crypto.randomUUID(),
        sessionId,
        pluginId: owner,
        namespace: entry.namespace,
        key: entry.key,
        value: entry.value,
        createdAt: base?.createdAt ?? now,
        updatedAt: now,
      });
    }
  }
  return structuredClone([...byKey.values()]);
}

/** Merge committed characters with buffered `character.upsert` writes. */
export function mergeCharacterRecords(
  stored: readonly CharacterRecord[],
  buffer: ExecutionWriteBuffer,
  sessionId: string,
): CharacterRecord[] {
  return [...overlayCharacters(buffer, stored, sessionId).values()];
}

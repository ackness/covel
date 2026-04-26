/**
 * Session Kernel — the unified translation layer between Runtime and Client.
 *
 * All runtime output flows through this layer:
 *   RuntimeOutput → normalizeOutput() → Proposal[]
 *   Proposal → commitProposal() → persist to Store + emit SessionEvent
 *
 * Design references:
 * - Z-machine: stable proposal types as "instruction set"
 * - Bevy ECS: deferred Commands (buffer → commit)
 * - Bukkit: priority-ordered event pipeline
 * - Event Sourcing: append-only proposals → replay → rebuild state
 */

import { getPendingProposals } from '@covel/tools';
import {
  assetGenerateToView,
  isAssetGeneratePayload,
  isEnvDefaultOn,
  isEnvEnabled,
  normalizeUIRenderInstruction,
} from '@covel/shared';
import type {
  AssetGeneratePayload,
  CommitResult,
  PluginDataBatchPayload,
  PluginDataPayload,
  Proposal,
  ProposalSource,
  ProposalType,
  SessionEvent,
  UIRenderInstruction,
  UIRenderPayload,
} from '@covel/shared';
import type { EventBus } from '@covel/events';
import type { HookPipeline } from './hooks/pipeline.js';
import type { HookContext } from './hooks/types.js';

// ── Proposal Normalizer ─────────────────────────────────────────

/**
 * Convert arbitrary RuntimeOutput into a normalized Proposal array.
 *
 * This is the core translation step: no matter what shape a runtime's
 * output takes, it gets converted to a standard set of Proposals that
 * the kernel knows how to commit and emit.
 */
export function normalizeOutput(
  output: Record<string, unknown>,
  source: ProposalSource,
  turnId: string,
  sessionId: string,
  outputKind?: string,
  toolCalls?: ReadonlyArray<{ output?: unknown }>,
): Proposal[] {
  const proposals: Proposal[] = [];
  const kind = outputKind ?? 'plugin';

  // narrative.append — from narrativeOutput or content (fallback).
  //
  // Only `story` runtimes may append to the narrative feed. `system` and
  // `plugin` runtimes that happen to return `narrativeOutput` (e.g. a
  // tool-less LLM response on a non-story plugin) must NOT pollute the
  // chat stream — their text is still available via RuntimeResult.output
  // for trace and debug consumers. This blocks the core-guide failure
  // mode where the LLM ignored `generate-guide` and wrote a narrative
  // continuation that the framework silently committed alongside
  // narrator's real output.
  const narrativeText =
    kind === 'story'
      ? (typeof output.narrativeOutput === 'string' && output.narrativeOutput) ||
        (typeof output.content === 'string' && output.content) ||
        ''
      : '';

  if (narrativeText) {
    proposals.push(makeProposal('narrative.append', source, turnId, sessionId, {
      content: narrativeText,
      kind,
    }));
  }

  // interaction.request — from interactions[] (modern) or form (legacy)
  const interactions = output.interactions as Array<Record<string, unknown>> | undefined;
  if (interactions && interactions.length > 0) {
    for (const inter of interactions) {
      proposals.push(makeProposal('interaction.request', source, turnId, sessionId, {
        interactionId: inter.interactionId ?? inter.formId ?? '',
        type: inter.type ?? 'form',
        ...inter,
      }));
    }
  } else if (output.form && typeof output.form === 'object') {
    const form = output.form as Record<string, unknown>;
    proposals.push(makeProposal('interaction.request', source, turnId, sessionId, {
      interactionId: (form.formId ?? '') as string,
      type: 'form',
      ...form,
    }));
  }

  // ui blocks — from runtime output or tool-call parsed results
  const uiBlocks = collectUiBlocks(output, toolCalls);
  for (const [index, block] of uiBlocks.entries()) {
    const fallbackId =
      (typeof block.interactionId === 'string' && block.interactionId) ||
      (typeof block.id === 'string' && block.id) ||
      `ui-${index + 1}`;
    proposals.push(makeProposal('ui.render', source, turnId, sessionId, {
      ...normalizeUIRenderInstruction(block as unknown as UIRenderInstruction, fallbackId),
    }));
  }

  // state.patch — from statePatches[]
  const statePatches = output.statePatches as Array<Record<string, unknown>> | undefined;
  if (statePatches && statePatches.length > 0) {
    for (const patch of statePatches) {
      proposals.push(makeProposal('state.patch', source, turnId, sessionId, patch));
    }
  }

  // Legacy `phase` field from runtime output is ignored. The session state
  // model is now `status + turnCount + preGameCompleted` — there is no
  // persistent `phase` column and no `phase.changed` event is forwarded.
  // Runtimes that still include `phase` in their output are silently
  // accepted (no error) so plugins can upgrade on their own schedule.

  // event.emit — from events[]
  const events = output.events as Array<Record<string, unknown>> | undefined;
  if (events && events.length > 0) {
    for (const evt of events) {
      proposals.push(makeProposal('event.emit', source, turnId, sessionId, evt));
    }
  }

  // asset.generate — from output.assets[] and output.assetGenerations[].
  // Accepted entry shape: { ref: MediaRef, modality: string, meta?: object }.
  for (const asset of collectAssetGenerations(output)) {
    proposals.push(makeProposal('asset.generate', source, turnId, sessionId, {
      ref: asset.ref,
      modality: asset.modality,
      ...(asset.meta ? { meta: asset.meta } : {}),
    }));
  }

  // plugin.data / plugin.data.batch — from pluginData[]. Each entry is
  // `{ namespace, key, value }`. Single entry → plugin.data, multiple → a
  // batched plugin.data.batch so commits happen in one store call. Function
  // runtimes need this to write their own namespace (e.g. image galleries,
  // job state, per-session caches) without reaching into DataStore directly.
  const pluginData = output.pluginData as Array<{
    namespace?: unknown;
    key?: unknown;
    value?: unknown;
  }> | undefined;
  if (Array.isArray(pluginData) && pluginData.length > 0) {
    const items = pluginData
      .filter(
        (item): item is { namespace: string; key: string; value: unknown } =>
          !!item
          && typeof item === 'object'
          && typeof item.namespace === 'string'
          && item.namespace.length > 0
          && typeof item.key === 'string'
          && item.key.length > 0
          && 'value' in item,
      )
      .map((item) => ({
        namespace: item.namespace,
        key: item.key,
        value: item.value,
      }));
    if (items.length === 1) {
      proposals.push(
        makeProposal('plugin.data', source, turnId, sessionId, items[0]),
      );
    } else if (items.length > 1) {
      proposals.push(
        makeProposal('plugin.data.batch', source, turnId, sessionId, { items }),
      );
    }
  }

  // notifications[] — system-level messages surfaced to the chat feed.
  // Each notification is normalised into a narrative.append proposal with
  // kind='system' so it flows through the same commit path as any assistant
  // message without requiring a new proposal type or frontend wiring.
  //
  // Plugins that want a richer notification UI can additionally emit
  // `events: [{ topic: 'notification.shown', data: {...} }]` — the event.emit
  // branch above already handles that and the frontend can subscribe.
  const notifications = output.notifications as Array<Record<string, unknown>> | undefined;
  if (notifications && notifications.length > 0) {
    for (const n of notifications) {
      const title = typeof n.title === 'string' ? n.title.trim() : '';
      const message = typeof n.message === 'string' ? n.message.trim() : '';
      if (!title && !message) continue; // empty notification — skip
      const content = title && message ? `${title}\n${message}` : title || message;
      proposals.push(makeProposal('narrative.append', source, turnId, sessionId, {
        content,
        kind: 'system',
      }));
    }
  }

  return proposals;
}

// ── Commit Pipeline ──────────────────────────────────────────────

/**
 * Minimal store interface for the commit pipeline.
 * Uses only the methods it needs from DataStore — no direct dependency.
 */
export interface KernelStore {
  addMessage(record: { id: string; sessionId: string; role: string; content: string; metadata?: unknown; createdAt: string }): Promise<void>;
  updateSession(id: string, patch: Record<string, unknown>): Promise<void>;
  saveEvent(record: { id: string; sessionId: string; type: string; topic: string; payload: unknown; createdAt: string }): Promise<void>;
  addStateChange(record: { id: string; sessionId: string; tableName: string; fieldName: string; value: unknown; changedBy: string; turnId: string; reason?: string; createdAt: string }): Promise<void>;
  addTraceEvent(record: { id: string; sessionId: string; type: string; traceId: string; turnId: string; payload: unknown; createdAt: string }): Promise<void>;
  setPluginData?(record: {
    id: string;
    sessionId: string;
    pluginId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  setPluginDataBatch?(records: readonly {
    id: string;
    sessionId: string;
    pluginId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  }[]): Promise<void>;
  /**
   * Working Memory upsert (S3-T3). Optional so the kernel stays compatible
   * with thin mock stores in existing tests that don't need WM.
   */
  upsertWorkingMemory?(record: { id: string; sessionId: string; key: string; scope: 'player' | 'story' | 'shared'; value: unknown; schemaRef?: string; updatedAt: string }): Promise<void>;
  /**
   * Session lorebook upsert (S3-T2). Optional for the same reason as
   * upsertWorkingMemory — thin mock stores may not implement it.
   */
  upsertLorebookEntries?(records: ReadonlyArray<{
    id: string;
    sessionId: string;
    pluginId: string;
    keys: readonly string[];
    content: string;
    strategy: 'constant' | 'selective';
    position: string;
    insertionOrder: number;
    enabled: boolean;
    extra?: unknown;
    createdAt: string;
    updatedAt: string;
  }>): Promise<void>;
  /**
   * Optional transaction hooks (S4-T1). When present and opted-in via the
   * COVEL_COMMIT_TXN_V1 feature flag, `commitAll()` wraps the whole proposal
   * chain in begin/commit/rollback so a mid-chain failure leaves no partial
   * state in the store.
   */
  beginTx?(): Promise<void>;
  commitTx?(): Promise<void>;
  rollbackTx?(): Promise<void>;
}

/**
 * The Commit Pipeline: Proposal → persist to Store → emit SessionEvent.
 *
 * Every proposal type has a dedicated commit handler that knows how to
 * persist it and what event to emit. Unknown types are rejected.
 */
export interface CommitPipeline {
  commit(proposal: Proposal): Promise<CommitResult>;
  commitAll(proposals: readonly Proposal[]): Promise<CommitResult[]>;
}

export function createCommitPipeline(
  store: KernelStore,
  hookPipeline?: HookPipeline,
  eventBus?: EventBus,
  emitter?: import('./turn-emitter.js').TurnEmitter,
): CommitPipeline {
  function isCommitTransactionEnabled(): boolean {
    return isEnvDefaultOn('COVEL_COMMIT_TXN_V1');
  }

  const handlers: Record<string, (p: Proposal) => Promise<CommitResult>> = {
    'narrative.append': commitNarrative,
    'interaction.request': commitInteraction,
    'ui.render': commitUIRender,
    'state.patch': commitStatePatch,
    'event.emit': commitEvent,
    'plugin.data': commitPluginData,
    'plugin.data.batch': commitPluginDataBatch,
    'working_memory.set': commitWorkingMemory,
    'lorebook.upsert': commitLorebookUpsert,
    'asset.generate': commitAssetGenerate,
  };

  async function commit(proposal: Proposal): Promise<CommitResult> {
    const handler = handlers[proposal.type];
    if (!handler) {
      return { committed: false, error: `unknown proposal type: ${proposal.type}` };
    }

    // ── PreStateCommit hook ──────────────────────────────────────
    // Pipeline presence is the gate. Callers that don't want hooks
    // pass `hookPipeline: undefined` (e.g. dev/tests that exercise the
    // bare commit path).
    let effectiveProposal = proposal;
    if (hookPipeline) {
      const hookCtx: HookContext = {
        event: 'PreStateCommit',
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        // Thread the originating plugin/runtime through so `hook.fired` /
        // `hook.rewrote` / `hook.aborted` trace rows can link back to the
        // runtime whose proposal is being gated. Without this, every
        // state-commit hook event on /debug carries runtimeId=undefined.
        pluginId: proposal.source.pluginId,
        runtimeId: proposal.source.runtimeId,
      };
      const preResult = await hookPipeline.run('PreStateCommit', hookCtx, { proposal }, { eventBus, emitter });
      if (preResult.action === 'abort') {
        // HookPipeline.run itself now emits `hook.aborted` through the
        // emitter (persist + broadcast). No inline trace write needed —
        // keeping one would double-record and split the payload schema
        // between the two call sites.
        return { committed: false, error: `pre-state-commit hook aborted: ${preResult.reason}` };
      }
      if (preResult.action === 'continue' && 'replace' in preResult && preResult.replace?.proposal) {
        effectiveProposal = preResult.replace.proposal as Proposal;
      }
    }

    const result = await handler(effectiveProposal);

    // Trace every committed proposal
    if (result.committed) {
      await store.addTraceEvent({
        id: crypto.randomUUID(),
        sessionId: effectiveProposal.sessionId,
        type: 'proposal.committed',
        traceId: effectiveProposal.turnId,
        turnId: effectiveProposal.turnId,
        payload: { proposalType: effectiveProposal.type, proposalId: effectiveProposal.id, source: effectiveProposal.source },
        createdAt: new Date().toISOString(),
      });
    }

    // Fan out fine-grained trace + SSE events based on proposal type.
    // The generic `proposal.committed` row above is kept for back-compat;
    // these richer events carry the full block / state-patch payload so
    // the debug UI can render them without extra joins.
    if (result.committed && emitter) {
      if (effectiveProposal.type === 'interaction.request') {
        const payloadAny = effectiveProposal.payload as Record<string, unknown>;
        await emitter.emit('block.emitted', {
          runtimeId: effectiveProposal.source.runtimeId,
          pluginId: effectiveProposal.source.pluginId,
          proposalId: effectiveProposal.id,
          source: effectiveProposal.source,
          // block.meta is already expressed by outer runtimeId/pluginId/turnId — omitted intentionally
          block: {
            id: effectiveProposal.id,
            type: resolveBlockType(payloadAny),
            data: payloadAny,
          },
        });
      } else if (effectiveProposal.type === 'ui.render') {
        const payload = effectiveProposal.payload as unknown as UIRenderPayload;
        await emitter.emit('ui.rendered', {
          runtimeId: effectiveProposal.source.runtimeId,
          pluginId: effectiveProposal.source.pluginId,
          proposalId: effectiveProposal.id,
          source: effectiveProposal.source,
          render: payload,
        });
        for (const part of payload.parts) {
          await emitter.emit('ui.part.update', {
            runtimeId: effectiveProposal.source.runtimeId,
            pluginId: effectiveProposal.source.pluginId,
            proposalId: effectiveProposal.id,
            part,
          });
        }
      } else if (effectiveProposal.type === 'state.patch') {
        const p = effectiveProposal.payload as Record<string, unknown>;
        await emitter.emit('state.patch.applied', {
          runtimeId: effectiveProposal.source.runtimeId,
          pluginId: effectiveProposal.source.pluginId,
          proposalId: effectiveProposal.id,
          // packageName / summary follow spec naming; semantically these are DB table / column from the state.patch payload
          patch: {
            packageName: typeof p.table === 'string' ? p.table : undefined,
            summary: typeof p.field === 'string' ? p.field : undefined,
            ops: p,
          },
        });
      } else if (effectiveProposal.type === 'asset.generate') {
        const view = assetGenerateToView(effectiveProposal);
        await emitter.emit('asset.generated', {
          runtimeId: effectiveProposal.source.runtimeId,
          pluginId: effectiveProposal.source.pluginId,
          proposalId: effectiveProposal.id,
          asset: view,
        });
      }
    }

    // ── PostStateCommit hook — Post* cannot abort ────────────────
    if (hookPipeline && result.committed) {
      const hookCtx: HookContext = {
        event: 'PostStateCommit',
        sessionId: effectiveProposal.sessionId,
        turnId: effectiveProposal.turnId,
        // Same rationale as the PreStateCommit site above — populate the
        // runtime identity so trace rows can be cross-linked.
        pluginId: effectiveProposal.source.pluginId,
        runtimeId: effectiveProposal.source.runtimeId,
      };
      // Fire-and-forget observability; result is not modified
      await hookPipeline.run('PostStateCommit', hookCtx, { proposal: effectiveProposal, result }, { eventBus, emitter });
    }

    return result;
  }

  async function commitAll(proposals: readonly Proposal[]): Promise<CommitResult[]> {
    // Transactional commit is the default path. Operators can explicitly opt
    // out with COVEL_COMMIT_TXN_V1=0 / false while debugging or during a
    // rollback window.
    const txEnabled = isCommitTransactionEnabled();
    const supportsTx =
      typeof store.beginTx === 'function' &&
      typeof store.commitTx === 'function' &&
      typeof store.rollbackTx === 'function';

    if (!txEnabled || !supportsTx) {
      const results: CommitResult[] = [];
      for (const p of proposals) {
        results.push(await commit(p));
      }

      // Detect partial commit: some succeeded, some failed — no rollback possible.
      const committed = results.filter(r => r.committed);
      const failed = results.filter(r => !r.committed);
      if (committed.length > 0 && failed.length > 0) {
        const failureDetails = failed.map((r, i) => {
          const idx = results.indexOf(r);
          return { index: idx, type: proposals[idx].type, id: proposals[idx].id, error: r.error };
        });
        console.warn(
          '[session-kernel] commitAll: partial commit detected (non-transactional mode) — %d committed, %d failed. Failures: %s',
          committed.length,
          failed.length,
          JSON.stringify(failureDetails),
        );
      }

      return results;
    }

    await store.beginTx!();
    try {
      const results: CommitResult[] = [];
      for (const p of proposals) {
        results.push(await commit(p));
      }
      await store.commitTx!();
      return results;
    } catch (err) {
      try {
        await store.rollbackTx!();
      } catch {
        // Swallow rollback errors — surface the original failure to the caller.
      }
      throw err;
    }
  }

  // ── Commit Handlers ─────────────────────────────────────────

  async function commitNarrative(proposal: Proposal): Promise<CommitResult> {
    const { content, kind } = proposal.payload as { content: string; kind: string };
    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: kind === 'system' ? 'system' : 'assistant',
      content,
      metadata: { turnId: proposal.turnId, runtimeId: proposal.source.runtimeId, kind },
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent('narrative.completed', proposal, { content, kind, messageId: proposal.id }),
    };
  }

  async function commitInteraction(proposal: Proposal): Promise<CommitResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const block = {
      id: proposal.id,
      type: resolveBlockType(payload),
      data: payload,
      meta: { runtimeId: proposal.source.runtimeId, pluginId: proposal.source.pluginId, turnId: proposal.turnId },
    };
    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: 'assistant',
      content: '',
      metadata: { turnId: proposal.turnId, runtimeId: proposal.source.runtimeId, kind: 'plugin', block },
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent('interaction.requested', proposal, { ...payload, block }),
    };
  }

  async function commitUIRender(proposal: Proposal): Promise<CommitResult> {
    const payload = proposal.payload as unknown as UIRenderPayload;
    if (!Array.isArray(payload.parts) || payload.parts.length === 0) {
      return { committed: false, error: 'ui.render: parts must be a non-empty array' };
    }

    const block = {
      id: proposal.id,
      type: 'ui.render',
      data: payload,
      meta: { runtimeId: proposal.source.runtimeId, pluginId: proposal.source.pluginId, turnId: proposal.turnId },
    };

    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: 'assistant',
      content: '',
      metadata: { turnId: proposal.turnId, runtimeId: proposal.source.runtimeId, kind: 'plugin', block },
      createdAt: proposal.timestamp,
    });

    return {
      committed: true,
      event: makeEvent('ui.rendered', proposal, { render: payload, block }),
    };
  }

  async function commitStatePatch(proposal: Proposal): Promise<CommitResult> {
    const { table, field, value } = proposal.payload as { table: string; field: string; value: unknown };
    await store.addStateChange({
      id: proposal.id,
      sessionId: proposal.sessionId,
      tableName: table ?? 'default',
      fieldName: field ?? 'unknown',
      value,
      changedBy: `${proposal.source.pluginId}/${proposal.source.runtimeId}`,
      turnId: proposal.turnId,
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent('state.changed', proposal, proposal.payload),
    };
  }

  async function commitEvent(proposal: Proposal): Promise<CommitResult> {
    const { topic, data } = proposal.payload as { topic: string; data: Record<string, unknown> };
    await store.saveEvent({
      id: proposal.id,
      sessionId: proposal.sessionId,
      type: 'game',
      topic: topic ?? 'unknown',
      payload: data ?? {},
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent('event.emitted', proposal, proposal.payload),
    };
  }

  async function commitAssetGenerate(proposal: Proposal): Promise<CommitResult> {
    if (!isAssetGeneratePayload(proposal.payload)) {
      return { committed: false, error: 'asset.generate: payload must be { ref: MediaRef, modality: string, meta?: object }' };
    }

    const view = assetGenerateToView(proposal);
    const block = {
      id: proposal.id,
      type: 'asset.generate',
      data: view,
      meta: { runtimeId: proposal.source.runtimeId, pluginId: proposal.source.pluginId, turnId: proposal.turnId },
    };

    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: 'assistant',
      content: '',
      metadata: { turnId: proposal.turnId, runtimeId: proposal.source.runtimeId, kind: 'plugin', block },
      createdAt: proposal.timestamp,
    });

    return {
      committed: true,
      event: makeEvent('asset.generated', proposal, { asset: view, block }),
    };
  }

  async function commitPluginData(proposal: Proposal): Promise<CommitResult> {
    if (!store.setPluginData) {
      return { committed: false, error: 'plugin.data: store does not support plugin data writes' };
    }

    const payload = proposal.payload as unknown as PluginDataPayload;
    if (typeof payload.namespace !== 'string' || payload.namespace.length === 0) {
      return { committed: false, error: 'plugin.data: namespace must be a non-empty string' };
    }
    if (typeof payload.key !== 'string' || payload.key.length === 0) {
      return { committed: false, error: 'plugin.data: key must be a non-empty string' };
    }

    await store.setPluginData({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      pluginId: proposal.source.pluginId,
      namespace: payload.namespace,
      key: payload.key,
      value: payload.value,
      createdAt: proposal.timestamp,
      updatedAt: proposal.timestamp,
    });

    return { committed: true };
  }

  async function commitPluginDataBatch(proposal: Proposal): Promise<CommitResult> {
    if (!store.setPluginDataBatch) {
      return { committed: false, error: 'plugin.data.batch: store does not support plugin data writes' };
    }

    const payload = proposal.payload as unknown as PluginDataBatchPayload;
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      return { committed: false, error: 'plugin.data.batch: items must be a non-empty array' };
    }

    const records = [];
    for (const item of payload.items) {
      if (typeof item.namespace !== 'string' || item.namespace.length === 0) {
        return { committed: false, error: 'plugin.data.batch: every item needs a non-empty namespace' };
      }
      if (typeof item.key !== 'string' || item.key.length === 0) {
        return { committed: false, error: 'plugin.data.batch: every item needs a non-empty key' };
      }
      records.push({
        id: crypto.randomUUID(),
        sessionId: proposal.sessionId,
        pluginId: proposal.source.pluginId,
        namespace: item.namespace,
        key: item.key,
        value: item.value,
        createdAt: proposal.timestamp,
        updatedAt: proposal.timestamp,
      });
    }

    await store.setPluginDataBatch(records);
    return { committed: true };
  }

  async function commitWorkingMemory(proposal: Proposal): Promise<CommitResult> {
    // Feature-flag gate: reject when COVEL_WORKING_MEMORY_V1 is not enabled.
    if (!isEnvEnabled('COVEL_WORKING_MEMORY_V1')) {
      return { committed: false, error: 'working_memory disabled' };
    }

    const payload = proposal.payload as {
      scope?: unknown;
      key?: unknown;
      value?: unknown;
      schemaRef?: unknown;
    };

    const validScopes = new Set(['player', 'story', 'shared']);
    if (typeof payload.scope !== 'string' || !validScopes.has(payload.scope)) {
      return { committed: false, error: `working_memory.set: invalid scope "${String(payload.scope)}"` };
    }
    if (typeof payload.key !== 'string' || payload.key.length === 0) {
      return { committed: false, error: 'working_memory.set: key must be a non-empty string' };
    }
    if (payload.value === undefined) {
      return { committed: false, error: 'working_memory.set: value must not be undefined' };
    }
    if (payload.schemaRef !== undefined && typeof payload.schemaRef !== 'string') {
      return { committed: false, error: 'working_memory.set: schemaRef must be a string when provided' };
    }

    // TODO(S3-T3.b): resolve schemaRef against a framework-level Zod schema
    // registry (A9 refinement) and validate payload.value against the schema.
    // For now, schemaRef is accepted as an opaque string.

    if (!store.upsertWorkingMemory) {
      return { committed: false, error: 'working_memory.set: store does not support working memory' };
    }

    const scope = payload.scope as 'player' | 'story' | 'shared';
    await store.upsertWorkingMemory({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      key: payload.key,
      scope,
      value: payload.value,
      schemaRef: payload.schemaRef as string | undefined,
      updatedAt: new Date().toISOString(),
    });

    // Emit working_memory.changed session event so subscribers can react
    const wmEvent = makeEvent('working_memory.changed', proposal, {
      scope,
      key: payload.key,
    });

    return { committed: true, event: wmEvent };
  }

  async function commitLorebookUpsert(proposal: Proposal): Promise<CommitResult> {
    // The lorebook core itself is always on — only the session-scoped write
    // path is gated so plugins authored for earlier versions keep working.
    const payload = proposal.payload as { entries?: unknown };
    if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
      return { committed: false, error: 'lorebook.upsert: entries must be a non-empty array' };
    }

    if (!store.upsertLorebookEntries) {
      return { committed: false, error: 'lorebook.upsert: store does not support session lorebook entries' };
    }

    const now = new Date().toISOString();
    const records: Array<{
      id: string;
      sessionId: string;
      pluginId: string;
      keys: readonly string[];
      content: string;
      strategy: 'constant' | 'selective';
      position: string;
      insertionOrder: number;
      enabled: boolean;
      extra?: unknown;
      createdAt: string;
      updatedAt: string;
    }> = [];

    for (const raw of payload.entries) {
      const entry = raw as Record<string, unknown>;
      if (typeof entry.id !== 'string' || entry.id.length === 0) {
        return { committed: false, error: 'lorebook.upsert: each entry needs a non-empty id' };
      }
      if (typeof entry.content !== 'string') {
        return { committed: false, error: `lorebook.upsert: entry ${entry.id} missing content` };
      }
      if (entry.strategy !== 'constant' && entry.strategy !== 'selective') {
        return { committed: false, error: `lorebook.upsert: entry ${entry.id} has invalid strategy` };
      }
      const keys = Array.isArray(entry.keys)
        ? (entry.keys as unknown[]).filter((k): k is string => typeof k === 'string')
        : [];
      records.push({
        id: entry.id,
        sessionId: proposal.sessionId,
        pluginId: proposal.source.pluginId,
        keys,
        content: entry.content,
        strategy: entry.strategy,
        position: typeof entry.position === 'string' ? entry.position : 'after_char_defs',
        insertionOrder: typeof entry.insertionOrder === 'number' ? entry.insertionOrder : 100,
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
        extra: entry.extra,
        createdAt: now,
        updatedAt: now,
      });
    }

    await store.upsertLorebookEntries(records);

    return { committed: true };
  }

  return { commit, commitAll };
}

// ── High-Level API ──────────────────────────────────────────────

/**
 * Structured result from processRuntimeResult, exposing both successful
 * events and any proposals that failed to commit.
 */
export interface ProcessRuntimeResultOutput {
  /** SessionEvents from successfully committed proposals — ready to push to the client. */
  readonly events: SessionEvent[];
  /** Proposals that failed to commit. Empty when everything succeeds. */
  readonly failedProposals: ReadonlyArray<{
    readonly proposal: Proposal;
    readonly error: string;
  }>;
}

/**
 * Process a single RuntimeResult through the full Kernel pipeline:
 *   RuntimeResult → normalizeOutput → commitAll → SessionEvent[]
 *
 * This is the single entry point that actions.ts should call for each
 * runtime result. It handles: normalization, persistence, tracing,
 * and event generation.
 *
 * Returns a structured result with both successful events and failed proposals.
 * Returns empty arrays for failed/skipped runtimes.
 */
export async function processRuntimeResult(
  result: {
    pluginId: string;
    runtimeId: string;
    turnId: string;
    status: string;
    output: Record<string, unknown> | null;
    toolCalls?: ReadonlyArray<{ output?: unknown }>;
  },
  store: KernelStore,
  sessionId: string,
  outputKind?: string,
  opts?: {
    readonly hookPipeline?: HookPipeline;
    readonly eventBus?: EventBus;
    readonly emitter?: import('./turn-emitter.js').TurnEmitter;
    readonly capabilities?: readonly string[];
  },
): Promise<ProcessRuntimeResultOutput> {
  const empty: ProcessRuntimeResultOutput = { events: [], failedProposals: [] };

  // Skip failed/skipped runtimes — nothing to commit
  if (result.status !== 'success' || !result.output) {
    return empty;
  }

  const source = { pluginId: result.pluginId, runtimeId: result.runtimeId };
  const proposals = normalizeOutput(
    result.output,
    source,
    result.turnId,
    sessionId,
    outputKind,
    result.toolCalls,
  );
  proposals.push(...getPendingProposals(result.output));

  await warnOnMissingImageAsset(result, store, sessionId, proposals, opts?.capabilities);

  if (proposals.length === 0) {
    return empty;
  }

  // Thread the hook pipeline + eventBus through so PreStateCommit /
  // PostStateCommit actually run on real turn commits (previously these
  // hooks only fired in tests because callers didn't pass them).
  const pipeline = createCommitPipeline(store, opts?.hookPipeline, opts?.eventBus, opts?.emitter);
  const commitResults = await pipeline.commitAll(proposals);

  const events: SessionEvent[] = [];
  const failedProposals: Array<{ proposal: Proposal; error: string }> = [];

  for (let i = 0; i < commitResults.length; i++) {
    const cr = commitResults[i];
    if (cr.committed && cr.event) {
      events.push(cr.event);
    } else if (!cr.committed) {
      failedProposals.push({
        proposal: proposals[i],
        error: cr.error ?? 'unknown commit failure',
      });
    }
  }

  if (failedProposals.length > 0) {
    console.warn(
      '[session-kernel] processRuntimeResult: %d/%d proposals failed to commit for runtime %s (session %s, turn %s)',
      failedProposals.length,
      proposals.length,
      result.runtimeId,
      sessionId,
      result.turnId,
    );
    for (const fp of failedProposals) {
      console.warn(
        '[session-kernel]   failed proposal %s (type=%s): %s',
        fp.proposal.id,
        fp.proposal.type,
        fp.error,
      );
    }
  }

  return { events, failedProposals };
}

async function warnOnMissingImageAsset(
  result: {
    pluginId: string;
    runtimeId: string;
    turnId: string;
    status: string;
    output: Record<string, unknown> | null;
  },
  store: KernelStore,
  sessionId: string,
  proposals: readonly Proposal[],
  capabilities: readonly string[] | undefined,
): Promise<void> {
  if (!capabilities?.includes('image-generation')) return;
  if (isPendingAssetOutput(result.output)) return;

  const hasAssetGenerate = proposals.some(
    (proposal) => proposal.type === 'asset.generate' && isAssetGeneratePayload(proposal.payload),
  );
  if (hasAssetGenerate) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const key = `${now.getTime().toString(36).padStart(9, '0')}-${crypto.randomUUID().slice(0, 8)}`;
  const message = 'image.generate.asset_missing';
  const value = {
    level: 'warn',
    message,
    meta: {
      pluginId: result.pluginId,
      runtimeId: result.runtimeId,
      turnId: result.turnId,
      proposalCount: proposals.length,
    },
    turnId: result.turnId,
    runtimeId: result.runtimeId,
    timestamp: nowIso,
  };

  if (store.setPluginData) {
    try {
      await store.setPluginData({
        id: `${sessionId}:${result.pluginId}:_logs:${key}`,
        sessionId,
        pluginId: result.pluginId,
        namespace: '_logs',
        key,
        value,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      return;
    } catch {
      // Fall through to console warning so the missing asset remains visible.
    }
  }

  console.warn(
    '[session-kernel] %s for runtime %s (session %s, turn %s)',
    message,
    result.runtimeId,
    sessionId,
    result.turnId,
  );
}

function isPendingAssetOutput(output: Record<string, unknown> | null): boolean {
  const status = typeof output?.status === 'string' ? output.status.toLowerCase() : '';
  return status === 'pending'
    || status === 'queued'
    || status === 'running'
    || status === 'processing'
    || status === 'in_progress';
}

// ── Trace Recorder ──────────────────────────────────────────────

/**
 * Records structured trace events for runtime execution lifecycle.
 * All events are persisted to trace_events table for debug/audit.
 */
export interface TraceRecorder {
  turnStarted(info: { runtimeCount: number }): Promise<void>;
  turnCompleted(info: { durationMs: number; resultCount: number }): Promise<void>;
  runtimeStarted(info: { runtimeId: string; pluginId: string; priority: number | undefined }): Promise<void>;
  runtimeCompleted(info: { runtimeId: string; pluginId: string; status: string; durationMs: number }): Promise<void>;
  runtimeFailed(info: { runtimeId: string; pluginId: string; error: string }): Promise<void>;
}

export function createTraceRecorder(
  store: Pick<KernelStore, 'addTraceEvent'>,
  sessionId: string,
  turnId: string,
): TraceRecorder {
  async function record(type: string, payload: Record<string, unknown>): Promise<void> {
    await store.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId,
      type,
      traceId: turnId,
      turnId,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    turnStarted: (info) => record('turn.started', info),
    turnCompleted: (info) => record('turn.completed', info),
    runtimeStarted: (info) => record('runtime.started', info),
    runtimeCompleted: (info) => record('runtime.completed', info),
    runtimeFailed: (info) => record('runtime.failed', info),
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function makeEvent(type: string, proposal: Proposal, payload: Record<string, unknown>): SessionEvent {
  return {
    id: crypto.randomUUID(),
    type,
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    source: proposal.source,
    payload,
    timestamp: proposal.timestamp,
  };
}

function collectUiBlocks(
  output: Record<string, unknown>,
  toolCalls?: ReadonlyArray<{ output?: unknown }>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const appendUi = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const ui = (value as Record<string, unknown>).ui;
    if (!Array.isArray(ui)) return;

    for (const entry of ui) {
      if (!entry || typeof entry !== 'object') continue;
      const block = entry as Record<string, unknown>;
      const key = JSON.stringify(block);
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push(block);
    }
  };

  appendUi(output);
  for (const call of toolCalls ?? []) {
    appendUi(call.output);
  }

  return blocks;
}

function collectAssetGenerations(output: Record<string, unknown>): AssetGeneratePayload[] {
  const assets: AssetGeneratePayload[] = [];
  appendAssets(output.assets, assets);
  appendAssets(output.assetGenerations, assets);
  return assets;
}

function appendAssets(value: unknown, assets: AssetGeneratePayload[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (isAssetGeneratePayload(item)) {
      assets.push(item);
    }
  }
}

function resolveBlockType(payload: Record<string, unknown>): string {
  const type = typeof payload.type === 'string' ? payload.type : '';
  if (type === 'form') return 'interactive_form';
  if (type === 'choice') return 'interactive_choice';
  if (type === 'confirmation') return 'interactive_confirmation';
  return type || 'interactive_block';
}

function makeProposal(
  type: ProposalType,
  source: ProposalSource,
  turnId: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Proposal {
  return {
    id: crypto.randomUUID(),
    type,
    source,
    turnId,
    sessionId,
    payload,
    timestamp: new Date().toISOString(),
  };
}

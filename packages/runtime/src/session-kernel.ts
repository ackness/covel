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

import type { Proposal, ProposalSource, ProposalType, SessionEvent, CommitResult } from '@covel/shared';
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

  // narrative.append — from narrativeOutput or content (fallback)
  const narrativeText =
    (typeof output.narrativeOutput === 'string' && output.narrativeOutput) ||
    (typeof output.content === 'string' && output.content) ||
    '';

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
    proposals.push(makeProposal('interaction.request', source, turnId, sessionId, {
      interactionId:
        (typeof block.interactionId === 'string' && block.interactionId) ||
        (typeof block.id === 'string' && block.id) ||
        `ui-${index + 1}`,
      ...block,
    }));
  }

  // state.patch — from statePatches[]
  const statePatches = output.statePatches as Array<Record<string, unknown>> | undefined;
  if (statePatches && statePatches.length > 0) {
    for (const patch of statePatches) {
      proposals.push(makeProposal('state.patch', source, turnId, sessionId, patch));
    }
  }

  // phase.transition — from phase field
  if (typeof output.phase === 'string') {
    proposals.push(makeProposal('phase.transition', source, turnId, sessionId, {
      phase: output.phase,
    }));
  }

  // event.emit — from events[]
  const events = output.events as Array<Record<string, unknown>> | undefined;
  if (events && events.length > 0) {
    for (const evt of events) {
      proposals.push(makeProposal('event.emit', source, turnId, sessionId, evt));
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

export function createCommitPipeline(store: KernelStore, hookPipeline?: HookPipeline, eventBus?: EventBus): CommitPipeline {
  const handlers: Record<string, (p: Proposal) => Promise<CommitResult>> = {
    'narrative.append': commitNarrative,
    'interaction.request': commitInteraction,
    'phase.transition': commitPhaseTransition,
    'state.patch': commitStatePatch,
    'event.emit': commitEvent,
    'working_memory.set': commitWorkingMemory,
    'lorebook.upsert': commitLorebookUpsert,
  };

  async function commit(proposal: Proposal): Promise<CommitResult> {
    const handler = handlers[proposal.type];
    if (!handler) {
      return { committed: false, error: `unknown proposal type: ${proposal.type}` };
    }

    // ── PreStateCommit hook (S4-T3) ──────────────────────────────
    let effectiveProposal = proposal;
    if (process.env.COVEL_HOOKS_V1 === '1' && hookPipeline) {
      const hookCtx: HookContext = {
        event: 'PreStateCommit',
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
      };
      const preResult = await hookPipeline.run('PreStateCommit', hookCtx, { proposal }, { eventBus });
      if (preResult.action === 'abort') {
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

    // ── PostStateCommit hook (S4-T3) — Post* cannot abort ────────
    if (process.env.COVEL_HOOKS_V1 === '1' && hookPipeline && result.committed) {
      const hookCtx: HookContext = {
        event: 'PostStateCommit',
        sessionId: effectiveProposal.sessionId,
        turnId: effectiveProposal.turnId,
      };
      // Fire-and-forget observability; result is not modified
      await hookPipeline.run('PostStateCommit', hookCtx, { proposal: effectiveProposal, result }, { eventBus });
    }

    return result;
  }

  async function commitAll(proposals: readonly Proposal[]): Promise<CommitResult[]> {
    // Feature-flagged atomic path (S4-T1). When COVEL_COMMIT_TXN_V1=1 and the
    // store implements the optional tx hooks, we wrap the whole commit chain
    // in beginTx/commitTx. If any commit throws mid-chain we rollback so no
    // partial state is persisted. Default (flag off) preserves the legacy
    // non-transactional behaviour byte-for-byte.
    const txEnabled = process.env.COVEL_COMMIT_TXN_V1 === '1';
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

  async function commitPhaseTransition(proposal: Proposal): Promise<CommitResult> {
    const { phase } = proposal.payload as { phase: string };
    await store.updateSession(proposal.sessionId, { phase });
    return {
      committed: true,
      event: makeEvent('phase.changed', proposal, { phase }),
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

  async function commitWorkingMemory(proposal: Proposal): Promise<CommitResult> {
    // Feature-flag gate: reject when COVEL_WORKING_MEMORY_V1 is not enabled.
    if (process.env.COVEL_WORKING_MEMORY_V1 !== '1') {
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

  if (proposals.length === 0) {
    return empty;
  }

  const pipeline = createCommitPipeline(store);
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

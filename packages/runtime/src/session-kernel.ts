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

export function createCommitPipeline(store: KernelStore): CommitPipeline {
  const handlers: Record<string, (p: Proposal) => Promise<CommitResult>> = {
    'narrative.append': commitNarrative,
    'interaction.request': commitInteraction,
    'phase.transition': commitPhaseTransition,
    'state.patch': commitStatePatch,
    'event.emit': commitEvent,
  };

  async function commit(proposal: Proposal): Promise<CommitResult> {
    const handler = handlers[proposal.type];
    if (!handler) {
      return { committed: false, error: `unknown proposal type: ${proposal.type}` };
    }

    const result = await handler(proposal);

    // Trace every committed proposal
    if (result.committed) {
      await store.addTraceEvent({
        id: crypto.randomUUID(),
        sessionId: proposal.sessionId,
        type: 'proposal.committed',
        traceId: proposal.turnId,
        turnId: proposal.turnId,
        payload: { proposalType: proposal.type, proposalId: proposal.id, source: proposal.source },
        createdAt: new Date().toISOString(),
      });
    }

    return result;
  }

  async function commitAll(proposals: readonly Proposal[]): Promise<CommitResult[]> {
    const results: CommitResult[] = [];
    for (const p of proposals) {
      results.push(await commit(p));
    }
    return results;
  }

  // ── Commit Handlers ─────────────────────────────────────────

  async function commitNarrative(proposal: Proposal): Promise<CommitResult> {
    const { content, kind } = proposal.payload as { content: string; kind: string };
    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: 'assistant',
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
      type: payload.type === 'form' ? 'interactive_form' : 'interactive_choice',
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

  return { commit, commitAll };
}

// ── High-Level API ──────────────────────────────────────────────

/**
 * Process a single RuntimeResult through the full Kernel pipeline:
 *   RuntimeResult → normalizeOutput → commitAll → SessionEvent[]
 *
 * This is the single entry point that actions.ts should call for each
 * runtime result. It handles: normalization, persistence, tracing,
 * and event generation.
 *
 * Returns the list of SessionEvents to push to the client.
 * Returns empty array for failed/skipped runtimes.
 */
export async function processRuntimeResult(
  result: { pluginId: string; runtimeId: string; turnId: string; status: string; output: Record<string, unknown> | null },
  store: KernelStore,
  sessionId: string,
  outputKind?: string,
): Promise<SessionEvent[]> {
  // Skip failed/skipped runtimes — nothing to commit
  if (result.status !== 'success' || !result.output) {
    return [];
  }

  const source = { pluginId: result.pluginId, runtimeId: result.runtimeId };
  const proposals = normalizeOutput(result.output, source, result.turnId, sessionId, outputKind);

  if (proposals.length === 0) {
    return [];
  }

  const pipeline = createCommitPipeline(store);
  const commitResults = await pipeline.commitAll(proposals);

  return commitResults
    .filter(r => r.committed && r.event)
    .map(r => r.event!);
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

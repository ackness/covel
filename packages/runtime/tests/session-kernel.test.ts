/**
 * Session Kernel TDD — Proposal Normalizer + Commit Pipeline.
 *
 * RED phase: all tests should fail because session-kernel.ts doesn't exist yet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeOutput, createCommitPipeline, processRuntimeResult } from '../src/session-kernel.js';
import type { Proposal, SessionEvent, RuntimeResult } from '@covel/shared';

const SOURCE = { pluginId: 'test-plugin', runtimeId: 'test-runtime' };
const TURN_ID = 'turn-001';
const SESSION_ID = 'sess-001';

describe('normalizeOutput', () => {
  describe('narrative.append', () => {
    it('should extract narrativeOutput as narrative.append proposal', () => {
      const output = { narrativeOutput: 'You enter the dark forest.' };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID, 'story');

      expect(proposals).toHaveLength(1);
      expect(proposals[0].type).toBe('narrative.append');
      expect(proposals[0].source).toEqual(SOURCE);
      expect(proposals[0].turnId).toBe(TURN_ID);
      expect(proposals[0].sessionId).toBe(SESSION_ID);
      expect(proposals[0].payload).toEqual({
        content: 'You enter the dark forest.',
        kind: 'story',
      });
    });

    it('should use "plugin" as default kind when outputKind not specified', () => {
      const output = { narrativeOutput: 'System message.' };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      expect(proposals[0].payload).toEqual({
        content: 'System message.',
        kind: 'plugin',
      });
    });

    it('should fall back to content field when narrativeOutput is absent', () => {
      const output = { content: 'Fallback content.' };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID, 'story');

      expect(proposals).toHaveLength(1);
      expect(proposals[0].type).toBe('narrative.append');
      expect(proposals[0].payload).toEqual({
        content: 'Fallback content.',
        kind: 'story',
      });
    });

    it('should skip narrativeTemplate (contains placeholders, not displayable)', () => {
      const output = { narrativeTemplate: 'Hello {{name}}', narrativeOutput: '' };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const narrativeProposals = proposals.filter(p => p.type === 'narrative.append');
      expect(narrativeProposals).toHaveLength(0);
    });
  });

  describe('interaction.request', () => {
    it('should extract interactions array as separate proposals', () => {
      const output = {
        interactions: [
          { type: 'form', interactionId: 'char-creation', title: 'Create Character', fields: [], submitLabel: 'Go' },
          { type: 'choice', interactionId: 'direction', prompt: 'Where?', choices: [] },
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const interactionProposals = proposals.filter(p => p.type === 'interaction.request');
      expect(interactionProposals).toHaveLength(2);
      expect(interactionProposals[0].payload.interactionId).toBe('char-creation');
      expect(interactionProposals[0].payload.type).toBe('form');
      expect(interactionProposals[1].payload.interactionId).toBe('direction');
      expect(interactionProposals[1].payload.type).toBe('choice');
    });

    it('should handle legacy form field', () => {
      const output = {
        form: { formId: 'legacy-form', title: 'Old Form', fields: [], submitLabel: 'Submit' },
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const interactionProposals = proposals.filter(p => p.type === 'interaction.request');
      expect(interactionProposals).toHaveLength(1);
      expect(interactionProposals[0].payload.interactionId).toBe('legacy-form');
    });
  });

  describe('state.patch', () => {
    it('should extract statePatches as separate proposals', () => {
      const output = {
        statePatches: [
          { table: 'world', field: 'weather', value: 'stormy' },
          { table: 'player', field: 'hp', value: 80 },
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const stateProposals = proposals.filter(p => p.type === 'state.patch');
      expect(stateProposals).toHaveLength(2);
      expect(stateProposals[0].payload).toEqual({ table: 'world', field: 'weather', value: 'stormy' });
      expect(stateProposals[1].payload).toEqual({ table: 'player', field: 'hp', value: 80 });
    });
  });

  describe('phase.transition', () => {
    it('should extract phase field as phase.transition proposal', () => {
      const output = { phase: 'playing' };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const phaseProposals = proposals.filter(p => p.type === 'phase.transition');
      expect(phaseProposals).toHaveLength(1);
      expect(phaseProposals[0].payload).toEqual({ phase: 'playing' });
    });
  });

  describe('event.emit', () => {
    it('should extract events array as event.emit proposals', () => {
      const output = {
        events: [
          { topic: 'combat.started', data: { enemies: 3 } },
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const eventProposals = proposals.filter(p => p.type === 'event.emit');
      expect(eventProposals).toHaveLength(1);
      expect(eventProposals[0].payload).toEqual({ topic: 'combat.started', data: { enemies: 3 } });
    });
  });

  describe('mixed output', () => {
    it('should extract all proposal types from a complex output', () => {
      const output = {
        narrativeOutput: 'The story continues.',
        phase: 'playing',
        statePatches: [{ table: 'world', field: 'time', value: 'night' }],
        interactions: [{ type: 'choice', interactionId: 'action', prompt: 'What do you do?', choices: [] }],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID, 'story');

      expect(proposals).toHaveLength(4);
      expect(proposals.map(p => p.type).sort()).toEqual([
        'interaction.request',
        'narrative.append',
        'phase.transition',
        'state.patch',
      ]);
    });

    it('should generate unique ids for each proposal', () => {
      const output = {
        narrativeOutput: 'Text',
        phase: 'playing',
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const ids = proposals.map(p => p.id);
      expect(new Set(ids).size).toBe(ids.length); // all unique
    });
  });

  describe('empty output', () => {
    it('should return empty array for empty output', () => {
      const proposals = normalizeOutput({}, SOURCE, TURN_ID, SESSION_ID);
      expect(proposals).toEqual([]);
    });

    it('should return empty array for null-ish fields', () => {
      const output = { narrativeOutput: '', content: '', statePatches: [] };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);
      expect(proposals).toEqual([]);
    });
  });
});

// ── Commit Pipeline Tests ────────────────────────────────────────

describe('createCommitPipeline', () => {
  // Minimal store mock — only the methods we expect the pipeline to call
  function createMockStore() {
    return {
      addMessage: vi.fn(),
      updateSession: vi.fn(),
      saveEvent: vi.fn(),
      upsertCharacter: vi.fn(),
      setPluginData: vi.fn(),
      addTraceEvent: vi.fn(),
      addStateChange: vi.fn(),
    };
  }

  function makeProposal(
    type: string,
    payload: Record<string, unknown>,
    overrides?: Partial<Proposal>,
  ): Proposal {
    return {
      id: crypto.randomUUID(),
      type: type as Proposal['type'],
      source: SOURCE,
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      payload,
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('narrative.append commit', () => {
    it('should persist to messages table and emit narrative.completed event', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('narrative.append', { content: 'The hero advances.', kind: 'story' });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(result.event).toBeDefined();
      expect(result.event!.type).toBe('narrative.completed');
      expect(result.event!.payload.content).toBe('The hero advances.');
      expect(result.event!.payload.kind).toBe('story');

      // Verify store.addMessage was called
      expect(store.addMessage).toHaveBeenCalledOnce();
      const msgArg = store.addMessage.mock.calls[0][0];
      expect(msgArg.role).toBe('assistant');
      expect(msgArg.content).toBe('The hero advances.');
      expect(msgArg.metadata.kind).toBe('story');
      expect(msgArg.metadata.turnId).toBe(TURN_ID);
      expect(msgArg.metadata.runtimeId).toBe('test-runtime');
    });
  });

  describe('interaction.request commit', () => {
    it('should persist block to messages table and emit interaction.requested event', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('interaction.request', {
        interactionId: 'char-creation',
        type: 'form',
        title: 'Create Character',
        fields: [],
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(result.event!.type).toBe('interaction.requested');
      expect(result.event!.payload.interactionId).toBe('char-creation');

      expect(store.addMessage).toHaveBeenCalledOnce();
      const msgArg = store.addMessage.mock.calls[0][0];
      expect(msgArg.content).toBe('');
      expect(msgArg.metadata.block).toBeDefined();
    });
  });

  describe('phase.transition commit', () => {
    it('should update session phase and emit phase.changed event', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('phase.transition', { phase: 'playing' });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(result.event!.type).toBe('phase.changed');
      expect(result.event!.payload.phase).toBe('playing');

      expect(store.updateSession).toHaveBeenCalledWith(SESSION_ID, { phase: 'playing' });
    });
  });

  describe('state.patch commit', () => {
    it('should persist state change and emit state.changed event', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('state.patch', { table: 'world', field: 'weather', value: 'rain' });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(result.event!.type).toBe('state.changed');
      expect(result.event!.payload.table).toBe('world');

      expect(store.addStateChange).toHaveBeenCalledOnce();
    });
  });

  describe('event.emit commit', () => {
    it('should persist event and emit event.emitted', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('event.emit', { topic: 'quest.completed', data: { questId: 'q1' } });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(result.event!.type).toBe('event.emitted');
      expect(store.saveEvent).toHaveBeenCalledOnce();
    });
  });

  describe('trace recording', () => {
    it('should write trace event for every committed proposal', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('narrative.append', { content: 'Text.', kind: 'story' });

      await pipeline.commit(proposal);

      expect(store.addTraceEvent).toHaveBeenCalled();
      const traceArg = store.addTraceEvent.mock.calls[0][0];
      expect(traceArg.type).toBe('proposal.committed');
      expect(traceArg.sessionId).toBe(SESSION_ID);
      expect(traceArg.turnId).toBe(TURN_ID);
      expect(traceArg.payload.proposalType).toBe('narrative.append');
    });
  });

  describe('commitAll (batch)', () => {
    it('should commit all proposals in order and return all events', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposals = [
        makeProposal('narrative.append', { content: 'Story.', kind: 'story' }),
        makeProposal('phase.transition', { phase: 'playing' }),
      ];

      const results = await pipeline.commitAll(proposals);

      expect(results).toHaveLength(2);
      expect(results[0].event!.type).toBe('narrative.completed');
      expect(results[1].event!.type).toBe('phase.changed');
    });
  });

  describe('unknown proposal type', () => {
    it('should return committed: false for unknown types', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('unknown.type' as any, { foo: 'bar' });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(false);
      expect(result.error).toContain('unknown');
    });
  });
});

// ── processRuntimeResult Integration Tests ───────────────────────

describe('processRuntimeResult', () => {
  function createMockStore() {
    return {
      addMessage: vi.fn(),
      updateSession: vi.fn(),
      saveEvent: vi.fn(),
      upsertCharacter: vi.fn(),
      setPluginData: vi.fn(),
      addTraceEvent: vi.fn(),
      addStateChange: vi.fn(),
    };
  }

  function makeRuntimeResult(output: Record<string, unknown>, overrides?: Partial<RuntimeResult>): RuntimeResult {
    return {
      pluginId: 'test-plugin',
      runtimeId: 'test-runtime',
      runId: 'run-001',
      turnId: TURN_ID,
      status: 'success',
      output,
      toolCalls: [],
      durationMs: 100,
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it('should normalize, commit, and return all events for a runtime result', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({
      narrativeOutput: 'The hero enters the cave.',
      phase: 'playing',
    });

    const events = await processRuntimeResult(result, store as any, SESSION_ID, 'story');

    // narrative.append + phase.transition = 2 events
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('narrative.completed');
    expect(events[0].payload.content).toBe('The hero enters the cave.');
    expect(events[1].type).toBe('phase.changed');

    // Store should have been called: 2 addMessage(narrative) + 1 updateSession(phase) + 2 traces
    expect(store.addMessage).toHaveBeenCalledOnce();
    expect(store.updateSession).toHaveBeenCalledOnce();
    expect(store.addTraceEvent).toHaveBeenCalledTimes(2);
  });

  it('should return empty events for a failed runtime result', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({}, { status: 'failed', output: null });

    const events = await processRuntimeResult(result, store as any, SESSION_ID);

    expect(events).toHaveLength(0);
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it('should return empty events for a skipped runtime result', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({}, { status: 'skipped', output: null });

    const events = await processRuntimeResult(result, store as any, SESSION_ID);

    expect(events).toHaveLength(0);
  });

  it('should handle runtime with interactions (form block)', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({
      narrativeOutput: 'Choose your path.',
      interactions: [
        { type: 'form', interactionId: 'char-form', title: 'Character', fields: [], submitLabel: 'Go' },
      ],
    });

    const events = await processRuntimeResult(result, store as any, SESSION_ID, 'plugin');

    expect(events).toHaveLength(2);
    expect(events.map(e => e.type).sort()).toEqual(['interaction.requested', 'narrative.completed']);

    // 2 addMessage calls: one for narrative, one for block
    expect(store.addMessage).toHaveBeenCalledTimes(2);
  });

  it('should use runtimeId and pluginId from the RuntimeResult', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult(
      { narrativeOutput: 'Text.' },
      { pluginId: 'core-narrator', runtimeId: 'core-narrator' },
    );

    const events = await processRuntimeResult(result, store as any, SESSION_ID, 'story');

    expect(events[0].source).toEqual({ pluginId: 'core-narrator', runtimeId: 'core-narrator' });
    const msgArg = store.addMessage.mock.calls[0][0];
    expect(msgArg.metadata.runtimeId).toBe('core-narrator');
  });
});

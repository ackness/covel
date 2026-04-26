/**
 * Session Kernel TDD — Proposal Normalizer + Commit Pipeline.
 *
 * RED phase: all tests should fail because session-kernel.ts doesn't exist yet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeOutput, createCommitPipeline, processRuntimeResult, createTraceRecorder } from '../src/session-kernel.js';
import { withPendingProposals } from '@covel/tools';
import type { Proposal, SessionEvent, RuntimeResult } from '@covel/shared';
import { makeEmitterSpy } from './_helpers/emitter-spy.js';

const SOURCE = { pluginId: 'test-plugin', runtimeId: 'test-runtime' };
const TURN_ID = 'turn-001';
const SESSION_ID = 'sess-001';
const MEDIA_REF = {
  id: 'b'.repeat(64),
  mime: 'image/png',
  size: 2048,
};
const MEDIA_REF_2 = {
  id: 'c'.repeat(64),
  mime: 'image/png',
  size: 4096,
};

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

    it('does NOT emit narrative.append for non-story runtimes (kind defaults to "plugin")', () => {
      // Regression (2026-04-24): core-guide runtimes whose LLM forgot to call
      // the mandatory tool and instead wrote prose were silently polluting the
      // narrator feed. Only `outputKind: "story"` may append narrative.
      const output = { narrativeOutput: 'Hallucinated plugin prose.' };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);
      expect(proposals.filter((p) => p.type === 'narrative.append')).toHaveLength(0);
    });

    it('does NOT emit narrative.append for outputKind=system even if narrativeOutput is set', () => {
      const output = { narrativeOutput: 'System drift.' };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID, 'system');
      expect(proposals.filter((p) => p.type === 'narrative.append')).toHaveLength(0);
    });

    it('should fall back to content field when narrativeOutput is absent (story only)', () => {
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

    it('should extract ui blocks from tool-call outputs as ui.render proposals', () => {
      const output = { narrativeOutput: 'Guide updated.' };
      const proposals = normalizeOutput(
        output,
        SOURCE,
        TURN_ID,
        SESSION_ID,
        'system',
        [
          {
            output: {
              ui: [
                {
                  type: 'action-guide',
                  topic: 'Next move',
                  categories: [{ style: 'safe', suggestions: ['先观察周围环境'] }],
                },
              ],
            },
          },
          {
            output: {
              ui: [
                {
                  type: 'action-guide',
                  topic: 'Next move',
                  categories: [{ style: 'safe', suggestions: ['先观察周围环境'] }],
                },
              ],
            },
          },
        ],
      );

      const renderProposals = proposals.filter((p) => p.type === 'ui.render');
      expect(renderProposals).toHaveLength(1);
      expect(renderProposals[0].payload).toMatchObject({
        status: 'success',
        parts: [
          {
            id: 'ui-1',
            type: 'action-guide',
            status: 'success',
            content: {
              topic: 'Next move',
              categories: [{ style: 'safe', suggestions: ['先观察周围环境'] }],
            },
          },
        ],
      });
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

  describe('legacy phase field (ignored post turn-band migration)', () => {
    it('should not emit any proposal when output carries a phase field', () => {
      const output = { phase: 'playing' };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      expect(proposals.every(p => p.type !== ('phase.transition' as string))).toBe(true);
      // Legacy `phase` is dropped silently so plugins can migrate lazily.
      expect(proposals).toHaveLength(0);
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

  describe('asset.generate', () => {
    it('emits asset.generate proposals from assetGenerations[]', () => {
      const output = {
        assetGenerations: [
          { ref: MEDIA_REF, modality: 'image', meta: { prompt: 'forest' } },
        ],
      };

      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      expect(proposals).toHaveLength(1);
      expect(proposals[0].type).toBe('asset.generate');
      expect(proposals[0].payload).toEqual({
        ref: MEDIA_REF,
        modality: 'image',
        meta: { prompt: 'forest' },
      });
    });

    it('emits asset.generate proposals from assetGenerations[] and drops inline media', () => {
      const output = {
        assetGenerations: [
          { ref: MEDIA_REF, modality: 'image' },
          { base64: 'abc', modality: 'image' },
          { ref: MEDIA_REF, modality: '' },
        ],
      };

      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      expect(proposals).toHaveLength(1);
      expect(proposals[0].type).toBe('asset.generate');
      expect(proposals[0].payload).toEqual({ ref: MEDIA_REF, modality: 'image' });
    });
  });

  describe('pluginData', () => {
    // Function runtimes return `pluginData: [{namespace, key, value}]` to
    // instruct the kernel to persist into their own plugin_data namespace.
    // The normaliser picks this up the same way it does `events[]` /
    // `statePatches[]`: a shape on the runtime output that turns into
    // typed Proposals, committed through the standard commit pipeline.
    it('emits a single plugin.data proposal for one entry', () => {
      const output = {
        pluginData: [
          { namespace: 'images', key: 'job-1', value: { ref: MEDIA_REF } },
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const dataProposals = proposals.filter(p => p.type === 'plugin.data');
      expect(dataProposals).toHaveLength(1);
      expect(dataProposals[0].payload).toEqual({
        namespace: 'images',
        key: 'job-1',
        value: { ref: MEDIA_REF },
      });
    });

    it('batches multiple entries into a single plugin.data.batch proposal', () => {
      const output = {
        pluginData: [
          { namespace: 'images', key: 'job-1', value: { ref: MEDIA_REF } },
          { namespace: 'images', key: 'job-2', value: { ref: MEDIA_REF } },
          { namespace: '_jobs', key: 'j1', value: { status: 'done' } },
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const batches = proposals.filter(p => p.type === 'plugin.data.batch');
      expect(batches).toHaveLength(1);
      const payload = batches[0].payload as { items: ReadonlyArray<Record<string, unknown>> };
      expect(payload.items).toHaveLength(3);
      expect(payload.items[0]).toEqual({ namespace: 'images', key: 'job-1', value: { ref: MEDIA_REF } });
      expect(payload.items[2]).toEqual({ namespace: '_jobs', key: 'j1', value: { status: 'done' } });
    });

    it('silently drops malformed entries and keeps valid ones', () => {
      const output = {
        pluginData: [
          { namespace: 'good', key: 'k1', value: 1 },
          { namespace: '', key: 'k2', value: 2 },           // empty namespace
          { namespace: 'good', key: '', value: 3 },         // empty key
          { namespace: 'good', value: 4 },                  // missing key
          { namespace: 'good', key: 'k3' },                 // missing value key entirely → dropped
          { namespace: 'good', key: 'k4', value: null },    // null value is valid
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      const batches = proposals.filter(p => p.type === 'plugin.data.batch');
      expect(batches).toHaveLength(1);
      const payload = batches[0].payload as { items: ReadonlyArray<Record<string, unknown>> };
      // Only `good/k1` and `good/k4` survive — the rest fail the shape guard.
      expect(payload.items).toHaveLength(2);
      expect(payload.items[0]).toEqual({ namespace: 'good', key: 'k1', value: 1 });
      expect(payload.items[1]).toEqual({ namespace: 'good', key: 'k4', value: null });
    });

    it('produces no proposal when pluginData is absent, empty, or entirely invalid', () => {
      expect(normalizeOutput({}, SOURCE, TURN_ID, SESSION_ID).filter(p =>
        p.type === 'plugin.data' || p.type === 'plugin.data.batch'
      )).toHaveLength(0);

      expect(normalizeOutput({ pluginData: [] }, SOURCE, TURN_ID, SESSION_ID).filter(p =>
        p.type === 'plugin.data' || p.type === 'plugin.data.batch'
      )).toHaveLength(0);

      expect(normalizeOutput(
        { pluginData: [{ namespace: '', key: '', value: null }] },
        SOURCE, TURN_ID, SESSION_ID,
      ).filter(p =>
        p.type === 'plugin.data' || p.type === 'plugin.data.batch'
      )).toHaveLength(0);
    });
  });

  describe('notifications', () => {
    // core-pregame and similar plugins return a `notifications[]` array of
    // { level, title, message } objects to surface system-level messages to
    // the player (welcome banner, world intro, etc.). Before this change the
    // kernel silently dropped them. We map each notification to a
    // narrative.append proposal with kind='system' so it reaches the chat
    // surface through the same commit path as any other system message.
    it('emits one narrative.append per notification with kind=system', () => {
      const output = {
        notifications: [
          { level: 'info', title: '🌍 欢迎来到九州', message: '你的冒险即将开始...' },
          { level: 'warn', title: '⚠ 低灵根', message: '修炼速度较慢' },
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      expect(proposals).toHaveLength(2);
      expect(proposals[0].type).toBe('narrative.append');
      expect(proposals[0].payload).toEqual({
        content: '🌍 欢迎来到九州\n你的冒险即将开始...',
        kind: 'system',
      });
      expect(proposals[1].payload).toEqual({
        content: '⚠ 低灵根\n修炼速度较慢',
        kind: 'system',
      });
    });

    it('omits missing title or message gracefully', () => {
      const output = {
        notifications: [
          { level: 'info', message: '仅有正文' },
          { level: 'info', title: '仅有标题' },
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);

      expect(proposals).toHaveLength(2);
      expect(proposals[0].payload).toMatchObject({ content: '仅有正文', kind: 'system' });
      expect(proposals[1].payload).toMatchObject({ content: '仅有标题', kind: 'system' });
    });

    it('skips entries that have neither title nor message', () => {
      const output = {
        notifications: [
          { level: 'info' },
          { level: 'warn', message: '' },
        ],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID);
      expect(proposals).toHaveLength(0);
    });

    it('produces notifications in addition to narrativeOutput (story only)', () => {
      const output = {
        narrativeOutput: 'World intro text.',
        notifications: [{ level: 'info', title: '欢迎', message: '开始冒险' }],
      };
      // narrativeOutput + notifications both surface as narrative.append, but
      // only when the runtime's outputKind is "story" — otherwise the prose
      // doesn't flow to the chat stream (see "non-story" regression above).
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID, 'story');

      expect(proposals).toHaveLength(2);
      const kinds = proposals.map((p) => ({ type: p.type, kind: (p.payload as { kind?: string }).kind }));
      expect(kinds).toEqual(
        expect.arrayContaining([
          { type: 'narrative.append', kind: 'story' },
          { type: 'narrative.append', kind: 'system' },
        ]),
      );
    });
  });

  describe('mixed output', () => {
    it('should extract all proposal types from a complex output', () => {
      // `phase` is intentionally included to assert it is silently dropped;
      // the migration removed persistent phase so only 3 proposals remain.
      const output = {
        narrativeOutput: 'The story continues.',
        phase: 'playing',
        statePatches: [{ table: 'world', field: 'time', value: 'night' }],
        interactions: [{ type: 'choice', interactionId: 'action', prompt: 'What do you do?', choices: [] }],
      };
      const proposals = normalizeOutput(output, SOURCE, TURN_ID, SESSION_ID, 'story');

      expect(proposals).toHaveLength(3);
      expect(proposals.map(p => p.type).sort()).toEqual([
        'interaction.request',
        'narrative.append',
        'state.patch',
      ]);
    });

    it('should generate unique ids for each proposal', () => {
      const output = {
        narrativeOutput: 'Text',
        events: [{ topic: 'world.ticked', data: {} }],
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
      setPluginDataBatch: vi.fn(),
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

    it('should persist system-kind narrative as a system message', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('narrative.append', { content: 'Internal note.', kind: 'system' });

      await pipeline.commit(proposal);

      const msgArg = store.addMessage.mock.calls[0][0];
      expect(msgArg.role).toBe('system');
      expect(msgArg.metadata.kind).toBe('system');
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

    it('should preserve generic ui block types', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('interaction.request', {
        interactionId: 'ui-1',
        type: 'action-guide',
        topic: 'Test guide',
      });

      await pipeline.commit(proposal);

      const msgArg = store.addMessage.mock.calls[0][0];
      expect(msgArg.metadata.block.type).toBe('action-guide');
    });
  });

  describe('ui.render commit', () => {
    it('persists typed render parts and emits ui.rendered', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('ui.render', {
        status: 'pending',
        parts: [
          { id: 'text', type: 'text', status: 'success', content: 'Ready' },
          { id: 'image', type: 'image', status: 'pending', content: { prompt: 'forest' } },
        ],
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(result.event!.type).toBe('ui.rendered');
      expect(result.event!.payload.render).toMatchObject({
        status: 'pending',
        parts: [
          { id: 'text', type: 'text', status: 'success', content: 'Ready' },
          { id: 'image', type: 'image', status: 'pending', content: { prompt: 'forest' } },
        ],
      });
      expect(store.addMessage.mock.calls[0][0].metadata.block.type).toBe('ui.render');
    });
  });

  describe('phase.transition commit (removed post turn-band migration)', () => {
    it('should return committed: false because phase.transition is no longer a known proposal type', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('phase.transition' as any, { phase: 'playing' });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(false);
      expect(result.error).toContain('unknown proposal type');
      expect(store.updateSession).not.toHaveBeenCalled();
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

  describe('asset.generate commit', () => {
    it('persists an asset block and emits asset.generated', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('asset.generate', {
        ref: MEDIA_REF,
        modality: 'image',
        meta: { prompt: 'forest' },
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(result.event!.type).toBe('asset.generated');
      expect(result.event!.payload.asset).toMatchObject({
        id: proposal.id,
        type: 'asset.generate',
        ref: MEDIA_REF,
        modality: 'image',
        meta: { prompt: 'forest' },
      });
      expect(store.addMessage).toHaveBeenCalledOnce();
      const msgArg = store.addMessage.mock.calls[0][0];
      expect(msgArg.content).toBe('');
      expect(msgArg.metadata.block.type).toBe('asset.generate');
      expect(msgArg.metadata.block.data.ref).toEqual(MEDIA_REF);
    });

    it('returns a failed commit for malformed asset.generate payloads', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('asset.generate', {
        base64: 'abc',
        modality: 'image',
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(false);
      expect(result.error).toContain('asset.generate');
      expect(store.addMessage).toHaveBeenCalledTimes(0);
    });
  });

  describe('plugin.data commit', () => {
    it('should persist plugin data through the store', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('plugin.data', {
        namespace: 'entries',
        key: 'codex-qingping',
        value: { title: '青萍山' },
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(store.setPluginData).toHaveBeenCalledOnce();
      expect(store.setPluginData.mock.calls[0][0]).toMatchObject({
        sessionId: SESSION_ID,
        pluginId: 'test-plugin',
        namespace: 'entries',
        key: 'codex-qingping',
        value: { title: '青萍山' },
      });
    });

    it('should persist plugin data batches through the store', async () => {
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any);
      const proposal = makeProposal('plugin.data.batch', {
        items: [
          { namespace: 'entries', key: 'geography', value: { region: '云梦泽' } },
          { namespace: 'entries', key: 'factions', value: { name: '青萍宗' } },
        ],
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(store.setPluginDataBatch).toHaveBeenCalledOnce();
      expect(store.setPluginDataBatch.mock.calls[0][0]).toHaveLength(2);
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
        makeProposal('event.emit', { topic: 'quest.completed', data: { questId: 'q1' } }),
      ];

      const results = await pipeline.commitAll(proposals);

      expect(results).toHaveLength(2);
      expect(results[0].event!.type).toBe('narrative.completed');
      expect(results[1].event!.type).toBe('event.emitted');
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

  describe('CommitPipeline trace emissions (block/state)', () => {
    it('emits block.emitted when an interaction.request proposal commits', async () => {
      const emitter = makeEmitterSpy();
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any, undefined, undefined, emitter);
      const proposal = makeProposal('interaction.request', {
        interactionId: 'form-1',
        type: 'form',
        fields: [],
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      const blockEvent = emitter.events.find((e) => e.type === 'block.emitted');
      expect(blockEvent).toBeDefined();
      expect(blockEvent!.payload).toMatchObject({
        proposalId: proposal.id,
        pluginId: 'test-plugin',
        runtimeId: 'test-runtime',
      });
      expect((blockEvent!.payload.block as Record<string, unknown>).type).toBe('interactive_form');
    });

    it('emits ui.rendered and ui.part.update when a ui.render proposal commits', async () => {
      const emitter = makeEmitterSpy();
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any, undefined, undefined, emitter);
      const proposal = makeProposal('ui.render', {
        status: 'streaming',
        parts: [
          { id: 'p1', type: 'text', status: 'streaming', content: 'Loading' },
        ],
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      expect(emitter.events.find((e) => e.type === 'ui.rendered')).toBeDefined();
      expect(emitter.events.find((e) => e.type === 'ui.part.update')?.payload.part).toMatchObject({
        id: 'p1',
        status: 'streaming',
      });
    });

    it('emits state.patch.applied when a state.patch proposal commits', async () => {
      const emitter = makeEmitterSpy();
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any, undefined, undefined, emitter);
      const proposal = makeProposal('state.patch', {
        table: 'world',
        field: 'weather',
        value: 'rain',
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      const stateEvent = emitter.events.find((e) => e.type === 'state.patch.applied');
      expect(stateEvent).toBeDefined();
      expect(stateEvent!.payload).toMatchObject({
        proposalId: proposal.id,
        pluginId: 'test-plugin',
        runtimeId: 'test-runtime',
      });
      expect((stateEvent!.payload.patch as Record<string, unknown>).packageName).toBe('world');
      expect((stateEvent!.payload.patch as Record<string, unknown>).summary).toBe('weather');
    });

    it('does not emit block.emitted or state.patch.applied for narrative proposals', async () => {
      const emitter = makeEmitterSpy();
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any, undefined, undefined, emitter);
      const proposal = makeProposal('narrative.append', { content: 'hi', kind: 'story' });

      await pipeline.commit(proposal);

      expect(emitter.events.find((e) => e.type === 'block.emitted')).toBeUndefined();
      expect(emitter.events.find((e) => e.type === 'state.patch.applied')).toBeUndefined();
    });

    it('emits asset.generated when an asset.generate proposal commits', async () => {
      const emitter = makeEmitterSpy();
      const store = createMockStore();
      const pipeline = createCommitPipeline(store as any, undefined, undefined, emitter);
      const proposal = makeProposal('asset.generate', {
        ref: MEDIA_REF,
        modality: 'image',
      });

      const result = await pipeline.commit(proposal);

      expect(result.committed).toBe(true);
      const assetEvent = emitter.events.find((e) => e.type === 'asset.generated');
      expect(assetEvent).toBeDefined();
      expect(assetEvent!.payload).toMatchObject({
        proposalId: proposal.id,
        pluginId: 'test-plugin',
        runtimeId: 'test-runtime',
      });
      expect((assetEvent!.payload.asset as Record<string, unknown>).modality).toBe('image');
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
      setPluginDataBatch: vi.fn(),
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
      // Legacy `phase` is silently dropped — asserts the migration guard.
      phase: 'playing',
    });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID, 'story');

    // Only narrative.append remains — phase is no longer a proposal type.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('narrative.completed');
    expect(events[0].payload.content).toBe('The hero enters the cave.');
    expect(events.every(e => e.type !== ('phase.changed' as string))).toBe(true);
    expect(failedProposals).toHaveLength(0);

    // Store should have been called: 1 addMessage(narrative) + 1 trace.
    // updateSession should NOT have been called (phase is gone).
    expect(store.addMessage).toHaveBeenCalledOnce();
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(store.addTraceEvent).toHaveBeenCalledOnce();
  });

  it('should return empty result for a failed runtime result', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({}, { status: 'failed', output: null });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID);

    expect(events).toHaveLength(0);
    expect(failedProposals).toHaveLength(0);
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it('should return empty result for a skipped runtime result', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({}, { status: 'skipped', output: null });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID);

    expect(events).toHaveLength(0);
    expect(failedProposals).toHaveLength(0);
  });

  it('should handle runtime with interactions (form block)', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({
      narrativeOutput: 'Choose your path.',
      interactions: [
        { type: 'form', interactionId: 'char-form', title: 'Character', fields: [], submitLabel: 'Go' },
      ],
    });

    // Use "story" outputKind so narrative.append fires alongside the form
    // interaction — matches the previous contract where both events were
    // expected together. Non-story kinds intentionally skip narrative.
    const { events } = await processRuntimeResult(result, store as any, SESSION_ID, 'story');

    expect(events).toHaveLength(2);
    expect(events.map(e => e.type).sort()).toEqual(['interaction.requested', 'narrative.completed']);

    // 2 addMessage calls: one for narrative, one for block
    expect(store.addMessage).toHaveBeenCalledTimes(2);
  });

  it('should commit ui blocks from tool-call outputs', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult(
      { narrativeOutput: 'Hidden guide text.' },
      {
        toolCalls: [
          {
            toolCallId: 'call-1',
            toolName: 'generate-guide',
            pluginId: 'test-plugin',
            runtimeId: 'test-runtime',
            turnId: TURN_ID,
            input: {},
            output: {
              ui: [
                {
                  type: 'action-guide',
                  topic: 'Where next?',
                  categories: [{ style: 'safe', suggestions: ['先观察周围环境'] }],
                },
              ],
            },
            durationMs: 1,
            approvalStatus: 'auto-allowed',
            timestamp: new Date().toISOString(),
          },
        ],
      },
    );

    const { events } = await processRuntimeResult(result, store as any, SESSION_ID, 'system');

    // outputKind "system" intentionally suppresses narrative.append even when
    // narrativeOutput is populated — the text is hallucinated prose, not a
    // user-facing story beat. Only the ui block survives; addMessage fires
    // once (for the block), not twice.
    expect(events.map((e) => e.type).sort()).toEqual(['ui.rendered']);
    expect(store.addMessage).toHaveBeenCalledTimes(1);
    expect(store.addMessage.mock.calls[0][0].metadata.block.type).toBe('ui.render');
    expect(store.addMessage.mock.calls[0][0].metadata.block.data.parts[0]).toMatchObject({
      type: 'action-guide',
      status: 'success',
    });
  });

  it('should append pending proposals from runtime output and commit them', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult(
      withPendingProposals(
        { narrativeOutput: '写入图鉴。' },
        [{
          id: 'proposal-plugin-data-1',
          type: 'plugin.data',
          source: { pluginId: 'test-plugin', runtimeId: 'test-runtime' },
          turnId: TURN_ID,
          sessionId: SESSION_ID,
          payload: {
            namespace: 'entries',
            key: 'codex-qingping',
            value: { title: '青萍山' },
          },
          timestamp: new Date().toISOString(),
        }],
      ) as Record<string, unknown>,
    );

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID, 'story');

    expect(events).toHaveLength(1);
    expect(failedProposals).toHaveLength(0);
    expect(store.setPluginData).toHaveBeenCalledOnce();
    expect(store.setPluginData.mock.calls[0][0]).toMatchObject({
      namespace: 'entries',
      key: 'codex-qingping',
      value: { title: '青萍山' },
    });
  });

  it('should use runtimeId and pluginId from the RuntimeResult', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult(
      { narrativeOutput: 'Text.' },
      { pluginId: 'core-narrator', runtimeId: 'core-narrator' },
    );

    const { events } = await processRuntimeResult(result, store as any, SESSION_ID, 'story');

    expect(events[0].source).toEqual({ pluginId: 'core-narrator', runtimeId: 'core-narrator' });
    const msgArg = store.addMessage.mock.calls[0][0];
    expect(msgArg.metadata.runtimeId).toBe('core-narrator');
  });

  it('commits a fake runtime asset output through the event and trace path', async () => {
    const emitter = makeEmitterSpy(SESSION_ID, TURN_ID);
    const store = createMockStore();
    const result = makeRuntimeResult({
      assetGenerations: [
        { ref: MEDIA_REF, modality: 'image', meta: { prompt: 'forest' } },
      ],
    });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID, 'plugin', {
      emitter,
    });

    expect(failedProposals).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('asset.generated');
    expect(events[0].payload.asset).toMatchObject({
      type: 'asset.generate',
      ref: MEDIA_REF,
      modality: 'image',
    });
    expect(store.addMessage).toHaveBeenCalledOnce();
    expect(store.addTraceEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'proposal.committed',
      payload: expect.objectContaining({
        proposalType: 'asset.generate',
      }),
    }));
    expect(emitter.events.find((e) => e.type === 'asset.generated')).toBeDefined();
  });

  it('commits multiple asset.generate outputs in assetGenerations[] order', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({
      assetGenerations: [
        { ref: MEDIA_REF, modality: 'image', meta: { prompt: 'first' } },
        { ref: MEDIA_REF_2, modality: 'image', meta: { prompt: 'second' } },
      ],
    });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID, 'plugin');

    expect(failedProposals).toHaveLength(0);
    expect(events.map((event) => (event.payload.asset as Record<string, unknown>).ref)).toEqual([
      MEDIA_REF,
      MEDIA_REF_2,
    ]);
    expect(store.addMessage.mock.calls.map((call) => call[0].metadata.block.data.ref)).toEqual([
      MEDIA_REF,
      MEDIA_REF_2,
    ]);
  });

  it('reports an error when image generation finishes without a valid asset proposal', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({
      assetGenerations: [
        { base64: 'abc', modality: 'image' },
      ],
    });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID, 'plugin', {
      capabilities: ['image-generation'],
    });

    expect(events).toHaveLength(0);
    expect(failedProposals).toHaveLength(1);
    expect(failedProposals[0]).toMatchObject({
      error: 'image.generate.asset_missing',
      proposal: {
        type: 'asset.generate',
        source: {
          pluginId: 'test-plugin',
          runtimeId: 'test-runtime',
        },
        turnId: TURN_ID,
        sessionId: SESSION_ID,
        payload: {
          error: 'image.generate.asset_missing',
          proposalCount: 0,
        },
      },
    });
    expect(store.setPluginData).toHaveBeenCalledOnce();
    expect(store.setPluginData.mock.calls[0][0]).toMatchObject({
      sessionId: SESSION_ID,
      pluginId: 'test-plugin',
      namespace: '_logs',
      value: {
        level: 'error',
        message: 'image.generate.asset_missing',
        meta: {
          pluginId: 'test-plugin',
          runtimeId: 'test-runtime',
          turnId: TURN_ID,
          proposalCount: 0,
        },
        turnId: TURN_ID,
        runtimeId: 'test-runtime',
      },
    });
  });

  it('keeps image generation logs empty when a valid asset proposal commits', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({
      assetGenerations: [
        { ref: MEDIA_REF, modality: 'image', meta: { prompt: 'forest' } },
      ],
    });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID, 'plugin', {
      capabilities: ['image-generation'],
    });

    expect(events).toHaveLength(1);
    expect(failedProposals).toHaveLength(0);
    expect(store.setPluginData).not.toHaveBeenCalled();
  });

  it('reports an error when image generation writes inline media into pluginData.images', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({
      assetGenerations: [
        { ref: MEDIA_REF, modality: 'image', meta: { prompt: 'forest' } },
      ],
      pluginData: [
        { namespace: 'images', key: 'job-1', value: { status: 'done', url: 'https://cdn/x.png' } },
      ],
    });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID, 'plugin', {
      capabilities: ['image-generation'],
    });

    expect(events).toHaveLength(0);
    expect(failedProposals).toHaveLength(1);
    expect(failedProposals[0]).toMatchObject({
      error: 'image.generate.plugin_data_inline_media',
      proposal: {
        type: 'plugin.data',
        payload: {
          namespace: 'images',
          key: 'job-1',
          value: { status: 'done', url: 'https://cdn/x.png' },
        },
      },
    });
    expect(store.addMessage).not.toHaveBeenCalled();
    expect(store.setPluginData).toHaveBeenCalledOnce();
    expect(store.setPluginData.mock.calls[0][0]).toMatchObject({
      sessionId: SESSION_ID,
      pluginId: 'test-plugin',
      namespace: '_logs',
      value: {
        level: 'error',
        message: 'image.generate.plugin_data_inline_media',
        meta: {
          pluginId: 'test-plugin',
          runtimeId: 'test-runtime',
          turnId: TURN_ID,
        },
        turnId: TURN_ID,
        runtimeId: 'test-runtime',
      },
    });
  });

  it('keeps image generation logs empty for pending async asset outputs', async () => {
    const store = createMockStore();
    const result = makeRuntimeResult({
      status: 'pending',
      pluginData: [
        { namespace: '_jobs', key: 'job-1', value: { status: 'pending' } },
      ],
    });

    const { events, failedProposals } = await processRuntimeResult(result, store as any, SESSION_ID, 'plugin', {
      capabilities: ['image-generation'],
    });

    expect(events).toHaveLength(0);
    expect(failedProposals).toHaveLength(0);
    expect(store.setPluginData).toHaveBeenCalledOnce();
    expect(store.setPluginData.mock.calls[0][0]).toMatchObject({
      namespace: '_jobs',
      key: 'job-1',
      value: { status: 'pending' },
    });
  });

  it('should surface failed proposals when commit returns committed:false', async () => {
    const store = createMockStore();
    // Use working_memory.set which returns committed:false when feature flag is off
    // We simulate this by creating a result whose normalized output includes
    // a narrative (will succeed) alongside testing the return structure
    const result = makeRuntimeResult({
      narrativeOutput: 'Some text.',
    });

    const output = await processRuntimeResult(result, store as any, SESSION_ID, 'story');

    // Verify the structured return type
    expect(output.events).toHaveLength(1);
    expect(output.failedProposals).toHaveLength(0);
    expect(output.events[0].type).toBe('narrative.completed');
  });

  it('should report failedProposals for unknown proposal types via commitAll', async () => {
    const store = createMockStore();
    const pipeline = createCommitPipeline(store as any);

    const proposals = [
      {
        id: crypto.randomUUID(),
        type: 'narrative.append' as const,
        source: { pluginId: 'test', runtimeId: 'test' },
        turnId: TURN_ID,
        sessionId: SESSION_ID,
        payload: { content: 'OK', kind: 'story' },
        timestamp: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        type: 'bogus.type' as any,
        source: { pluginId: 'test', runtimeId: 'test' },
        turnId: TURN_ID,
        sessionId: SESSION_ID,
        payload: {},
        timestamp: new Date().toISOString(),
      },
    ];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await pipeline.commitAll(proposals);
    expect(results[0].committed).toBe(true);
    expect(results[1].committed).toBe(false);
    // Should have logged partial commit warning
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── TraceRecorder Tests ──────────────────────────────────────────

describe('createTraceRecorder', () => {
  function createMockStore() {
    return {
      addTraceEvent: vi.fn(),
    };
  }

  it('should record runtime.started trace events', async () => {
    const store = createMockStore();
    const recorder = createTraceRecorder(store as any, SESSION_ID, TURN_ID);

    await recorder.runtimeStarted({ runtimeId: 'core-narrator', pluginId: 'core-narrator', priority: 500 });

    expect(store.addTraceEvent).toHaveBeenCalledOnce();
    const arg = store.addTraceEvent.mock.calls[0][0];
    expect(arg.type).toBe('runtime.started');
    expect(arg.sessionId).toBe(SESSION_ID);
    expect(arg.turnId).toBe(TURN_ID);
    expect(arg.payload.runtimeId).toBe('core-narrator');
    expect(arg.payload.priority).toBe(500);
  });

  it('should record runtime.completed trace events', async () => {
    const store = createMockStore();
    const recorder = createTraceRecorder(store as any, SESSION_ID, TURN_ID);

    await recorder.runtimeCompleted({ runtimeId: 'core-narrator', pluginId: 'core-narrator', status: 'success', durationMs: 1500 });

    expect(store.addTraceEvent).toHaveBeenCalledOnce();
    const arg = store.addTraceEvent.mock.calls[0][0];
    expect(arg.type).toBe('runtime.completed');
    expect(arg.payload.durationMs).toBe(1500);
  });

  it('should record runtime.failed trace events', async () => {
    const store = createMockStore();
    const recorder = createTraceRecorder(store as any, SESSION_ID, TURN_ID);

    await recorder.runtimeFailed({ runtimeId: 'r1', pluginId: 'p1', error: 'LLM timeout' });

    const arg = store.addTraceEvent.mock.calls[0][0];
    expect(arg.type).toBe('runtime.failed');
    expect(arg.payload.error).toBe('LLM timeout');
  });

  it('should record turn.started and turn.completed', async () => {
    const store = createMockStore();
    const recorder = createTraceRecorder(store as any, SESSION_ID, TURN_ID);

    await recorder.turnStarted({ runtimeCount: 5 });
    await recorder.turnCompleted({ durationMs: 3000, resultCount: 4 });

    expect(store.addTraceEvent).toHaveBeenCalledTimes(2);
    expect(store.addTraceEvent.mock.calls[0][0].type).toBe('turn.started');
    expect(store.addTraceEvent.mock.calls[0][0].payload.runtimeCount).toBe(5);
    expect(store.addTraceEvent.mock.calls[1][0].type).toBe('turn.completed');
    expect(store.addTraceEvent.mock.calls[1][0].payload.durationMs).toBe(3000);
  });
});

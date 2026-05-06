import { afterEach, describe, expect, it } from 'vitest';
import {
  buildContext,
  buildContextV2,
  type ContextBuildParams,
  type MessageHistoryRecord,
  type SessionContextSnapshot,
  type TokenEstimator,
} from '@covel/context';
import {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  splitPromptCacheSegments,
} from '@covel/shared';
import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  // Default to promptVersion: 2 so the V2-path tests in this file continue to
  // route through buildContextV2 when COVEL_PROMPT_V2=1 is set. Individual
  // tests that need to verify the V1-fallback behaviour override this.
  return {
    name: 'test-rt',
    description: 'test',
    priority: 500,
    promptVersion: 2,
    ...overrides,
  };
}

function makeRuntimeResult(overrides?: Partial<RuntimeResult>): RuntimeResult {
  return {
    pluginId: 'test-plugin',
    runtimeId: 'test-rt',
    runId: 'run-1',
    turnId: 'turn-1',
    status: 'success',
    output: {},
    toolCalls: [],
    durationMs: 10,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    playerMessage: 'I step forward',
    ...overrides,
  };
}

function baselineParams(
  overrides?: Partial<ContextBuildParams>,
): ContextBuildParams {
  return {
    promptTemplate: 'You are a test narrator.',
    manifest: makeManifest(),
    turnInput: makeTurnInput(),
    completedResults: new Map(),
    config: {},
    ...overrides,
  };
}

function makeSessionContext(
  overrides?: Partial<SessionContextSnapshot>,
): SessionContextSnapshot {
  return {
    sessionId: 'sess-1',
    turnNumber: 1,
    locale: 'zh-CN',
    sessionMeta: { turnNumber: 1, characters: [] },
    world: { id: '' },
    characters: [],
    workingMemory: [],
    coreMemoryBlocks: [],
    loreEntries: [],
    summaries: [],
    legacyConfigView: {},
    contributions: [],
    ...overrides,
  };
}

// Deterministic mock estimator — ~4 chars per token.
const mockEstimator: TokenEstimator = text => Math.ceil(text.length / 4);

// Ensure env-based gating never leaks between tests.
afterEach(() => {
  delete process.env.COVEL_PROMPT_V2;
  delete process.env.COVEL_CONTEXT_BUDGET_V1;
  delete process.env.COVEL_PROMPT_CACHE_V1;
});

// ── Tests ───────────────────────────────────────────────────────

describe('prompt-assembler V2', () => {
  it('produces byte-identical output to V1 for a locale-less, inject-less baseline', () => {
    const params = baselineParams({
      promptTemplate: 'You are a narrator. Respond to {{ player.message }}.',
      turnInput: makeTurnInput({ playerMessage: 'hello world' }),
    });

    const v1 = buildContext(params);
    const v2 = buildContextV2(params);

    expect(v2.systemPrompt).toBe(v1.systemPrompt);
    expect(v2.messages).toEqual(v1.messages);
  });

  it('places the language constraint in segment 1 (framework preamble), not at the tail of segment 3', () => {
    const params = baselineParams({
      promptTemplate: 'Tell a story.',
      turnInput: makeTurnInput({ locale: 'en-US', playerMessage: 'go' }),
    });

    const v2 = buildContextV2(params);

    // Preamble appears before the plugin body.
    const localeIdx = v2.systemPrompt.indexOf('[LANGUAGE]');
    const bodyIdx = v2.systemPrompt.indexOf('Tell a story.');
    expect(localeIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(localeIdx);

    // Language name is resolved from the locale map.
    expect(v2.systemPrompt).toContain('English');

    // Confirm V1 places it at the TAIL of the prompt — structural contrast.
    const v1 = buildContext(params);
    expect(v1.systemPrompt.endsWith('in English.')).toBe(true);
  });

  it('places upstream injects in segment 5, after plugin instructions, before messages', () => {
    const params = baselineParams({
      promptTemplate: 'You are a downstream runtime.',
      manifest: makeManifest({
        input: {
          inject: [
            { from: 'upstream/rt', field: 'narrativeOutput', as: '<upstream-output>' },
          ],
        },
      }),
      completedResults: new Map([
        [
          'upstream/rt',
          makeRuntimeResult({ output: { narrativeOutput: 'the upstream story' } }),
        ],
      ]),
    });

    const v2 = buildContextV2(params);

    const bodyIdx = v2.systemPrompt.indexOf('You are a downstream runtime.');
    const injectIdx = v2.systemPrompt.indexOf('<upstream-output>the upstream story</upstream-output>');
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(injectIdx).toBeGreaterThan(bodyIdx);

    // Messages array still only contains the current user turn.
    expect(v2.messages).toEqual([{ role: 'user', content: 'I step forward' }]);
  });

  it('omits empty segments without leaving double blank lines in the output', () => {
    const params = baselineParams({
      promptTemplate: 'Line one.',
      // No locale → segment 1 empty. No injects → segment 5 empty.
      // Segments 2/4/6 are always empty for S2-T1.
    });

    const v2 = buildContextV2(params);

    // Only segment 3 has content → systemPrompt is exactly the plugin body.
    expect(v2.systemPrompt).toBe('Line one.');
    // No stray blank-line separators from skipped segments.
    expect(v2.systemPrompt).not.toMatch(/\n\n\n/);
  });

  it('uses a runtime execution cue for empty current player input', () => {
    const params = baselineParams({
      turnInput: makeTurnInput({ locale: 'zh-CN', playerMessage: '' }),
    });

    const v2 = buildContextV2(params);

    expect(v2.messages).toEqual([
      {
        role: 'user',
        content: '开始当前游戏回合，并按照系统设定直接给出游戏内结果。',
      },
    ]);
  });

  it('uses a manual runtime cue for empty manual-trigger input', () => {
    const params = baselineParams({
      turnInput: makeTurnInput({
        locale: 'zh-CN',
        playerMessage: '',
        manualTrigger: { runtimeId: 'dashscope-image-gen/prompt-generator' },
      }),
    });

    const v2 = buildContextV2(params);

    expect(v2.messages).toEqual([
      {
        role: 'user',
        content:
          '执行当前手动触发的 runtime：dashscope-image-gen/prompt-generator。严格遵循系统提示中的输出格式，产出该 runtime 的结果。',
      },
    ]);
  });

  it('prepends active persona contributions to segment 3', () => {
    const params = baselineParams({
      promptTemplate: 'Plugin body.',
      sessionContext: makeSessionContext({
        activePersona: {
          id: 'wanderer',
          name: 'Wanderer',
          description: 'A cautious outsider.',
        },
        contributions: [
          {
            kind: 'persona_description',
            sourceType: 'persona',
            sourceId: 'wanderer',
            content: '[Player Persona]\nName: Wanderer\nDescription: A cautious outsider.',
            position: 'seg3_prepend',
            order: 0,
            budgetClass: 'sticky',
          },
        ],
      }),
    });

    const v2 = buildContextV2(params);

    expect(v2.systemPrompt.indexOf('[Player Persona]')).toBeGreaterThanOrEqual(0);
    expect(v2.systemPrompt.indexOf('Plugin body.')).toBeGreaterThan(
      v2.systemPrompt.indexOf('[Player Persona]'),
    );
  });

  it('inserts at-depth persona contributions into the message stack', () => {
    const params = baselineParams({
      messageHistory: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ],
      turnInput: makeTurnInput({ playerMessage: 'current' }),
      sessionContext: makeSessionContext({
        contributions: [
          {
            kind: 'persona_description',
            sourceType: 'persona',
            sourceId: 'wanderer',
            content: '[Player Persona]\nName: Wanderer',
            position: 'at_depth',
            depth: 1,
            role: 'system',
            order: 0,
          },
        ],
      }),
    });

    const v2 = buildContextV2(params);
    const personaIdx = v2.messages.findIndex((message) =>
      message.content === '[Player Persona]\nName: Wanderer',
    );

    expect(personaIdx).toBe(3);
    expect(v2.messages[personaIdx]?.role).toBe('system');
    expect(v2.messages[v2.messages.length - 1]?.content).toBe('current');
  });

  it('renders lore_entry contributions into Prompt V2 world-info segments', () => {
    const params = baselineParams({
      promptTemplate: 'Plugin body.',
      sessionContext: makeSessionContext({
        contributions: [
          {
            kind: 'lore_entry',
            sourceType: 'world',
            sourceId: 'rain-market',
            content: '[World Rule: Rain Market]\nNo true names in the rain market.',
            position: 'before_plugin',
            order: 10,
          },
          {
            kind: 'lore_entry',
            sourceType: 'world',
            sourceId: 'sealed-door',
            content: '[World Rule: Sealed Door]\nThe sealed door answers moonlight.',
            position: 'after_plugin',
            order: 20,
          },
        ],
      }),
    });

    const v2 = buildContextV2(params);

    expect(v2.systemPrompt.indexOf('[World Rule: Rain Market]')).toBeGreaterThan(
      v2.systemPrompt.indexOf('Plugin body.'),
    );
    expect(v2.systemPrompt.indexOf('[World Rule: Sealed Door]')).toBeGreaterThan(
      v2.systemPrompt.indexOf('[World Rule: Rain Market]'),
    );
  });

  it('inserts at-depth lore_entry contributions into the message stack', () => {
    const params = baselineParams({
      messageHistory: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ],
      turnInput: makeTurnInput({ playerMessage: 'current' }),
      sessionContext: makeSessionContext({
        contributions: [
          {
            kind: 'lore_entry',
            sourceType: 'world',
            sourceId: 'sealed-door',
            content: '[World Rule: Sealed Door]\nThe sealed door answers moonlight.',
            position: 'at_depth',
            depth: 2,
            role: 'system',
            order: 0,
          },
        ],
      }),
    });

    const v2 = buildContextV2(params);
    const loreIdx = v2.messages.findIndex((message) =>
      message.content === '[World Rule: Sealed Door]\nThe sealed door answers moonlight.',
    );

    expect(loreIdx).toBe(2);
    expect(v2.messages[loreIdx]?.role).toBe('system');
  });

  it('respects the budget-pruning pass when estimator + contextBudget + COVEL_CONTEXT_BUDGET_V1=1 are provided', () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';

    // Large history that should be pruned down.
    const history: MessageHistoryRecord[] = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b'.repeat(400) },
      { role: 'user', content: 'c'.repeat(400) },
      { role: 'assistant', content: 'd'.repeat(400) },
      { role: 'user', content: 'recent-user-1' },
      { role: 'assistant', content: 'recent-asst-1' },
      { role: 'user', content: 'recent-user-2' },
    ];

    const params = baselineParams({
      promptTemplate: 'Short system.',
      messageHistory: history,
      turnInput: makeTurnInput({ playerMessage: 'final player message' }),
      estimator: mockEstimator,
      contextBudget: {
        maxInputTokens: 200,
        reservedForResponse: 50,
        protectLastUserTurns: 2,
      },
    });

    const v2 = buildContextV2(params);

    // A synthetic placeholder system message appears at index 0 after pruning.
    expect(v2.messages[0]?.role).toBe('system');
    expect(v2.messages[0]?.content).toMatch(/older messages pruned/);

    // Last protected window + current user message are preserved.
    const tail = v2.messages.slice(-3).map(m => m.content);
    expect(tail).toContain('recent-user-2');
    expect(tail[tail.length - 1]).toBe('final player message');

    // Pruning actually dropped something.
    expect(v2.messages.length).toBeLessThan(history.length + 2); // +2 = placeholder + current user
  });

  // ── Segment 9: Author's Note (S3-T4) ──────────────────────────

  describe('segment 9 — Author\'s Note', () => {
    function makeHistory(count: number): MessageHistoryRecord[] {
      const history: MessageHistoryRecord[] = [];
      for (let i = 0; i < count; i++) {
        history.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `msg-${i}`,
        });
      }
      return history;
    }

    it('inserts an author\'s note before messages[length - depth]', () => {
      // 5 history messages + 1 current user message → 6 base messages
      // default depth = 4 → insert before index 6 - 4 = 2
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: 'Director: keep it tense.' },
        }),
        messageHistory: makeHistory(5),
        turnInput: makeTurnInput({ playerMessage: 'current' }),
      });

      const v2 = buildContextV2(params);

      // Find the note
      const noteIdx = v2.messages.findIndex(m => m.content === 'Director: keep it tense.');
      expect(noteIdx).toBe(2); // inserted at len(6) - depth(4) = 2

      // Role defaults to system
      expect(v2.messages[noteIdx]?.role).toBe('system');

      // Messages before the note are the first two history entries
      expect(v2.messages[0]?.content).toBe('msg-0');
      expect(v2.messages[1]?.content).toBe('msg-1');
      // Messages after the note continue the history
      expect(v2.messages[3]?.content).toBe('msg-2');
      // Final message is the current user turn
      expect(v2.messages[v2.messages.length - 1]?.content).toBe('current');
    });

    it('respects custom depth', () => {
      // 3 history + 1 current = 4 base messages; depth=1 → insert before len-1 = 3
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: 'short-note', depth: 1 },
        }),
        messageHistory: makeHistory(3),
        turnInput: makeTurnInput({ playerMessage: 'current' }),
      });

      const v2 = buildContextV2(params);
      const noteIdx = v2.messages.findIndex(m => m.content === 'short-note');
      expect(noteIdx).toBe(3); // 4 - 1 = 3, right before the current user turn
      expect(v2.messages[v2.messages.length - 1]?.content).toBe('current');
    });

    it('uses declared role override', () => {
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: 'as-user', role: 'user' },
        }),
        messageHistory: makeHistory(5),
      });

      const v2 = buildContextV2(params);
      const note = v2.messages.find(m => m.content === 'as-user');
      expect(note?.role).toBe('user');
    });

    it('merges multiple plugins author notes in priority order', () => {
      const lowPriority: RuntimeManifest = {
        name: 'plug-low',
        description: 'low',
        priority: 100,
        authorsNote: { content: 'LOW priority note' },
      };
      const highPriority: RuntimeManifest = {
        name: 'plug-high',
        description: 'high',
        priority: 800,
        authorsNote: { content: 'HIGH priority note' },
      };

      const params = baselineParams({
        manifest: lowPriority, // fallback manifest — unused when activeManifests set
        activeManifests: [highPriority, lowPriority], // deliberate reverse order
        messageHistory: makeHistory(5),
      });

      const v2 = buildContextV2(params);
      // Both declarations share (system, depth=4) so they merge into a single
      // message with lowPriority's content first (priority 100 < 800).
      const merged = v2.messages.find(m =>
        m.role === 'system' && m.content.includes('LOW priority note'),
      );
      expect(merged).toBeDefined();
      expect(merged?.content).toBe('LOW priority note\n\nHIGH priority note');
    });

    it('produces separate messages when notes have different (role, depth) combos', () => {
      const a: RuntimeManifest = {
        name: 'a',
        description: 'a',
        priority: 100,
        authorsNote: { content: 'note-a', depth: 4, role: 'system' },
      };
      const b: RuntimeManifest = {
        name: 'b',
        description: 'b',
        priority: 200,
        authorsNote: { content: 'note-b', depth: 2, role: 'system' },
      };

      const params = baselineParams({
        manifest: a,
        activeManifests: [a, b],
        messageHistory: makeHistory(5),
      });

      const v2 = buildContextV2(params);
      const idxA = v2.messages.findIndex(m => m.content === 'note-a');
      const idxB = v2.messages.findIndex(m => m.content === 'note-b');
      // 6 base messages, note-a inserted at 6-4=2, note-b at 6-2=4 → plus the
      // earlier insertion shifts later indices; but since insertion order is
      // high-depth-first, ordering is independent. Just assert both present.
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxB).toBeGreaterThanOrEqual(0);
      expect(idxA).not.toBe(idxB);
    });

    it('skips empty segment when no manifest declares authorsNote', () => {
      const params = baselineParams({
        messageHistory: makeHistory(3),
      });

      const v2 = buildContextV2(params);
      // No note should be inserted → messages are exactly history + current turn
      expect(v2.messages.map(m => m.content)).toEqual([
        'msg-0', 'msg-1', 'msg-2', 'I step forward',
      ]);
    });

    it('interpolates template variables in authorsNote.content', () => {
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: {
            content: 'Focus on player message: {{ player.message }}',
          },
        }),
        turnInput: makeTurnInput({ playerMessage: 'go east' }),
        messageHistory: makeHistory(5),
      });

      const v2 = buildContextV2(params);
      const note = v2.messages.find(m => m.content.startsWith('Focus on'));
      expect(note?.content).toBe('Focus on player message: go east');
    });

    it('appends note at end when depth >= messages.length is clamped appropriately', () => {
      // depth=0 behaves like "append"
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: 'appended', depth: 0 },
        }),
        messageHistory: makeHistory(2),
        turnInput: makeTurnInput({ playerMessage: 'current' }),
      });

      const v2 = buildContextV2(params);
      expect(v2.messages[v2.messages.length - 1]?.content).toBe('appended');
    });
  });

  // ── Segment 10: Post-History Instructions (S3-T4) ──────────────

  describe('segment 10 — Post-History Instructions', () => {
    it('appends post-history instruction as the final message', () => {
      const params = baselineParams({
        manifest: makeManifest({
          postHistory: { content: 'Respond in markdown only.' },
        }),
        messageHistory: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      });

      const v2 = buildContextV2(params);
      const last = v2.messages[v2.messages.length - 1];
      expect(last?.content).toBe('Respond in markdown only.');
      expect(last?.role).toBe('system');
    });

    it('merges multiple plugins post-history into one message per role', () => {
      const a: RuntimeManifest = {
        name: 'a',
        description: 'a',
        priority: 100,
        postHistory: { content: 'Rule A' },
      };
      const b: RuntimeManifest = {
        name: 'b',
        description: 'b',
        priority: 200,
        postHistory: { content: 'Rule B' },
      };

      const params = baselineParams({
        manifest: a,
        activeManifests: [b, a], // out of order on purpose
        messageHistory: [{ role: 'user', content: 'hi' }],
      });

      const v2 = buildContextV2(params);
      const last = v2.messages[v2.messages.length - 1];
      expect(last?.role).toBe('system');
      // sorted by priority: a (100) before b (200)
      expect(last?.content).toBe('Rule A\n\nRule B');
    });

    it('places post-history after author\'s notes', () => {
      const m: RuntimeManifest = {
        name: 'x',
        description: 'x',
        priority: 100,
        authorsNote: { content: 'author-note' },
        postHistory: { content: 'post-rule' },
      };

      const params = baselineParams({
        manifest: m,
        messageHistory: [
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'u2' },
          { role: 'assistant', content: 'a2' },
        ],
        turnInput: makeTurnInput({ playerMessage: 'current' }),
      });

      const v2 = buildContextV2(params);
      const authorIdx = v2.messages.findIndex(m => m.content === 'author-note');
      const postIdx = v2.messages.findIndex(m => m.content === 'post-rule');
      expect(authorIdx).toBeGreaterThanOrEqual(0);
      expect(postIdx).toBeGreaterThan(authorIdx);
      // post-history is strictly the final entry
      expect(postIdx).toBe(v2.messages.length - 1);
    });

    it('skips empty segment when no manifest declares postHistory', () => {
      const params = baselineParams({
        messageHistory: [
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
        ],
        turnInput: makeTurnInput({ playerMessage: 'current' }),
      });

      const v2 = buildContextV2(params);
      expect(v2.messages.map(m => m.content)).toEqual(['u1', 'a1', 'current']);
    });

    it('interpolates template variables in postHistory.content', () => {
      const params = baselineParams({
        manifest: makeManifest({
          postHistory: { content: 'Reply to: {{ player.message }}' },
        }),
        turnInput: makeTurnInput({ playerMessage: 'the dungeon' }),
      });

      const v2 = buildContextV2(params);
      const last = v2.messages[v2.messages.length - 1];
      expect(last?.content).toBe('Reply to: the dungeon');
    });
  });

  describe('V1 path does not render segment 9 or 10', () => {
    it('V1 ignores authorsNote and postHistory declarations', () => {
      const params = baselineParams({
        manifest: makeManifest({
          authorsNote: { content: 'director' },
          postHistory: { content: 'post-rule' },
        }),
        messageHistory: [
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
        ],
        turnInput: makeTurnInput({ playerMessage: 'current' }),
      });

      // Explicitly V1 (no COVEL_PROMPT_V2 flag)
      const v1 = buildContext(params);
      // Messages should be only history + current turn — no injected notes.
      expect(v1.messages.map(m => m.content)).toEqual(['u1', 'a1', 'current']);
      // And no note text leaked into systemPrompt either.
      expect(v1.systemPrompt).not.toContain('director');
      expect(v1.systemPrompt).not.toContain('post-rule');
    });
  });

  it('is correctly gated by COVEL_PROMPT_V2 + manifest.promptVersion (S2-T4 double-gate)', () => {
    // V1 and V2 produce structurally different prompts when locale is set:
    // V1 appends locale at the tail, V2 prepends it in segment 1.
    const baseTurn = makeTurnInput({ locale: 'zh-CN', playerMessage: 'go' });
    const v2Params = baselineParams({
      promptTemplate: 'Plugin body.',
      manifest: makeManifest({ promptVersion: 2 }),
      turnInput: baseTurn,
    });
    const v1ManifestParams = baselineParams({
      promptTemplate: 'Plugin body.',
      manifest: makeManifest({ promptVersion: 1 }),
      turnInput: baseTurn,
    });
    const unversionedParams = baselineParams({
      promptTemplate: 'Plugin body.',
      manifest: makeManifest({ promptVersion: undefined }),
      turnInput: baseTurn,
    });

    // No env flag → always V1 regardless of manifest opt-in.
    const v1NoFlag = buildContext({ ...v2Params });
    expect(v1NoFlag.systemPrompt.startsWith('Plugin body.')).toBe(true);
    expect(v1NoFlag.systemPrompt.endsWith('in 中文.')).toBe(true);

    // Env flag + manifest.promptVersion === 2 → V2 path.
    process.env.COVEL_PROMPT_V2 = '1';
    const v2Gated = buildContext({ ...v2Params });
    expect(v2Gated.systemPrompt.startsWith('[RUNTIME]')).toBe(true);
    expect(v2Gated.systemPrompt).toContain('[LANGUAGE]');
    expect(v2Gated.systemPrompt).toContain('Plugin body.');

    // Env flag ON but manifest declares promptVersion: 1 → still V1.
    const v1Explicit = buildContext({ ...v1ManifestParams });
    expect(v1Explicit.systemPrompt.startsWith('Plugin body.')).toBe(true);
    expect(v1Explicit.systemPrompt.endsWith('in 中文.')).toBe(true);

    // Env flag ON but manifest omits promptVersion → still V1 (default = V1).
    const v1Unversioned = buildContext({ ...unversionedParams });
    expect(v1Unversioned.systemPrompt.startsWith('Plugin body.')).toBe(true);
    expect(v1Unversioned.systemPrompt.endsWith('in 中文.')).toBe(true);

    // Any env value other than exact "1" → still V1 (strict equality).
    process.env.COVEL_PROMPT_V2 = 'true';
    const v1Truey = buildContext({ ...v2Params });
    expect(v1Truey.systemPrompt).toBe(v1NoFlag.systemPrompt);

    process.env.COVEL_PROMPT_V2 = '0';
    const v1Zero = buildContext({ ...v2Params });
    expect(v1Zero.systemPrompt).toBe(v1NoFlag.systemPrompt);
  });
});

// ── S2-T3: Prompt cache breakpoint markers ──────────────────────

describe('prompt-assembler V2 — cache breakpoints (S2-T3)', () => {
  afterEach(() => {
    delete process.env.COVEL_PROMPT_CACHE_V1;
  });

  it('emits no cache markers when COVEL_PROMPT_CACHE_V1 is unset', () => {
    const params = baselineParams({
      promptTemplate: 'Plugin body.',
      turnInput: makeTurnInput({ locale: 'en-US' }),
    });

    const result = buildContextV2(params);

    expect(result.systemPrompt).not.toContain(PROMPT_CACHE_BREAKPOINT_MARKER);
    expect(splitPromptCacheSegments(result.systemPrompt)).toHaveLength(1);
  });

  it('emits markers after segment 1 and segment 3 when the flag is set', () => {
    process.env.COVEL_PROMPT_CACHE_V1 = '1';
    const params = baselineParams({
      promptTemplate: 'Plugin body.',
      turnInput: makeTurnInput({ locale: 'en-US' }),
    });

    const result = buildContextV2(params);

    const segments = splitPromptCacheSegments(result.systemPrompt);
    // Two non-empty cacheable breakpoints in this baseline: segment 1
    // (framework preamble) and segment 3 (plugin instructions). Segment 6
    // (worldInfoAfterPlugin) is empty and therefore produces no marker.
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain('[LANGUAGE]');
    expect(segments[1]).toContain('Plugin body.');
  });

  it('skips the working-memory segment — it must not anchor a breakpoint', () => {
    process.env.COVEL_PROMPT_CACHE_V1 = '1';
    process.env.COVEL_WORKING_MEMORY_V1 = '1';
    try {
      const params = baselineParams({
        promptTemplate: 'Plugin body.',
        turnInput: makeTurnInput({ locale: 'en-US' }),
        workingMemory: [
          { scope: 'player', key: 'goal', value: 'find the artifact' },
        ],
      });

      const result = buildContextV2(params);
      const segments = splitPromptCacheSegments(result.systemPrompt);

      // Per §A15: framework preamble opens its own cache span; working
      // memory deliberately sits OUTSIDE the cache boundary and rides
      // along with plugin instructions in the next segment.
      const frameworkSegment = segments[0];
      expect(frameworkSegment).toContain('[LANGUAGE]');
      expect(frameworkSegment).not.toContain('goal');

      const pluginSegment = segments[1];
      expect(pluginSegment).toContain('goal');
      expect(pluginSegment).toContain('Plugin body.');
    } finally {
      delete process.env.COVEL_WORKING_MEMORY_V1;
    }
  });

  it('does not emit markers for empty optional segments', () => {
    process.env.COVEL_PROMPT_CACHE_V1 = '1';
    // No locale → segment 1 empty; no upstream inject → segment 5 empty.
    const params = baselineParams({
      promptTemplate: 'Plugin body.',
      turnInput: makeTurnInput(), // no locale
    });

    const result = buildContextV2(params);
    const segments = splitPromptCacheSegments(result.systemPrompt);

    // Only segment 3 survives → single breakpoint only.
    expect(segments).toHaveLength(1);
    expect(segments[0]).toContain('Plugin body.');
  });

  it('never places a breakpoint on the history (messages stay unchanged)', () => {
    process.env.COVEL_PROMPT_CACHE_V1 = '1';
    const params = baselineParams({
      promptTemplate: 'Plugin body.',
      turnInput: makeTurnInput({ locale: 'en-US', playerMessage: 'go north' }),
      messageHistory: [
        { role: 'user', content: 'prior 1' },
        { role: 'assistant', content: 'prior 2' },
      ] satisfies readonly MessageHistoryRecord[],
    });

    const result = buildContextV2(params);

    for (const msg of result.messages) {
      expect(msg.content).not.toContain(PROMPT_CACHE_BREAKPOINT_MARKER);
    }
  });

  it('is strictly gated: only the literal string "1" enables cache markers', () => {
    const params = baselineParams({
      promptTemplate: 'Plugin body.',
      turnInput: makeTurnInput({ locale: 'en-US' }),
    });

    process.env.COVEL_PROMPT_CACHE_V1 = 'true';
    const truthy = buildContextV2(params);
    expect(truthy.systemPrompt).not.toContain(PROMPT_CACHE_BREAKPOINT_MARKER);

    process.env.COVEL_PROMPT_CACHE_V1 = '0';
    const zero = buildContextV2(params);
    expect(zero.systemPrompt).not.toContain(PROMPT_CACHE_BREAKPOINT_MARKER);

    process.env.COVEL_PROMPT_CACHE_V1 = '1';
    const enabled = buildContextV2(params);
    expect(enabled.systemPrompt).toContain(PROMPT_CACHE_BREAKPOINT_MARKER);
  });
});

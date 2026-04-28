/**
 * Sprint 1-C — `assemblePromptVariables` dual-channel parity tests.
 *
 * Verifies the legacy channel (params.config / params.sessionMeta) and the
 * snapshot channel (params.sessionContext.legacyConfigView /
 * params.sessionContext.sessionMeta) produce byte-identical variable objects.
 * The snapshot must win when present — even if the legacy fields are still set.
 *
 * `assemblePromptVariables` is `@internal` and not re-exported from the
 * package barrel, so this suite reaches in via a relative path.
 */

import { describe, it, expect } from 'vitest';
import { assemblePromptVariables } from '../src/prompt-internals.js';
import type {
  ContextBuildParams,
  SessionContextSnapshot,
  SessionMeta,
} from '../src/types.js';
import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return { name: 'test-rt', description: 'test', priority: 500, ...overrides };
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
    durationMs: 100,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    playerMessage: 'look around',
    ...overrides,
  };
}

/**
 * Build a `SessionContextSnapshot` with sensible defaults so each test only
 * specifies the fields it actually asserts against. Mirrors the helper style
 * used by `context-builder.test.ts`.
 */
function makeSnapshot(
  overrides?: Partial<SessionContextSnapshot>,
): SessionContextSnapshot {
  return {
    sessionId: 'sess-1',
    turnNumber: 0,
    locale: 'zh-CN',
    sessionMeta: { turnNumber: 0, characters: [] },
    world: { id: 'w1' },
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

// ── Tests ───────────────────────────────────────────────────────

describe('assemblePromptVariables — dual-channel', () => {
  // Test 1: No sessionContext → legacy path (baseline).
  it('uses legacy fields when sessionContext is absent', () => {
    const sessionMeta: SessionMeta = {
      turnNumber: 3,
      characters: [],
      lastFormValues: undefined,
    };
    const params: ContextBuildParams = {
      promptTemplate: '',
      manifest: makeManifest(),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      config: { worldLore: 'x', worldTone: 'noir' },
      sessionMeta,
    };

    const vars = assemblePromptVariables(params);

    expect(vars.inputs).toEqual({});
    expect(vars.config).toEqual({ worldLore: 'x', worldTone: 'noir' });
    expect(vars.worldLore).toBe('x');
    expect(vars.worldTone).toBe('noir');
    expect(vars.world).toEqual({ lore: 'x', tone: 'noir' });
    expect(vars.session).toEqual({
      id: 'sess-1',
      turnNumber: 3,
      phase: 'playing',
    });
    expect((vars.player as Record<string, unknown>).message).toBe('look around');
    expect((vars.player as Record<string, unknown>).character).toBeNull();
  });

  // Test 2: With sessionContext → snapshot path matches legacy path exactly.
  it('produces deep-equal output when snapshot mirrors legacy fields', () => {
    const legacySessionMeta: SessionMeta = {
      turnNumber: 3,
      characters: [],
      lastFormValues: undefined,
    };
    const legacyConfig = { worldLore: 'x', worldTone: 'noir' };

    const legacyParams: ContextBuildParams = {
      promptTemplate: '',
      manifest: makeManifest(),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      config: legacyConfig,
      sessionMeta: legacySessionMeta,
    };

    const snapshotParams: ContextBuildParams = {
      promptTemplate: '',
      manifest: makeManifest(),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      // Legacy fields are ALSO set — snapshot must win.
      config: legacyConfig,
      sessionMeta: legacySessionMeta,
      sessionContext: makeSnapshot({
        turnNumber: 3,
        sessionMeta: legacySessionMeta,
        legacyConfigView: legacyConfig,
      }),
    };

    const legacyVars = assemblePromptVariables(legacyParams);
    const snapshotVars = assemblePromptVariables(snapshotParams);

    expect(snapshotVars).toEqual(legacyVars);
  });

  // Test 3: When both channels carry different data, the snapshot wins.
  it('snapshot overrides legacy fields when they diverge', () => {
    const params: ContextBuildParams = {
      promptTemplate: '',
      manifest: makeManifest(),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      config: { worldLore: 'LEGACY' },
      sessionMeta: { turnNumber: 1, characters: [] },
      sessionContext: makeSnapshot({
        turnNumber: 99,
        sessionMeta: { turnNumber: 99, characters: [] },
        legacyConfigView: { worldLore: 'SNAPSHOT' },
      }),
    };

    const vars = assemblePromptVariables(params);

    expect(vars.worldLore).toBe('SNAPSHOT');
    expect((vars.world as Record<string, unknown>).lore).toBe('SNAPSHOT');
    expect((vars.session as Record<string, unknown>).turnNumber).toBe(99);
    expect((vars.session as Record<string, unknown>).phase).toBe('playing');
  });

  // Test 4: An empty snapshot still wins and blanks out derived keys — it
  // does NOT fall back to legacy.
  it('empty snapshot does not fall back to legacy fields', () => {
    const params: ContextBuildParams = {
      promptTemplate: '',
      manifest: makeManifest(),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      config: { worldLore: 'legacy-value' },
      sessionMeta: { turnNumber: 7, characters: [] },
      sessionContext: makeSnapshot({
        turnNumber: 0,
        sessionMeta: { turnNumber: 0, characters: [] },
        legacyConfigView: {},
      }),
    };

    const vars = assemblePromptVariables(params);

    // No world* keys were spread because legacyConfigView is empty.
    expect('worldLore' in vars).toBe(false);
    expect(vars.world).toEqual({});
    expect(vars.config).toEqual({});
    // Snapshot's turnNumber=0 wins over legacy's 7.
    expect((vars.session as Record<string, unknown>).turnNumber).toBe(0);
    // turnNumber=0 → phase 'pre-game'.
    expect((vars.session as Record<string, unknown>).phase).toBe('pre-game');
  });

  // userSettings exposure — audit F1.
  it('exposes userSettings as a top-level variable when the manifest provides a resolved bucket', () => {
    const params: ContextBuildParams = {
      promptTemplate: '',
      manifest: makeManifest(),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      config: {},
      sessionMeta: { turnNumber: 0, characters: [] },
      userSettings: { promptMode: 'image-json', modelPresetId: 'image' },
    };

    const vars = assemblePromptVariables(params);

    expect(vars.userSettings).toEqual({
      promptMode: 'image-json',
      modelPresetId: 'image',
    });
  });

  it('defaults userSettings to an empty object when no bucket is supplied', () => {
    const params: ContextBuildParams = {
      promptTemplate: '',
      manifest: makeManifest(),
      turnInput: makeTurnInput(),
      completedResults: new Map(),
      config: {},
      sessionMeta: { turnNumber: 0, characters: [] },
    };

    const vars = assemblePromptVariables(params);

    expect(vars.userSettings).toEqual({});
  });

  // Test 5: Parity sweep across a richer config + session shape.
  it('parity holds for a rich config + session shape (multi-field sweep)', () => {
    const richConfig: Readonly<Record<string, unknown>> = {
      worldLore: 'ancient ruins',
      worldTone: 'melancholic',
      worldDimensions: { tone: 'noir', era: 'post-collapse' },
      worldEntries: [
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' },
      ],
      outputLength: 150,
    };
    const richSessionMeta: SessionMeta = {
      turnNumber: 5,
      characters: [
        { name: 'Hero', type: 'player', description: 'the wanderer' },
        { name: 'Oracle', type: 'npc' },
      ],
      lastFormValues: {
        nested: { key: 'deep', count: 2 },
        topLevel: 'surface',
      },
    };

    const legacyParams: ContextBuildParams = {
      promptTemplate: '',
      manifest: makeManifest(),
      turnInput: makeTurnInput({ playerMessage: 'enter the cave' }),
      completedResults: new Map([
        [
          'narrator',
          makeRuntimeResult({
            pluginId: 'narrator',
            runtimeId: 'narrator',
            output: { narrativeOutput: 'the story unfolds' },
          }),
        ],
        [
          'world-init/schema-gen',
          makeRuntimeResult({
            pluginId: 'world-init',
            runtimeId: 'schema-gen',
            output: { schema: { version: 1 } },
          }),
        ],
      ]),
      config: richConfig,
      sessionMeta: richSessionMeta,
    };

    const snapshotParams: ContextBuildParams = {
      ...legacyParams,
      // Legacy fields remain — snapshot should win.
      sessionContext: makeSnapshot({
        turnNumber: 5,
        sessionMeta: richSessionMeta,
        legacyConfigView: richConfig,
      }),
    };

    const legacyVars = assemblePromptVariables(legacyParams);
    const snapshotVars = assemblePromptVariables(snapshotParams);

    expect(snapshotVars).toEqual(legacyVars);

    // Sanity: the produced shape actually reflects the rich data — not an
    // accidentally empty deep-equal on two equally-broken outputs.
    expect(snapshotVars.worldLore).toBe('ancient ruins');
    expect((snapshotVars.world as Record<string, unknown>).dimensions).toEqual({
      tone: 'noir',
      era: 'post-collapse',
    });
    expect(snapshotVars.outputLength).toBe(150);
    expect((snapshotVars.session as Record<string, unknown>).turnNumber).toBe(5);
    expect((snapshotVars.player as Record<string, unknown>).character).toEqual({
      name: 'Hero',
      type: 'player',
      description: 'the wanderer',
    });
    expect(
      (snapshotVars.inputs as Record<string, Record<string, unknown>>)[
        'narrator'
      ],
    ).toEqual({ 'narrator': { narrativeOutput: 'the story unfolds' } });
    expect(
      (snapshotVars.inputs as Record<string, Record<string, unknown>>)[
        'world-init'
      ],
    ).toEqual({ 'schema-gen': { schema: { version: 1 } } });
  });
});

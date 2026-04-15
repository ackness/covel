/**
 * V1/V2 prompt-assembler parity test for `core-guide` (S2-T4).
 *
 * Verifies that after migrating core-guide to `promptVersion: 2`, the V2
 * assembler produces semantically equivalent prompts to V1 for the same
 * `TurnInput` + completed results from core-narrator.
 *
 * Unlike core-narrator, core-guide consumes an inject from an upstream
 * runtime (`core-narrator`). Both paths must surface that inject verbatim
 * inside the `<narrator-output>` tag.
 *
 * Semantic equivalence is asserted after normalizing the [LANGUAGE]
 * constraint position (V1 tail vs V2 head) and collapsing whitespace.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContext, type ContextBuildParams } from '@covel/context';
import { parsePluginMd } from '@covel/plugin-loader';
import type { RuntimeResult, TurnInput } from '@covel/shared';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_MD_PATH = resolve(__dirname, '..', 'PLUGIN.md');

// ── Fixture loading ──────────────────────────────────────────────

function loadGuidePlugin() {
  const content = readFileSync(PLUGIN_MD_PATH, 'utf-8');
  return parsePluginMd(content, PLUGIN_MD_PATH);
}

// ── Fixture builders ─────────────────────────────────────────────

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-parity',
    turnId: 'turn-7',
    playerMessage: 'I push open the heavy oak door.',
    locale: 'zh-CN',
    ...overrides,
  };
}

const NARRATOR_OUTPUT_TEXT =
  'The oak door groans open, revealing a lamplit corridor. A hooded figure turns toward you, one hand drifting toward a hidden blade.';

function makeNarratorResult(): RuntimeResult {
  return {
    pluginId: 'core-narrator',
    runtimeId: 'core-narrator',
    runId: 'run-1',
    turnId: 'turn-7',
    status: 'success',
    output: {
      narrativeOutput: NARRATOR_OUTPUT_TEXT,
    },
    toolCalls: [],
    durationMs: 120,
    timestamp: '2026-04-13T00:00:00.000Z',
  };
}

function makeBaseParams(
  promptTemplate: string,
  manifest: ContextBuildParams['manifest'],
): ContextBuildParams {
  return {
    promptTemplate,
    manifest,
    turnInput: makeTurnInput(),
    completedResults: new Map([['core-narrator', makeNarratorResult()]]),
    config: {},
    messageHistory: [
      { role: 'user', content: 'I leave the inn.' },
      { role: 'assistant', content: 'The mist wraps around your boots as you step outside.' },
    ],
    sessionMeta: {
      turnNumber: 7,
      phase: 'playing',
      characters: [
        {
          name: 'Aria',
          type: 'player',
        },
      ],
    },
  };
}

// ── Normalize helper ─────────────────────────────────────────────

function normalizeSystemPrompt(prompt: string): string {
  return prompt
    .replace(/\[RUNTIME\][^\n]*\n?/g, '')
    .replace(/\[LANGUAGE\][^\n]*\.?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

// ── Tests ────────────────────────────────────────────────────────

afterEach(() => {
  delete process.env.COVEL_PROMPT_V2;
});

describe('core-guide V1/V2 prompt parity', () => {
  it('manifest declares promptVersion: 2', () => {
    const parsed = loadGuidePlugin();
    expect(parsed.manifest.promptVersion).toBe(2);
  });

  it('V2 path routes through three-tier assembler when env flag is set', () => {
    const parsed = loadGuidePlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    expect(v1.systemPrompt).toMatch(/in 中文\.\s*$/);

    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);
    expect(v2.systemPrompt.startsWith('[RUNTIME]')).toBe(true);
    expect(v2.systemPrompt).toContain('[LANGUAGE]');
  });

  it('V1 and V2 produce semantically equivalent system prompts', () => {
    const parsed = loadGuidePlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    expect(normalizeSystemPrompt(v2.systemPrompt)).toBe(
      normalizeSystemPrompt(v1.systemPrompt),
    );
  });

  it('both paths expose the upstream narrator output to the agent', () => {
    const parsed = loadGuidePlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    // The narrator output is interpolated into the body AND wrapped in the
    // inject XML tag. Both paths must surface it at least once.
    expect(v1.systemPrompt).toContain(NARRATOR_OUTPUT_TEXT);
    expect(v2.systemPrompt).toContain(NARRATOR_OUTPUT_TEXT);

    // The inject block tag name is `<narrator-output>` (declared via
    // `input.inject.as` in PLUGIN.md). V1 appends it as a suffix block;
    // V2 places it in segment 5 between segments 4 and 6. Both paths
    // must contain the closing tag.
    expect(v1.systemPrompt).toContain('</narrator-output>');
    expect(v2.systemPrompt).toContain('</narrator-output>');

    // Guide style instructions must survive interpolation on both sides.
    expect(v1.systemPrompt).toContain('safe（稳妥）');
    expect(v2.systemPrompt).toContain('safe（稳妥）');
    expect(v1.systemPrompt).toContain('generate-guide');
    expect(v2.systemPrompt).toContain('generate-guide');
  });

  it('V2 appends postHistory instructions after the player turn', () => {
    const parsed = loadGuidePlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    expect(v2.messages).toHaveLength(v1.messages.length + 1);

    const playerTurn = v2.messages[v2.messages.length - 2];
    expect(playerTurn?.role).toBe('user');
    expect(playerTurn?.content).toBe('I push open the heavy oak door.');

    const last = v2.messages[v2.messages.length - 1];
    expect(last?.role).toBe('system');
    expect(last?.content).toContain('generate-guide');

    const v1Last = v1.messages[v1.messages.length - 1];
    expect(v1Last?.role).toBe('user');
    expect(v1Last?.content).toBe('I push open the heavy oak door.');
  });

  it('V1 keeps the player turn as the final message', () => {
    const parsed = loadGuidePlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    const last = v1.messages[v1.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toBe('I push open the heavy oak door.');
  });

  it('V2 gate requires both env flag AND promptVersion: 2', () => {
    const parsed = loadGuidePlugin();
    const v1Manifest = { ...parsed.manifest, promptVersion: 1 as const };
    const params = makeBaseParams(parsed.promptTemplate, v1Manifest);

    process.env.COVEL_PROMPT_V2 = '1';
    const result = buildContext(params);

    // Stays on V1 because the manifest declared promptVersion: 1 explicitly.
    expect(result.systemPrompt).toMatch(/in 中文\.\s*$/);
    expect(result.systemPrompt.startsWith('[LANGUAGE]')).toBe(false);
  });
});

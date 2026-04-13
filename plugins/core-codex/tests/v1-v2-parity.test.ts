/**
 * V1/V2 prompt-assembler parity test for `core-codex` (S3-T5a).
 *
 * Verifies that after migrating core-codex to `promptVersion: 2`, the V2
 * assembler produces semantically equivalent prompts to V1 for the same
 * `TurnInput` + completed results from core-narrator.
 *
 * core-codex consumes a single inject from core-narrator (`<narrator-output>`)
 * and has no message history or player-character concerns — it runs after
 * the narrator output is committed. Both paths must surface the narrator
 * inject verbatim inside the `<narrator-output>` tag.
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

function loadCodexPlugin() {
  const content = readFileSync(PLUGIN_MD_PATH, 'utf-8');
  return parsePluginMd(content, PLUGIN_MD_PATH);
}

// ── Fixture builders ─────────────────────────────────────────────

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-codex-parity',
    turnId: 'turn-13',
    playerMessage: 'I investigate the ancient rune.',
    locale: 'zh-CN',
    ...overrides,
  };
}

const NARRATOR_OUTPUT_TEXT =
  'A glowing rune of the Old Tongue flares under your fingertips. The spectral owl-guardian stirs from its perch above the archway and speaks its name: Threnody.';

function makeNarratorResult(): RuntimeResult {
  return {
    pluginId: 'core-narrator',
    runtimeId: 'core-narrator',
    runId: 'run-1',
    turnId: 'turn-13',
    status: 'success',
    output: {
      narrativeOutput: NARRATOR_OUTPUT_TEXT,
    },
    toolCalls: [],
    durationMs: 90,
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
    messageHistory: [],
    sessionMeta: {
      turnNumber: 13,
      phase: 'playing',
      characters: [],
    },
  };
}

// ── Normalize helper ─────────────────────────────────────────────

/**
 * Strip the [LANGUAGE] segment and normalize whitespace so we can
 * compare V1/V2 system prompts for content equivalence. The language
 * constraint moves from tail (V1) to head (V2) by design.
 */
function normalizeSystemPrompt(prompt: string): string {
  return prompt
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

describe('core-codex V1/V2 prompt parity', () => {
  it('manifest declares promptVersion: 2 (plugin has opted into V2)', () => {
    const parsed = loadCodexPlugin();
    expect(parsed.manifest.promptVersion).toBe(2);
  });

  it('V2 path routes through three-tier assembler when env flag is set', () => {
    const parsed = loadCodexPlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    // V1 (env flag off) — language at the tail.
    const v1 = buildContext(params);
    expect(v1.systemPrompt).toMatch(/in 中文\.\s*$/);

    // V2 (env flag on) — language at the head via segment 1.
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);
    expect(v2.systemPrompt.startsWith('[LANGUAGE]')).toBe(true);
  });

  it('V1 and V2 produce semantically equivalent system prompts', () => {
    const parsed = loadCodexPlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    const v1Norm = normalizeSystemPrompt(v1.systemPrompt);
    const v2Norm = normalizeSystemPrompt(v2.systemPrompt);

    expect(v2Norm).toBe(v1Norm);
  });

  it('both paths surface the narrator inject inside <narrator-output>', () => {
    const parsed = loadCodexPlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    // The narrator output is the sole inject for core-codex.
    expect(v1.systemPrompt).toContain(NARRATOR_OUTPUT_TEXT);
    expect(v2.systemPrompt).toContain(NARRATOR_OUTPUT_TEXT);
    expect(v1.systemPrompt).toContain('<narrator-output>');
    expect(v2.systemPrompt).toContain('<narrator-output>');

    // Codex-specific instruction headers must be preserved on both paths.
    expect(v1.systemPrompt).toContain('知识图鉴系统');
    expect(v2.systemPrompt).toContain('知识图鉴系统');
    expect(v1.systemPrompt).toContain('plugin-data-list');
    expect(v2.systemPrompt).toContain('plugin-data-list');

    // Language constraint is present on both paths (position differs).
    expect(v1.systemPrompt).toContain('中文');
    expect(v2.systemPrompt).toContain('中文');
  });

  it('V1 and V2 produce identical message arrays', () => {
    const parsed = loadCodexPlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    // core-codex declares neither authorsNote nor postHistory, so V2's
    // message array is identical to V1: empty history + current user turn.
    expect(v2.messages).toEqual(v1.messages);

    const last = v2.messages[v2.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toBe('I investigate the ancient rune.');
  });

  it('V2 gate requires both env flag AND promptVersion: 2', () => {
    const parsed = loadCodexPlugin();

    // Force the manifest into "promptVersion: 1" → even with env flag we stay V1.
    const v1Manifest = { ...parsed.manifest, promptVersion: 1 as const };
    const params = makeBaseParams(parsed.promptTemplate, v1Manifest);

    process.env.COVEL_PROMPT_V2 = '1';
    const result = buildContext(params);

    // V1 places [LANGUAGE] at the tail.
    expect(result.systemPrompt).toMatch(/in 中文\.\s*$/);
    expect(result.systemPrompt.startsWith('[LANGUAGE]')).toBe(false);
  });
});

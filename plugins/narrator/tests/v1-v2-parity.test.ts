/**
 * V1/V2 prompt-assembler parity test for `narrator` (S2-T4).
 *
 * Verifies that after migrating narrator to `promptVersion: 2`, the V2
 * assembler produces semantically equivalent messages to V1 for the same
 * `TurnInput` + session meta + message history.
 *
 * "Semantically equivalent" here means:
 *   - The final user message is identical (byte-for-byte).
 *   - The history sequence is identical.
 *   - The system prompt contains the same content slots (world lore,
 *     dimensions, opening scenario, player character, player message,
 *     inject block for NPC graph, language constraint), after a normalize
 *     pass that collapses whitespace and strips segment ordering noise.
 *
 * Intentionally does NOT assert byte-identical system prompts: V2 reorders
 * the [LANGUAGE] constraint from the tail (V1) to the head (segment 1),
 * and uses `\n\n` segment separators. Those are the structural differences
 * the migration accepts by design (see §A8 of the improvement plan).
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

function loadNarratorPlugin() {
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

function makeNpcGraphResult(): RuntimeResult {
  return {
    pluginId: 'npc-graph',
    runtimeId: 'npc-graph/rag-retriever',
    runId: 'run-1',
    turnId: 'turn-7',
    status: 'success',
    output: {
      npcContext:
        'Elena (trust: 0.8, shared past with player)\nMarcus (debt owed to player)',
    },
    toolCalls: [],
    durationMs: 40,
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
    completedResults: new Map([
      ['npc-graph/rag-retriever', makeNpcGraphResult()],
    ]),
    config: {
      worldLore:
        'Cloudmere is a high-altitude archipelago of sky-islands held aloft by ancient crystals.',
      worldDimensions: 'Geography: five floating isles. Factions: Skyguard, Tradewind Syndicate.',
      worldOpeningScenario: 'You stand at the edge of Halcyon Wharf as the dawn bell tolls.',
      worldTone: 'poetic, cinematic',
    },
    messageHistory: [
      { role: 'user', content: 'I leave the inn.' },
      { role: 'assistant', content: 'The mist wraps around your boots as you step outside.' },
      { role: 'user', content: 'I walk toward the harbor.' },
      { role: 'assistant', content: 'The cry of gulls greets you at the pier.' },
    ],
    sessionMeta: {
      turnNumber: 7,
      characters: [
        {
          name: 'Aria',
          type: 'player',
          description: 'A wandering scholar with ink-stained fingers',
        },
      ],
    },
  };
}

// ── Normalize helper ─────────────────────────────────────────────

/**
 * Strip framework preamble + [LANGUAGE] segment and normalize whitespace
 * so we can compare V1/V2 system prompts for content equivalence.
 * - V1 keeps the legacy structure with `[LANGUAGE]` at the tail.
 * - V2 wraps a `[RUNTIME]` + `[LANGUAGE]` preamble at the head (segment 1).
 */
function normalizeSystemPrompt(prompt: string): string {
  return prompt
    // Remove the [RUNTIME] header lines (V2 segment 1).
    .replace(/\[RUNTIME\][^\n]*\n?/g, '')
    // Remove the [LANGUAGE] constraint line/segment wherever it lives.
    .replace(/\[LANGUAGE\][^\n]*\.?/g, '')
    // Remove the [COMPLETION] runtime-done contract lines (V2 segment 1 tail).
    // Added by the runtime-done early-exit framework — not present in V1.
    .replace(/\[COMPLETION\][^\n]*\n?/g, '')
    // Collapse multiple blank lines → one blank line.
    .replace(/\n{3,}/g, '\n\n')
    // Trim trailing / leading whitespace on every line.
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

// ── Tests ────────────────────────────────────────────────────────

afterEach(() => {
  delete process.env.COVEL_PROMPT_V2;
});

describe('narrator V1/V2 prompt parity', () => {
  it('manifest declares promptVersion: 2 (plugin has opted into V2)', () => {
    const parsed = loadNarratorPlugin();
    expect(parsed.manifest.promptVersion).toBe(2);
  });

  it('V2 path routes through three-tier assembler when env flag is set', () => {
    const parsed = loadNarratorPlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    // V1 (env flag off) — language at the tail, unified body.
    const v1 = buildContext(params);
    expect(v1.systemPrompt).toMatch(/in 中文\.\s*$/);

    // V2 (env flag on) — runtime + language preamble at segment 1.
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);
    expect(v2.systemPrompt.startsWith('[RUNTIME]')).toBe(true);
    expect(v2.systemPrompt).toContain('[LANGUAGE]');
  });

  it('V1 and V2 produce semantically equivalent system prompts', () => {
    const parsed = loadNarratorPlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    const v1Norm = normalizeSystemPrompt(v1.systemPrompt);
    const v2Norm = normalizeSystemPrompt(v2.systemPrompt);

    expect(v2Norm).toBe(v1Norm);
  });

  it('both paths expose identical core content fields in the system prompt', () => {
    const parsed = loadNarratorPlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    // World lore
    expect(v1.systemPrompt).toContain('Cloudmere is a high-altitude');
    expect(v2.systemPrompt).toContain('Cloudmere is a high-altitude');

    // World dimensions: narrator fetches dimensions on-demand via world-dimension-get
    // tool rather than injecting them statically into the prompt. The prompt
    // instead refers players to call the tool when specific dimension info is needed.
    expect(v1.systemPrompt).toContain('world-dimension-get');
    expect(v2.systemPrompt).toContain('world-dimension-get');

    // Opening scenario
    expect(v1.systemPrompt).toContain('Halcyon Wharf');
    expect(v2.systemPrompt).toContain('Halcyon Wharf');

    // Player character interpolation — the body references
    // `{{ player.character }}` which stringifies the character object. We
    // only assert that both paths produce the same `## 玩家角色` header
    // followed by the same rendered value (whatever `String(object)` gives).
    expect(v1.systemPrompt).toContain('## 玩家角色');
    expect(v2.systemPrompt).toContain('## 玩家角色');

    // Player message (interpolated)
    expect(v1.systemPrompt).toContain('I push open the heavy oak door');
    expect(v2.systemPrompt).toContain('I push open the heavy oak door');

    // Inject block for NPC graph
    expect(v1.systemPrompt).toContain('Elena (trust: 0.8');
    expect(v2.systemPrompt).toContain('Elena (trust: 0.8');
    expect(v1.systemPrompt).toContain('<npc-relationships>');
    expect(v2.systemPrompt).toContain('<npc-relationships>');

    // Language constraint
    expect(v1.systemPrompt).toContain('中文');
    expect(v2.systemPrompt).toContain('中文');

    // World tone
    expect(v1.systemPrompt).toContain('poetic, cinematic');
    expect(v2.systemPrompt).toContain('poetic, cinematic');
  });

  it('V1 and V2 produce identical message arrays', () => {
    const parsed = loadNarratorPlugin();
    const params = makeBaseParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = '1';
    const v2 = buildContext(params);

    // narrator declares postHistory, so V2 appends one extra system
    // instruction after the current user turn.
    expect(v2.messages).toHaveLength(v1.messages.length + 1);
    expect(v2.messages.at(-2)).toEqual(v1.messages.at(-1));
    expect(v2.messages.at(-1)?.role).toBe('system');
    expect(v2.messages.at(-1)?.content).toContain('末尾只保留自然悬念');

    // Explicit shape check — V1 still ends with the current user turn.
    const last = v1.messages[v1.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toBe('I push open the heavy oak door.');
  });

  it('V2 gate requires both env flag AND promptVersion: 2', () => {
    const parsed = loadNarratorPlugin();

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

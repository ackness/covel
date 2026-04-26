/**
 * Tests for the multimodal LLM-history bridge added by the
 * 2026-04-26 audit fix (P1: assetGenerateToLLM never reached real
 * context assembly).
 *
 * Covers:
 *  - Plain text history records still produce string `content` (no
 *    behaviour change for the legacy path).
 *  - History records carrying `metadata.block.type === 'asset.generate'`
 *    with a valid `AssetGenerateView` are upgraded to a multimodal
 *    `ContentPart[]` containing both a text summary and an image part.
 *  - Malformed metadata silently falls back to the plain-string path.
 */

import { describe, it, expect } from 'vitest';
import { buildContext } from '@covel/context';
import type { ContextBuildParams, MessageHistoryRecord } from '@covel/context';
import type { AssetGenerateView, MediaRef, RuntimeManifest, TurnInput } from '@covel/shared';

// ── Fixtures ──────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return { name: 'test-rt', description: 'test', priority: 500, ...overrides };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-2',
    playerMessage: 'continue',
    ...overrides,
  };
}

function makeMediaRef(overrides?: Partial<MediaRef>): MediaRef {
  return {
    id: 'a'.repeat(64),
    mime: 'image/png',
    size: 4096,
    url: 'https://cdn.example/media/a.png',
    ...overrides,
  };
}

function makeAssetGenerateView(
  overrides?: Partial<AssetGenerateView>,
): AssetGenerateView {
  return {
    id: 'proposal-1',
    type: 'asset.generate',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    source: { pluginId: 'core-image', runtimeId: 'core-image/generator' },
    ref: makeMediaRef(),
    modality: 'image',
    createdAt: new Date('2026-04-26T00:00:00Z').toISOString(),
    ...overrides,
  };
}

function makeBaseParams(
  history: readonly MessageHistoryRecord[],
): ContextBuildParams {
  return {
    promptTemplate: 'You are a vision-capable narrator.',
    manifest: makeManifest(),
    turnInput: makeTurnInput(),
    completedResults: new Map(),
    config: {},
    messageHistory: history,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('LLM history multimodal bridge', () => {
  it('keeps plain text history as string content', () => {
    const history: MessageHistoryRecord[] = [
      { role: 'user', content: 'show me the dragon' },
      { role: 'assistant', content: 'A scaled wing unfolds.' },
    ];

    const ctx = buildContext(makeBaseParams(history));

    // history (2) + current user message (1)
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toMatchObject({
      role: 'user',
      content: 'show me the dragon',
    });
    expect(ctx.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'A scaled wing unfolds.',
    });
    expect(typeof ctx.messages[1]!.content).toBe('string');
  });

  it('upgrades asset.generate blocks to multimodal content parts', () => {
    const view = makeAssetGenerateView();
    const history: MessageHistoryRecord[] = [
      {
        role: 'assistant',
        content: '',
        metadata: {
          turnId: view.turnId,
          runtimeId: view.source.runtimeId,
          kind: 'plugin',
          block: {
            id: view.id,
            type: 'asset.generate',
            data: view,
            meta: {
              runtimeId: view.source.runtimeId,
              pluginId: view.source.pluginId,
              turnId: view.turnId,
            },
          },
        },
      },
    ];

    const ctx = buildContext(makeBaseParams(history));

    // history (1 upgraded) + current user message (1)
    expect(ctx.messages).toHaveLength(2);

    const upgraded = ctx.messages[0]!;
    expect(upgraded.role).toBe('assistant');
    expect(Array.isArray(upgraded.content)).toBe(true);

    const parts = upgraded.content as readonly { type: string }[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Generated image asset'),
    });
    expect(parts[1]).toMatchObject({
      type: 'image',
      image: {
        id: view.ref.id,
        mime: 'image/png',
        url: view.ref.url,
      },
    });

    // Current user turn must remain a plain text content.
    expect(typeof ctx.messages[1]!.content).toBe('string');
  });

  it('omits the image part for non-image asset modalities', () => {
    const view = makeAssetGenerateView({
      modality: 'audio',
      ref: makeMediaRef({ mime: 'audio/wav' }),
    });
    const history: MessageHistoryRecord[] = [
      {
        role: 'assistant',
        content: '',
        metadata: {
          block: { id: view.id, type: 'asset.generate', data: view },
        },
      },
    ];

    const ctx = buildContext(makeBaseParams(history));

    const parts = ctx.messages[0]!.content as readonly { type: string }[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text' });
  });

  it('falls back to plain content when block metadata is malformed', () => {
    const history: MessageHistoryRecord[] = [
      {
        role: 'assistant',
        content: 'fallback text',
        metadata: {
          // Missing `data` payload — bridge must NOT throw and must NOT
          // fabricate empty content parts; it should surface the original
          // string instead.
          block: { id: 'p-1', type: 'asset.generate' },
        },
      },
    ];

    const ctx = buildContext(makeBaseParams(history));

    expect(ctx.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'fallback text',
    });
    expect(typeof ctx.messages[0]!.content).toBe('string');
  });

  it('ignores non-asset.generate blocks (e.g. ui.render)', () => {
    const history: MessageHistoryRecord[] = [
      {
        role: 'assistant',
        content: '[render block]',
        metadata: {
          block: { id: 'p-2', type: 'ui.render', data: { parts: [] } },
        },
      },
    ];

    const ctx = buildContext(makeBaseParams(history));

    expect(ctx.messages[0]).toMatchObject({
      role: 'assistant',
      content: '[render block]',
    });
    expect(typeof ctx.messages[0]!.content).toBe('string');
  });
});

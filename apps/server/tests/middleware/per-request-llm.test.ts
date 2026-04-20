/**
 * Tests for the per-request LLM middleware.
 *
 * The middleware parses `X-Provider-Keys` and `X-Slot-Config` headers
 * and swaps `c.get('llmAdapter')` for a request-scoped adapter that
 * forwards the overlay + keys into the gateway. End-to-end turn routes
 * rely on this so browser-only custom slots propagate into real LLM
 * calls.
 *
 * The tests boot a minimal Hono app, register the middleware, expose a
 * tiny echo route that calls `llmAdapter.generate()`, and assert the
 * mock gateway saw the expected options.
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { LLMAdapter } from '@covel/runtime';
import type { AiStack } from '../../src/ai-setup.js';
import { createPerRequestLlmMiddleware } from '../../src/middleware/per-request-llm.js';

type GenerateOptions = Parameters<AiStack['gateway']['generateText']>[1];

interface RecordedCall {
  presetId: string | undefined;
  apiKeys: Record<string, string> | undefined;
  slotOverrides: GenerateOptions extends { slotOverrides?: infer S } ? S : never;
}

/**
 * Minimal AiStack-shaped mock. Only the surface consumed by
 * `createGatewayAdapter` + the middleware matters, so the rest is
 * intentionally unimplemented — any call that does not route through
 * the middleware-path-under-test will throw.
 */
function createMockAi(): { ai: AiStack; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const gateway: AiStack['gateway'] = {
    async generateText(input, options) {
      calls.push({
        presetId: input.presetId,
        apiKeys: options?.apiKeys,
        slotOverrides: options?.slotOverrides,
      });
      return {
        text: 'ok',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: [],
      };
    },
    async *streamText() {
      throw new Error('streamText: not used in this test');
    },
    async generateObject() {
      throw new Error('generateObject: not used in this test');
    },
    async embed() {
      throw new Error('embed: not used in this test');
    },
    async generateImage() {
      throw new Error('generateImage: not used in this test');
    },
    async synthesizeSpeech() {
      throw new Error('synthesizeSpeech: not used in this test');
    },
    async transcribeAudio() {
      throw new Error('transcribeAudio: not used in this test');
    },
    resolveSlotToPresetId() {
      return undefined;
    },
    getSlotParameterOverrides() {
      return undefined;
    },
  } as unknown as AiStack['gateway'];

  const ai: AiStack = {
    gateway,
  } as unknown as AiStack;

  return { ai, calls };
}

function buildTestApp(opts: {
  ai: AiStack;
  envApiKeys: Record<string, string>;
  defaultAdapter: LLMAdapter;
}) {
  const mw = createPerRequestLlmMiddleware({
    ai: opts.ai,
    envApiKeys: opts.envApiKeys,
    defaultLlmAdapter: opts.defaultAdapter,
  });

  const app = new Hono<{ Variables: { llmAdapter: LLMAdapter } }>();

  // Initialize the default adapter just like the real bootstrap does.
  app.use('*', async (c, next) => {
    c.set('llmAdapter', opts.defaultAdapter);
    await next();
  });
  app.use('*', mw);

  app.post('/echo', async (c) => {
    const adapter = c.get('llmAdapter');
    const body = await c.req.json<{ model?: string }>();
    const result = await adapter.generate({
      model: body.model,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return c.json({ text: result.content });
  });

  return app;
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('per-request LLM middleware', () => {
  it('forwards customPresets and slotPresetOverrides to the gateway', async () => {
    const { ai, calls } = createMockAi();
    const defaultAdapter: LLMAdapter = {
      async generate() {
        throw new Error(
          'default adapter should NOT be used when the request carries slot config',
        );
      },
    };
    const app = buildTestApp({
      ai,
      envApiKeys: { deepseek: 'env-only-key' },
      defaultAdapter,
    });

    const slotConfig = {
      slotPresetOverrides: { fast: 'custom_abc' },
      parameterOverrides: {
        fast: {
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      },
      customPresets: [
        {
          id: 'custom_abc',
          name: 'Vendor X Fast',
          provider: 'vendorX',
          baseUrl: 'https://api.vendorx.example/v1',
          model: 'fast-7b',
          protocol: 'openai-chat-v1',
        },
      ],
    };
    const providerKeys = { vendorX: 'sk-vendor-LIVE' };

    const res = await app.request('/echo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Provider-Keys': b64(providerKeys),
        'X-Slot-Config': b64(slotConfig),
      },
      body: JSON.stringify({ model: 'fast' }),
    });
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].presetId).toBe('fast');
    expect(calls[0].slotOverrides).toMatchObject({
      slotPresetOverrides: { fast: 'custom_abc' },
      parameterOverrides: {
        fast: {
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      },
      customPresets: [
        expect.objectContaining({
          id: 'custom_abc',
          provider: 'vendorX',
          model: 'fast-7b',
          baseUrl: 'https://api.vendorx.example/v1',
        }),
      ],
    });
    // Env keys act as base; per-request keys override/extend them.
    expect(calls[0].apiKeys).toEqual({
      deepseek: 'env-only-key',
      vendorX: 'sk-vendor-LIVE',
    });
  });

  it('leaves the default adapter in place when no request-scoped headers are present', async () => {
    const { ai, calls } = createMockAi();
    let defaultCalled = false;
    const defaultAdapter: LLMAdapter = {
      async generate() {
        defaultCalled = true;
        return {
          content: 'from-default',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const app = buildTestApp({
      ai,
      envApiKeys: {},
      defaultAdapter,
    });

    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'story' }),
    });
    expect(res.status).toBe(200);
    expect(defaultCalled).toBe(true);
    expect(calls).toHaveLength(0); // mock gateway untouched
  });

  it('tolerates malformed X-Slot-Config headers without failing the request', async () => {
    const { ai, calls } = createMockAi();
    const defaultAdapter: LLMAdapter = {
      async generate() {
        return {
          content: 'fell-back',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const app = buildTestApp({
      ai,
      envApiKeys: {},
      defaultAdapter,
    });

    const res = await app.request('/echo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Not valid base64-JSON
        'X-Slot-Config': 'not-a-header-we-can-decode',
      },
      body: JSON.stringify({ model: 'story' }),
    });
    expect(res.status).toBe(200);
    // No slot overrides detected → default adapter used, mock gateway not hit.
    expect(calls).toHaveLength(0);
  });

  it('drops custom preset entries missing required fields', async () => {
    const { ai, calls } = createMockAi();
    const app = buildTestApp({
      ai,
      envApiKeys: {},
      defaultAdapter: {
        async generate() {
          throw new Error('should not reach default adapter');
        },
      },
    });

    const slotConfig = {
      customPresets: [
        // Good entry
        {
          id: 'good',
          name: 'Good',
          provider: 'vendorX',
          baseUrl: 'https://ok.example',
          model: 'ok-m',
        },
        // Missing provider
        { id: 'bad1', name: 'Bad', provider: '', model: 'm' },
        // Missing model
        { id: 'bad2', name: 'Bad', provider: 'p', model: '' },
      ],
    };

    const res = await app.request('/echo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Slot-Config': b64(slotConfig),
      },
      body: JSON.stringify({ model: 'good' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].slotOverrides?.customPresets).toHaveLength(1);
    expect(calls[0].slotOverrides?.customPresets?.[0]).toMatchObject({
      id: 'good',
      provider: 'vendorX',
      model: 'ok-m',
    });
  });
});

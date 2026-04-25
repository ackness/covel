import { describe, expect, it } from 'vitest';
import type { RuntimeManifest, TurnInput } from '@covel/shared';
import { createMemoryStore } from '@covel/store';
import { executeTurn } from '../src/turn-executor.js';
import type { TurnExecutorDeps } from '../src/turn-executor.js';
import type { LLMAdapter, LLMResponse } from '../src/llm-adapter.js';

class CapturingLLM implements LLMAdapter {
  responseFormat: unknown;

  async generate(params: Parameters<LLMAdapter['generate']>[0]): Promise<LLMResponse> {
    this.responseFormat = params.responseFormat;
    return {
      content: '{"ok":true}',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: 'test-plugin/prompt-generator',
    pluginId: 'test-plugin',
    description: 'prompt generator',
    priority: 10,
    runtimeType: 'agent',
    trigger: { type: 'auto' },
    outputKind: 'plugin',
    ...overrides,
  } as RuntimeManifest;
}

describe('executeTurn: output.schema.json', () => {
  it('passes loaded outputSchema as json_schema responseFormat', async () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
      },
      required: ['ok'],
    };
    const llm = new CapturingLLM();
    const input: TurnInput = {
      sessionId: 'sess-schema',
      turnId: 'turn-schema',
      playerMessage: 'start',
    };
    const runtime = manifest();
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: 'Return JSON.',
        references: [],
        outputSchema: schema,
      }),
      llm,
      getConfig: () => ({}),
      store: createMemoryStore(),
    };

    await executeTurn(input, [runtime], deps);

    expect(llm.responseFormat).toEqual({
      type: 'json_schema',
      schema,
    });
  });
});

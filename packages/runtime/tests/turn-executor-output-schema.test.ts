import { describe, expect, it } from 'vitest';
import type { RuntimeManifest, TurnInput } from '@covel/shared';
import { createMemoryStore } from '@covel/store';
import { executeTurn } from '../src/turn-executor.js';
import type { TurnExecutorDeps } from '../src/turn-executor.js';
import type { LLMAdapter, LLMResponse } from '../src/llm-adapter.js';
import type { ToolExecutor } from '../src/tool-executor.js';

class CapturingLLM implements LLMAdapter {
  responseFormat: unknown;
  tools: unknown;
  content = '{"ok":true}';

  async generate(params: Parameters<LLMAdapter['generate']>[0]): Promise<LLMResponse> {
    this.responseFormat = params.responseFormat;
    this.tools = params.tools;
    return {
      content: this.content,
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

  it('does not auto-inject runtime-done for schema-declared agent runtimes', async () => {
    const schema = {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
      },
      required: ['prompt'],
    };
    const llm = new CapturingLLM();
    const input: TurnInput = {
      sessionId: 'sess-schema-tools',
      turnId: 'turn-schema-tools',
      playerMessage: 'start',
    };
    const runtime = manifest({
      output: { schema: './output.schema.json' },
      tools: { builtin: ['plugin-data-set'] },
    });
    const toolExecutor: ToolExecutor = {
      async execute() {
        throw new Error('not used');
      },
      getToolInfo: (name) => ({
        name,
        description: `Tool ${name}`,
        jsonSchema: { type: 'object', additionalProperties: true },
      }),
    };
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
      toolExecutor,
    };

    await executeTurn(input, [runtime], deps);

    expect((llm.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      'plugin-data-set',
    ]);
  });

  it('fails schema-declared plugin runtimes when parsed JSON has the wrong shape', async () => {
    const schema = {
      type: 'object',
      required: ['prompt', 'promptMode', 'events'],
      properties: {
        prompt: { type: 'string' },
        promptMode: { type: 'string' },
        events: { type: 'array', minItems: 1 },
      },
    };
    const llm = new CapturingLLM();
    llm.content = '{"scene":{"location":"mistport"},"recent_events":["wrong envelope"]}';
    const input: TurnInput = {
      sessionId: 'sess-schema-invalid',
      turnId: 'turn-schema-invalid',
      playerMessage: 'start',
    };
    const runtime = manifest({
      output: { schema: './output.schema.json' },
    });
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

    const result = await executeTurn(input, [runtime], deps);

    expect(result.runtimeResults[0]?.status).toBe('failed');
    expect(result.runtimeResults[0]?.error).toContain('output did not match output.schema');
    expect(result.runtimeResults[0]?.error).toContain("must have required property 'prompt'");
  });
});

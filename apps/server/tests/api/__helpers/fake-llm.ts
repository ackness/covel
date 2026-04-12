/**
 * Test helpers — fake LLMAdapter and fake LoadedRuntime factory.
 *
 * Used by tests that need to drive executeTurn() without real LLM calls.
 * The fake LLM returns a single deterministic narrative string and signals
 * 'stop' so the executor commits a narrative.append proposal.
 */

import type { LLMAdapter, LLMResponse } from '@covel/runtime';
import type { LoadedRuntime } from '@covel/plugin-loader';
import type { RuntimeManifest } from '@covel/shared';

export interface FakeLlmCall {
  readonly model?: string;
  readonly messageCount: number;
  readonly toolCount: number;
}

export interface FakeLLMHandle {
  readonly llm: LLMAdapter;
  readonly calls: readonly FakeLlmCall[];
}

/**
 * Build a fake LLMAdapter that returns the same canned narrative for every
 * generate() call and exposes the call log for assertions.
 */
export function makeFakeLLM(narrative: string): FakeLLMHandle {
  const calls: FakeLlmCall[] = [];

  const llm: LLMAdapter = {
    async generate(params): Promise<LLMResponse> {
      calls.push({
        model: params.model,
        messageCount: params.messages.length,
        toolCount: params.tools?.length ?? 0,
      });
      return {
        content: narrative,
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };

  return { llm, calls };
}

/**
 * Build a minimal LoadedRuntime for an agent runtime that emits one narrative
 * line. Pair with makeFakeLLM to drive executeTurn() end-to-end without
 * touching disk or a real provider.
 */
export function makeFakeLoadedRuntime(args: {
  name: string;
  pluginId?: string;
  promptTemplate?: string;
  outputKind?: 'story' | 'plugin' | 'system';
  pluginType?: 'core-plugin' | 'plugin';
}): LoadedRuntime {
  const manifest: RuntimeManifest = {
    name: args.name,
    pluginId: args.pluginId ?? args.name,
    description: 'fake runtime for tests',
    priority: 500,
    runtimeType: 'agent',
    outputKind: args.outputKind ?? 'story',
    pluginType: args.pluginType ?? 'plugin',
    trigger: { mode: 'always' },
  };

  return {
    manifest,
    promptTemplate: args.promptTemplate ?? 'You are a test narrator. Reply with a single line.',
    references: [],
  };
}

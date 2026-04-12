/**
 * ToolExecutor text-result convention tests.
 *
 * When a tool returns an object with a `_text` string field, the framework
 * should send ONLY that text to the LLM (instead of JSON.stringifying the
 * whole object). The full object is still preserved in `parsedResult` for
 * trace/debug consumption, so framework-level code loses nothing — only the
 * LLM-facing payload becomes human-readable text.
 *
 * Tools without `_text` continue to serialize as JSON (backward compatible).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createToolExecutor } from '../src/tool-executor.js';
import type { ToolCall, ToolCallContext } from '../src/tool-executor.js';
import { createMemoryStore } from '@covel/store';
import type { DataStore } from '@covel/store';
import { tool } from '@covel/tools';
import { z } from 'zod';

const textFirstTool = tool({
  name: 'text-first',
  description: 'Returns a _text field plus structured metadata',
  parameters: z.object({ name: z.string() }),
  execute: async (params) => ({
    _text: `Character ${params.name} created successfully`,
    characterId: 'char-123',
    name: params.name,
  }),
});

const jsonOnlyTool = tool({
  name: 'json-only',
  description: 'Returns a plain object without _text (legacy format)',
  parameters: z.object({ x: z.number() }),
  execute: async (params) => ({ doubled: params.x * 2 }),
});

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { toolCallId: `call-${name}`, name, arguments: JSON.stringify(args) };
}

const ctx: ToolCallContext = {
  sessionId: 'sess-1',
  turnId: 'turn-1',
  pluginId: 'test-plugin',
  runtimeId: 'test-rt',
};

describe('ToolExecutor text-result convention', () => {
  let store: DataStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  it('sends _text field as raw LLM content when present', async () => {
    const executor = createToolExecutor({
      findTool: (name) => (name === 'text-first' ? textFirstTool : undefined),
      store,
    });

    const result = await executor.execute(makeCall('text-first', { name: '柳无痕' }), ctx);

    expect(result.success).toBe(true);
    // LLM-facing result is the raw text, not JSON-stringified
    expect(result.result).toBe('Character 柳无痕 created successfully');
    // parsedResult still holds the full structured object for framework use
    expect(result.parsedResult).toMatchObject({
      _text: 'Character 柳无痕 created successfully',
      characterId: 'char-123',
      name: '柳无痕',
    });
  });

  it('falls back to JSON.stringify when _text is absent', async () => {
    const executor = createToolExecutor({
      findTool: (name) => (name === 'json-only' ? jsonOnlyTool : undefined),
      store,
    });

    const result = await executor.execute(makeCall('json-only', { x: 5 }), ctx);

    expect(result.success).toBe(true);
    // Legacy tools still serialize as JSON
    expect(result.result).toBe('{"doubled":10}');
    expect(result.parsedResult).toEqual({ doubled: 10 });
  });

  it('does not use _text when it is not a string (safety)', async () => {
    const weirdTool = tool({
      name: 'weird',
      description: 'Non-string _text should not be used as LLM content',
      parameters: z.object({}),
      execute: async () => ({ _text: 42, foo: 'bar' }),
    });
    const executor = createToolExecutor({
      findTool: (name) => (name === 'weird' ? weirdTool : undefined),
      store,
    });

    const result = await executor.execute(makeCall('weird', {}), ctx);

    expect(result.success).toBe(true);
    // Non-string _text → falls back to JSON.stringify
    expect(result.result).toBe('{"_text":42,"foo":"bar"}');
  });
});

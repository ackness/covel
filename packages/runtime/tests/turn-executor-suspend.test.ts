/**
 * Tests for TurnExecutor suspend / resume primitives (S4-T4).
 *
 * Covers:
 * - Agent runtime: suspend tool returns sentinel → suspension persisted, status: 'suspended'
 * - Function runtime: handler returns { status: 'suspended' } → same flow
 * - Flag-off: sentinel treated as normal tool result, no suspension created
 * - Partial content and tool calls before suspend are captured in pendingContinuation
 * - resumeSuspendedRuntime: reconstructs messages, runs LLM loop, marks resolved, emits turn.resumed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RuntimeManifest, TurnInput, SubscriptionEvent } from '@covel/shared';
import type { LoadedRuntime } from '@covel/plugin-loader';
import { createMemoryStore } from '@covel/store';
import type { DataStore } from '@covel/store';
import { createEventBus } from '@covel/events';
import type { EventBus } from '@covel/events';
import { executeTurn, resumeSuspendedRuntime } from '../src/turn-executor.js';
import type { TurnExecutorDeps } from '../src/turn-executor.js';
import type { LLMAdapter, LLMResponse } from '../src/llm-adapter.js';
import type { ToolExecutor, ToolCallContext, ToolCallResult } from '../src/tool-executor.js';

// ── Fixtures ─────────────────────────────────────────────────────

const SUSPEND_SENTINEL = {
  _covelSuspend: true,
  reason: 'Need player name',
  resumeSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
};

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: 'test-plugin',
    pluginId: 'test-plugin',
    pluginType: 'community',
    priority: 500,
    trigger: { mode: 'always' },
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

function makeFunctionManifest(): RuntimeManifest {
  return makeManifest({ runtimeType: 'function' });
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    playerMessage: 'test message',
    ...overrides,
  };
}

// ── Mock LLM ─────────────────────────────────────────────────────

class MockLLM implements LLMAdapter {
  responses: LLMResponse[] = [];
  callCount = 0;

  setResponses(responses: LLMResponse[]) {
    this.responses = responses;
    this.callCount = 0;
  }

  async generate(): Promise<LLMResponse> {
    const response = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    return response!;
  }
}

// ── Mock ToolExecutor ────────────────────────────────────────────

class MockToolExecutor implements ToolExecutor {
  toolResults: Map<string, ToolCallResult> = new Map();

  setToolResult(toolName: string, result: ToolCallResult) {
    this.toolResults.set(toolName, result);
  }

  async execute(call: { toolCallId: string; name: string; arguments: string }, _ctx: ToolCallContext): Promise<ToolCallResult> {
    const preset = this.toolResults.get(call.name);
    if (preset) {
      return { ...preset, toolCallId: call.toolCallId };
    }
    return {
      toolCallId: call.toolCallId,
      name: call.name,
      result: JSON.stringify({ ok: true }),
      parsedResult: { ok: true },
      success: true,
    };
  }

  getToolInfo(name: string) {
    return {
      name,
      description: `Mock tool ${name}`,
      jsonSchema: { type: 'object' as const, properties: {} },
    };
  }
}

// ── Agent Runtime: suspend tool sentinel ─────────────────────────

describe('TurnExecutor — agent runtime suspend', () => {
  let mockLLM: MockLLM;
  let mockToolExecutor: MockToolExecutor;
  let store: DataStore;
  let eventBus: EventBus;
  let agentManifest: RuntimeManifest;
  let agentLoaded: LoadedRuntime;

  const originalEnv = process.env['COVEL_SUSPEND_V1'];

  beforeEach(async () => {
    process.env['COVEL_SUSPEND_V1'] = '1';
    mockLLM = new MockLLM();
    mockToolExecutor = new MockToolExecutor();
    store = createMemoryStore();
    // Prime history under multiple session IDs that tests exercise so
    // turnNumber >= 1 (main-loop band for priority-500 runtimes).
    for (const sid of ['sess-1', 'sess-42']) {
      await store.appendTurnMessage({
        id: `prior-player-${sid}`,
        sessionId: sid,
        turnId: 'prior-turn',
        sourceType: 'player',
        role: 'user',
        content: 'prior turn',
        order: 0,
        createdAt: '2024-01-01T00:00:00Z',
      });
    }
    eventBus = createEventBus();

    agentManifest = makeManifest({
      tools: { builtin: ['suspend'] },
    });

    agentLoaded = {
      manifest: agentManifest,
      promptTemplate: '## Test Plugin\nYou are a test agent.',
      references: [],
    };
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['COVEL_SUSPEND_V1'];
    } else {
      process.env['COVEL_SUSPEND_V1'] = originalEnv;
    }
  });

  it('should persist suspension and return status: suspended when suspend sentinel detected', async () => {
    // LLM calls suspend tool, then (never reached) would return narrative
    mockLLM.setResponses([
      {
        content: 'Thinking about next step...',
        toolCalls: [{ id: 'tc-suspend-1', name: 'suspend', arguments: JSON.stringify({ reason: 'Need player name', resumeSchema: {} }) }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    // Tool executor returns the sentinel when 'suspend' is called
    mockToolExecutor.setToolResult('suspend', {
      toolCallId: 'tc-suspend-1',
      name: 'suspend',
      result: JSON.stringify(SUSPEND_SENTINEL),
      parsedResult: SUSPEND_SENTINEL,
      success: true,
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => agentLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: mockToolExecutor,
      eventBus,
    };

    const result = await executeTurn(makeTurnInput(), [agentManifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    const rr = result.runtimeResults[0]!;
    expect(rr.status).toBe('suspended');
    expect((rr.output as Record<string, unknown>).suspended).toBe(true);
    expect(typeof (rr.output as Record<string, unknown>).suspensionId).toBe('string');
    expect((rr.output as Record<string, unknown>).reason).toBe('Need player name');
  });

  it('should save suspension to store with correct fields', async () => {
    mockLLM.setResponses([
      {
        content: 'partial text',
        toolCalls: [{ id: 'tc-s1', name: 'suspend', arguments: JSON.stringify({ reason: 'Waiting for input', resumeSchema: { type: 'object' } }) }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    mockToolExecutor.setToolResult('suspend', {
      toolCallId: 'tc-s1',
      name: 'suspend',
      result: JSON.stringify({ _covelSuspend: true, reason: 'Waiting for input', resumeSchema: { type: 'object' } }),
      parsedResult: { _covelSuspend: true, reason: 'Waiting for input', resumeSchema: { type: 'object' } },
      success: true,
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => agentLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: mockToolExecutor,
      eventBus,
    };

    await executeTurn(makeTurnInput({ sessionId: 'sess-42', turnId: 'turn-7' }), [agentManifest], deps);

    const suspensions = await store.listSuspensions('sess-42');
    expect(suspensions).toHaveLength(1);

    const s = suspensions[0]!;
    expect(s.sessionId).toBe('sess-42');
    expect(s.turnId).toBe('turn-7');
    expect(s.runtimeId).toBe('test-plugin');
    expect(s.pluginId).toBe('test-plugin');
    expect(s.reason).toBe('Waiting for input');
    expect(s.resolvedAt).toBeUndefined();
    // pendingContinuation must include the suspendToolCallId
    expect(s.pendingContinuation.suspendToolCallId).toBe('tc-s1');
  });

  it('should capture partialContent and toolCallsSoFar in pendingContinuation', async () => {
    // First tool call (some-tool), then suspend tool
    mockLLM.setResponses([
      {
        content: null,
        toolCalls: [{ id: 'tc-some-1', name: 'some-tool', arguments: '{}' }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: 'I need to ask the player...',
        toolCalls: [{ id: 'tc-suspend-2', name: 'suspend', arguments: JSON.stringify({ reason: 'Need more info', resumeSchema: {} }) }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 15, outputTokens: 8 },
      },
    ]);

    mockToolExecutor.setToolResult('suspend', {
      toolCallId: 'tc-suspend-2',
      name: 'suspend',
      result: JSON.stringify({ _covelSuspend: true, reason: 'Need more info', resumeSchema: {} }),
      parsedResult: { _covelSuspend: true, reason: 'Need more info', resumeSchema: {} },
      success: true,
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => agentLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: mockToolExecutor,
      eventBus,
    };

    await executeTurn(makeTurnInput(), [agentManifest], deps);

    const suspensions = await store.listSuspensions('sess-1');
    expect(suspensions).toHaveLength(1);
    const s = suspensions[0]!;

    // partialContent should be captured
    expect(s.pendingContinuation.partialContent).toBe('I need to ask the player...');
    // toolCallsSoFar should include the some-tool call
    expect((s.pendingContinuation.toolCallsSoFar as unknown[]).length).toBeGreaterThanOrEqual(1);
    // messages should contain conversation so far
    expect((s.pendingContinuation.messages as unknown[]).length).toBeGreaterThan(0);
  });

  it('should emit turn.suspended SSE event', async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    mockLLM.setResponses([
      {
        content: null,
        toolCalls: [{ id: 'tc-s2', name: 'suspend', arguments: JSON.stringify({ reason: 'SSE test', resumeSchema: {} }) }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ]);

    mockToolExecutor.setToolResult('suspend', {
      toolCallId: 'tc-s2',
      name: 'suspend',
      result: JSON.stringify({ _covelSuspend: true, reason: 'SSE test', resumeSchema: {} }),
      parsedResult: { _covelSuspend: true, reason: 'SSE test', resumeSchema: {} },
      success: true,
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => agentLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: mockToolExecutor,
      eventBus,
    };

    await executeTurn(makeTurnInput(), [agentManifest], deps);

    const suspendedEvent = events.find((e) => e.type === 'turn.suspended');
    expect(suspendedEvent).toBeDefined();
    const payload = suspendedEvent!.payload as Record<string, unknown>;
    expect(payload.reason).toBe('SSE test');
    expect(typeof payload.suspensionId).toBe('string');
  });

  it('flag OFF: sentinel passed back to LLM as normal tool result, no suspension created', async () => {
    process.env['COVEL_SUSPEND_V1'] = '0';

    mockLLM.setResponses([
      {
        content: null,
        toolCalls: [{ id: 'tc-s3', name: 'suspend', arguments: JSON.stringify({ reason: 'flag-off test', resumeSchema: {} }) }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      {
        content: 'Continuing after suspend tool...',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 8 },
      },
    ]);

    mockToolExecutor.setToolResult('suspend', {
      toolCallId: 'tc-s3',
      name: 'suspend',
      result: JSON.stringify(SUSPEND_SENTINEL),
      parsedResult: SUSPEND_SENTINEL,
      success: true,
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => agentLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: mockToolExecutor,
      eventBus,
    };

    const result = await executeTurn(makeTurnInput(), [agentManifest], deps);

    const suspensions = await store.listSuspensions('sess-1');
    expect(suspensions).toHaveLength(0);

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe('success');
  });
});

// ── Function Runtime: suspend via output.status ────────────────────

describe('TurnExecutor — function runtime suspend', () => {
  let store: DataStore;
  let eventBus: EventBus;
  const originalEnv = process.env['COVEL_SUSPEND_V1'];

  beforeEach(async () => {
    process.env['COVEL_SUSPEND_V1'] = '1';
    store = createMemoryStore();
    // Prime history under multiple session IDs that tests exercise.
    for (const sid of ['sess-1', 'sess-fn']) {
      await store.appendTurnMessage({
        id: `prior-player-${sid}`,
        sessionId: sid,
        turnId: 'prior-turn',
        sourceType: 'player',
        role: 'user',
        content: 'prior turn',
        order: 0,
        createdAt: '2024-01-01T00:00:00Z',
      });
    }
    eventBus = createEventBus();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['COVEL_SUSPEND_V1'];
    } else {
      process.env['COVEL_SUSPEND_V1'] = originalEnv;
    }
  });

  it('should persist suspension and return status: suspended when function handler returns suspended status', async () => {
    const manifest = makeFunctionManifest();
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: '',
      references: [],
      handler: async () => ({
        status: 'suspended',
        reason: 'Need user to fill out form',
        resumeSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      }),
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm: { generate: vi.fn().mockResolvedValue({ content: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }) },
      getConfig: () => ({}),
      store,
      eventBus,
    };

    const result = await executeTurn(makeTurnInput({ sessionId: 'sess-fn', turnId: 'turn-fn' }), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    const rr = result.runtimeResults[0]!;
    expect(rr.status).toBe('suspended');
    expect((rr.output as Record<string, unknown>).suspended).toBe(true);

    const suspensions = await store.listSuspensions('sess-fn');
    expect(suspensions).toHaveLength(1);
    expect(suspensions[0]!.reason).toBe('Need user to fill out form');
    expect(suspensions[0]!.runtimeId).toBe('test-plugin');
    // Function runtime: no suspendToolCallId
    expect(suspensions[0]!.pendingContinuation.suspendToolCallId).toBeUndefined();
  });

  it('function runtime: flag OFF should not create suspension', async () => {
    process.env['COVEL_SUSPEND_V1'] = '0';

    const manifest = makeFunctionManifest();
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: '',
      references: [],
      handler: async () => ({
        status: 'suspended',
        reason: 'Should be ignored',
        resumeSchema: {},
      }),
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm: { generate: vi.fn().mockResolvedValue({ content: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }) },
      getConfig: () => ({}),
      store,
      eventBus,
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    const suspensions = await store.listSuspensions('sess-1');
    expect(suspensions).toHaveLength(0);

    // The output goes through as normal success (status field is just output data)
    expect(result.runtimeResults[0]!.status).toBe('success');
  });
});

// ── resumeSuspendedRuntime ────────────────────────────────────────

describe('resumeSuspendedRuntime', () => {
  let mockLLM: MockLLM;
  let mockToolExecutor: MockToolExecutor;
  let store: DataStore;
  let eventBus: EventBus;
  const originalEnv = process.env['COVEL_SUSPEND_V1'];

  beforeEach(async () => {
    process.env['COVEL_SUSPEND_V1'] = '1';
    mockLLM = new MockLLM();
    mockToolExecutor = new MockToolExecutor();
    store = createMemoryStore();
    // Prime history so turnNumber >= 1 (main-loop band for priority-500 runtimes).
    await store.appendTurnMessage({
      id: 'prior-player-0',
      sessionId: 'sess-1',
      turnId: 'prior-turn',
      sourceType: 'player',
      role: 'user',
      content: 'prior turn',
      order: 0,
      createdAt: '2024-01-01T00:00:00Z',
    });
    eventBus = createEventBus();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['COVEL_SUSPEND_V1'];
    } else {
      process.env['COVEL_SUSPEND_V1'] = originalEnv;
    }
  });

  async function createTestSuspension(suspendToolCallId?: string) {
    const id = 'suspension-test-1';
    await store.saveSuspension({
      id,
      sessionId: 'sess-resume',
      turnId: 'turn-resume',
      runtimeId: 'test-plugin',
      pluginId: 'test-plugin',
      reason: 'Test suspension',
      resumeSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      pendingContinuation: {
        messages: [
          { role: 'system', content: 'You are a test agent.' },
          { role: 'user', content: 'Begin' },
        ],
        partialContent: 'Starting to...',
        toolCallsSoFar: [],
        pendingProposals: [],
        suspendToolCallId,
      },
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  it('should complete the LLM loop and return success result', async () => {
    const suspensionId = await createTestSuspension('tc-suspend-x');

    mockLLM.setResponses([
      {
        content: '{"narrativeOutput": "Resume successful!"}',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 8 },
      },
    ]);

    const manifest = makeManifest();
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: '',
      references: [],
    };

    const suspension = await store.getSuspension(suspensionId);
    expect(suspension).toBeDefined();

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: mockToolExecutor,
      eventBus,
    };

    const result = await resumeSuspendedRuntime(suspension!, { name: 'Alice' }, manifest, deps);

    expect(result.status).toBe('success');
    expect((result.output as Record<string, unknown>).narrativeOutput).toBe('Resume successful!');
  });

  it('should mark suspension as resolved after successful resume', async () => {
    const suspensionId = await createTestSuspension('tc-suspend-y');

    mockLLM.setResponses([
      {
        content: 'Done.',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ]);

    const manifest = makeManifest();
    const loaded: LoadedRuntime = { manifest, promptTemplate: '', references: [] };
    const suspension = await store.getSuspension(suspensionId);

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: mockToolExecutor,
      eventBus,
    };

    await resumeSuspendedRuntime(suspension!, { name: 'Bob' }, manifest, deps);

    const resolved = await store.getSuspension(suspensionId);
    expect(resolved!.resolvedAt).toBeDefined();
    expect(typeof resolved!.resolvedAt).toBe('string');
  });

  it('should emit turn.resumed SSE event after resume', async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    const suspensionId = await createTestSuspension('tc-s-z');

    mockLLM.setResponses([
      {
        content: 'Narrative after resume.',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 5 },
      },
    ]);

    const manifest = makeManifest();
    const loaded: LoadedRuntime = { manifest, promptTemplate: '', references: [] };
    const suspension = await store.getSuspension(suspensionId);

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      toolExecutor: mockToolExecutor,
      eventBus,
    };

    await resumeSuspendedRuntime(suspension!, { name: 'Charlie' }, manifest, deps);

    const resumedEvent = events.find((e) => e.type === 'turn.resumed');
    expect(resumedEvent).toBeDefined();
    const payload = resumedEvent!.payload as Record<string, unknown>;
    expect(payload.suspensionId).toBe(suspensionId);
    expect(payload.sessionId).toBe('sess-resume');
  });

  it('should append synthetic tool message for agent runtime (suspendToolCallId set)', async () => {
    const suspensionId = await createTestSuspension('tc-agent-suspend');

    const capturedMessages: unknown[] = [];
    const llm: LLMAdapter = {
      async generate(params) {
        capturedMessages.push(...params.messages);
        return {
          content: 'Resumed agent.',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };

    const manifest = makeManifest();
    const loaded: LoadedRuntime = { manifest, promptTemplate: '', references: [] };
    const suspension = await store.getSuspension(suspensionId);

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm,
      getConfig: () => ({}),
      store,
      eventBus,
    };

    await resumeSuspendedRuntime(suspension!, { name: 'Dave' }, manifest, deps);

    // There should be a tool message with the suspend tool call ID
    const toolMsg = capturedMessages.find(
      (m) => (m as Record<string, unknown>).role === 'tool' &&
              (m as Record<string, unknown>).toolCallId === 'tc-agent-suspend',
    );
    expect(toolMsg).toBeDefined();
    const content = JSON.parse((toolMsg as Record<string, unknown>).content as string) as Record<string, unknown>;
    expect(content.resumeData).toEqual({ name: 'Dave' });
  });

  it('should append user message for function runtime (no suspendToolCallId)', async () => {
    const id = 'suspension-fn-1';
    await store.saveSuspension({
      id,
      sessionId: 'sess-resume',
      turnId: 'turn-resume',
      runtimeId: 'test-plugin',
      pluginId: 'test-plugin',
      reason: 'Function suspend',
      resumeSchema: {},
      pendingContinuation: {
        messages: [{ role: 'system', content: 'system prompt' }],
        toolCallsSoFar: [],
        pendingProposals: [],
        // No suspendToolCallId — function runtime path
      },
      createdAt: new Date().toISOString(),
    });

    const capturedMessages: unknown[] = [];
    const llm: LLMAdapter = {
      async generate(params) {
        capturedMessages.push(...params.messages);
        return {
          content: 'Resumed function.',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };

    const manifest = makeManifest();
    const loaded: LoadedRuntime = { manifest, promptTemplate: '', references: [] };
    const suspension = await store.getSuspension(id);

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm,
      getConfig: () => ({}),
      store,
      eventBus,
    };

    await resumeSuspendedRuntime(suspension!, { answer: 'yes' }, manifest, deps);

    // There should be a user message carrying the resume data
    const userMsg = capturedMessages.find(
      (m) => (m as Record<string, unknown>).role === 'user' &&
              typeof (m as Record<string, unknown>).content === 'string' &&
              ((m as Record<string, unknown>).content as string).includes('answer'),
    );
    expect(userMsg).toBeDefined();
  });

  it('should return failed result if runtime cannot be loaded', async () => {
    const suspensionId = await createTestSuspension();
    const manifest = makeManifest();
    const suspension = await store.getSuspension(suspensionId);

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => undefined,
      llm: mockLLM,
      getConfig: () => ({}),
      store,
      eventBus,
    };

    const result = await resumeSuspendedRuntime(suspension!, { name: 'Eve' }, manifest, deps);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Runtime not found/);
  });
});

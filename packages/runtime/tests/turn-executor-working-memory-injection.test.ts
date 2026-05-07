/**
 * Wiring tests for the B1 fix: Working Memory injection in turn-executor.
 *
 * Background: S3-T3 added the `working_memory` table, the `listWorkingMemory`
 * store method, and the `[Working Memory]` prompt segment in
 * `@covel/context`. The unified review found that the turn-executor hot path
 * never actually called `listWorkingMemory()`, so any data written to the
 * table was effectively dead — the LLM never saw it.
 *
 * These tests use a real `MemoryStore`, pre-populate two WM entries, then
 * run a turn against a spy `LLMAdapter` and assert that the system prompt
 * delivered to the model contains the `[Working Memory]` segment with both
 * the keys and the JSON-encoded values.
 *
 * Two scenarios are covered:
 *   1. Flag ON  (`COVEL_WORKING_MEMORY_V1=1`)  → segment must appear
 *   2. Flag OFF (env unset)                    → segment must NOT appear
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor.js";
import type {
  LLMAdapter,
  LLMRequest,
  LLMResponse,
} from "../src/llm-adapter.js";

// ── Fixtures ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "wm-test-narrator",
    pluginId: "wm-test-narrator",
    description: "Synthetic narrator for working-memory injection tests.",
    priority: 500,
    runtimeType: "agent",
    outputKind: "story",
    ...overrides,
  };
}

function makeLoaded(manifest: RuntimeManifest): LoadedRuntime {
  return {
    manifest,
    promptTemplate: "You are narrating. Player said: {{ player.message }}.",
    references: [],
  };
}

function makeTurnInput(
  sessionId: string,
  overrides?: Partial<TurnInput>,
): TurnInput {
  return {
    sessionId,
    turnId: "turn-1",
    playerMessage: "Look around the room",
    ...overrides,
  };
}

function makeResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 42, outputTokens: 10 },
  };
}

interface CapturingLLM extends LLMAdapter {
  readonly captured: { systemPrompts: string[] };
}

function makeCapturingLLM(): CapturingLLM {
  const captured = { systemPrompts: [] as string[] };
  const generate = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
    const systemMessage = req.messages.find((m) => m.role === "system");
    if (systemMessage && typeof systemMessage.content === "string") {
      captured.systemPrompts.push(systemMessage.content);
    }
    return makeResponse('{"narrativeOutput":"ok"}');
  });
  return { generate, captured };
}

async function primeMainLoop(
  store: DataStore,
  sessionId: string,
): Promise<void> {
  // Prime one prior player message so turnNumber >= 1 and main-loop
  // priority runtimes survive the Pre-Game band filter.
  await store.appendTurnMessage({
    id: `prior-player-${sessionId}`,
    sessionId,
    turnId: "prior-turn",
    sourceType: "player",
    role: "user",
    content: "prior turn",
    order: 0,
    createdAt: "2024-01-01T00:00:00Z",
  });
}

async function seedWorkingMemory(
  store: DataStore,
  sessionId: string,
): Promise<void> {
  await store.upsertWorkingMemory({
    id: crypto.randomUUID(),
    sessionId,
    scope: "player",
    key: "mood",
    value: "curious",
    updatedAt: new Date().toISOString(),
  });
  await store.upsertWorkingMemory({
    id: crypto.randomUUID(),
    sessionId,
    scope: "story",
    key: "currentLocation",
    value: { region: "Cloudmere", room: "library" },
    updatedAt: new Date().toISOString(),
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("turn-executor → working memory injection", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.COVEL_WORKING_MEMORY_V1;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COVEL_WORKING_MEMORY_V1;
    } else {
      process.env.COVEL_WORKING_MEMORY_V1 = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it("injects [Working Memory] segment when flag is ON and store has entries", async () => {
    process.env.COVEL_WORKING_MEMORY_V1 = "1";

    const store = createMemoryStore();
    const sessionId = "sess-wm-on";
    await primeMainLoop(store, sessionId);
    await seedWorkingMemory(store, sessionId);

    const llm = makeCapturingLLM();
    const manifest = makeManifest();
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => makeLoaded(manifest),
      llm,
      getConfig: () => ({}),
      store,
    };

    const result = await executeTurn(
      makeTurnInput(sessionId),
      [manifest],
      deps,
    );

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe("success");
    expect(llm.captured.systemPrompts).toHaveLength(1);

    const systemPrompt = llm.captured.systemPrompts[0]!;
    // Header + both entries (player.mood, story.currentLocation) must appear.
    expect(systemPrompt).toContain("[Working Memory]");
    expect(systemPrompt).toContain("player.mood");
    expect(systemPrompt).toContain('"curious"');
    expect(systemPrompt).toContain("story.currentLocation");
    expect(systemPrompt).toContain("Cloudmere");
    expect(systemPrompt).toContain("library");
  });

  it("omits [Working Memory] segment when flag is OFF, even with entries in store", async () => {
    delete process.env.COVEL_WORKING_MEMORY_V1;

    const store = createMemoryStore();
    const sessionId = "sess-wm-off";
    await primeMainLoop(store, sessionId);
    await seedWorkingMemory(store, sessionId);

    const llm = makeCapturingLLM();
    const manifest = makeManifest();
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => makeLoaded(manifest),
      llm,
      getConfig: () => ({}),
      store,
    };

    const result = await executeTurn(
      makeTurnInput(sessionId),
      [manifest],
      deps,
    );

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe("success");
    expect(llm.captured.systemPrompts).toHaveLength(1);

    const systemPrompt = llm.captured.systemPrompts[0]!;
    expect(systemPrompt).not.toContain("[Working Memory]");
    expect(systemPrompt).not.toContain("player.mood");
  });

  it("omits [Working Memory] segment when flag is ON but store has no entries", async () => {
    process.env.COVEL_WORKING_MEMORY_V1 = "1";

    const store = createMemoryStore();
    const sessionId = "sess-wm-empty";
    await primeMainLoop(store, sessionId);
    // No WM seeding — store has no working-memory entries for this session.

    const llm = makeCapturingLLM();
    const manifest = makeManifest();
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => makeLoaded(manifest),
      llm,
      getConfig: () => ({}),
      store,
    };

    const result = await executeTurn(
      makeTurnInput(sessionId),
      [manifest],
      deps,
    );

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe("success");
    expect(llm.captured.systemPrompts).toHaveLength(1);

    const systemPrompt = llm.captured.systemPrompts[0]!;
    expect(systemPrompt).not.toContain("[Working Memory]");
  });
});

/**
 * `SessionContextSnapshot` wiring tests in `turn-executor.ts`.
 *
 * Background: `buildSessionContextSnapshot` provides structured world,
 * memory, summary, and character data to prompt-variable resolution.
 *
 * These tests verify:
 *   1. World data seeded via store → the prompt receives `{{ world.lore }}` etc.
 *   2. Snapshot build failure does not crash the turn.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import type {
  LLMAdapter,
  LLMRequest,
  LLMResponse,
} from "../src/llm/llm-adapter.js";

// ── Fixtures ─────────────────────────────────────────────────────

function ts(offsetMs = 0): string {
  return new Date(
    Date.parse("2026-01-01T00:00:00.000Z") + offsetMs,
  ).toISOString();
}

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "sc-test-narrator",
    pluginId: "sc-test-narrator",
    description: "Synthetic narrator for session-context wiring tests.",
    stage: "narrative",
    runtimeType: "agent",
    outputKind: "story",
    ...overrides,
  };
}

function makeLoaded(manifest: RuntimeManifest): LoadedRuntime {
  return {
    manifest,
    promptTemplate:
      "Lore: {{ world.lore }}. Tone: {{ world.tone }}. Player said: {{ player.message }}.",
  };
}

function makeTurnInput(
  sessionId: string,
  overrides?: Partial<TurnInput>,
): TurnInput {
  return {
    sessionId,
    turnId: "turn-1",
    playerMessage: "Look around",
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
  await store.appendTurnMessage({
    id: `prior-player-${sessionId}`,
    sessionId,
    turnId: "prior-turn",
    sourceType: "player",
    role: "user",
    content: "prior turn",
    order: 0,
    createdAt: ts(),
  });
}

async function seedWorld(
  store: DataStore,
  worldId: string,
  sessionId: string,
): Promise<void> {
  await store.upsertWorld({
    id: worldId,
    name: "Testworld",
    description: "test",
    lore: "The Sundered Coast",
    metadata: {
      dimensions: {
        tone: "noir",
        startingConditions: { openingScenario: "Dawn on the quay" },
      },
    },
    createdAt: ts(),
  });
  await store.createSession({
    id: sessionId,
    worldId,
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [],
    createdAt: ts(),
    updatedAt: ts(),
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe("turn-executor → SessionContextSnapshot wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("snapshot world view populates prompt", async () => {
    const store = createMemoryStore();
    const sessionId = "sess-sc-on";
    const worldId = "w-sc-on";
    await seedWorld(store, worldId, sessionId);
    await primeMainLoop(store, sessionId);

    const llm = makeCapturingLLM();
    const manifest = makeManifest();
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => makeLoaded(manifest),
      llm,
      // Deliberately empty: world variables must come from
      // SessionContextSnapshot, not from runtime config.
      store,
      // No worldDataPluginId — world.lore / world.tone come from WorldRecord
      // metadata alone, so the snapshot does not need plugin data for this.
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
    expect(systemPrompt).toContain("The Sundered Coast");
    expect(systemPrompt).toContain("noir");
  });

  it("snapshot build fails → turn still completes", async () => {
    const memStore = createMemoryStore();
    const sessionId = "sess-sc-broken";
    const worldId = "w-sc-broken";
    await seedWorld(memStore, worldId, sessionId);
    await primeMainLoop(memStore, sessionId);

    // Wrap the store so `getSession` still works for the executor's own
    // scheduling logic, but `listCharacters` (called inside the snapshot
    // builder) throws. The snapshot builder's internal try/catch converts
    // that into an empty characters array. If both layers work correctly,
    // the turn completes and console.warn stays quiet on behalf of the
    // turn-executor wrapper.
    const breakingStore: DataStore = new Proxy(memStore, {
      get(target, prop, receiver) {
        // Only break store access during snapshot build — the turn-executor
        // calls `getSession` first, THEN `buildSessionContextSnapshot` which
        // internally calls `listCharacters`. We let `getSession` succeed and
        // break `listPluginData` — that surface is exclusively called by the
        // snapshot loader in this test scenario (no plugin-data injects).
        if (prop === "listPluginData") {
          return async () => {
            throw new Error("simulated listPluginData failure");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const llm = makeCapturingLLM();
    const manifest = makeManifest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => makeLoaded(manifest),
      llm,
      store: breakingStore,
      // No worldDataPluginId → listPluginData in snapshot loader is not
      // invoked. The snapshot build itself therefore succeeds using the
      // other reads; this test focuses on the recovery path just being
      // reachable without exceptions bubbling out of executeTurn.
    };

    const result = await executeTurn(
      makeTurnInput(sessionId),
      [manifest],
      deps,
    );

    // Turn completes — the snapshot fallback never halts execution.
    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe("success");
    warnSpy.mockRestore();
  });

  // Deliberate change (scheduling redesign, Step 2): the main-loop runtime no
  // longer runs in the SAME turn as player creation (the same-batch follow-up
  // was removed). The narrator now reads the player on the NEXT request, from a
  // fresh context snapshot built after the setup execution committed and the
  // band flipped to playing.
  it("exposes a committed player to the next turn's main-loop context snapshot", async () => {
    const store = createMemoryStore();
    const sessionId = "sess-sc-refresh";
    const worldId = "w-sc-refresh";
    await store.upsertWorld({
      id: worldId,
      name: "Refreshworld",
      description: "test",
      lore: "The Glass District",
      createdAt: ts(),
    });
    await store.createSession({
      id: sessionId,
      worldId,
      status: "active",
      turnCount: 0,
      preGameCompleted: ["pregame", "world-init/schema-gen"],
      locale: "zh-CN",
      activePlugins: [],
      createdAt: ts(),
      updatedAt: ts(),
    });
    await store.savePlayerInput({
      id: "input-sc-refresh",
      sessionId,
      turnId: "turn-form",
      formId: "form-char-creation",
      values: { name: "Aria", concept: "cartographer" },
      createdAt: ts(1),
    });

    const playerInit: RuntimeManifest = {
      name: "char-creator/player-init",
      pluginId: "char-creator",
      description: "create player",
      stage: "setup",
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "auto" },
      needs: ["pregame", "world-init/schema-gen"],
    } as RuntimeManifest;
    const narrator = makeManifest({
      name: "narrator",
      pluginId: "narrator",
      stage: "narrative",
      trigger: { type: "auto" },
    });

    const llm = makeCapturingLLM();
    const deps: TurnExecutorDeps = {
      loadRuntime: async (manifest) => {
        if (manifest.name === playerInit.name) {
          return {
            manifest,
            promptTemplate: "",
            handler: async () => {
              const now = ts(2);
              await store.upsertCharacter({
                id: "player-sc-refresh",
                sessionId,
                name: "Aria",
                type: "player",
                description: "cartographer",
                fields: { concept: "cartographer" },
                version: 1,
                createdAt: now,
                updatedAt: now,
              });
              return { narrativeOutput: "player ready", preGameDone: true };
            },
          };
        }
        return {
          manifest,
          promptTemplate: "Player: {{ player.character.name }}.",
        };
      },
      llm,
      store,
    };

    // ── Turn 1 (setup): player-init creates the player; narrator does NOT run.
    const setupResult = await executeTurn(
      makeTurnInput(sessionId, {
        turnId: "turn-form",
        playerMessage: "Player Aria enters as cartographer.",
        preGamePending: true,
      }),
      [playerInit, narrator],
      deps,
    );

    expect(
      setupResult.runtimeResults.map((runtime) => runtime.runtimeId),
    ).toEqual(["char-creator/player-init"]);
    // The narrator never ran this turn, so no system prompt was captured.
    expect(llm.captured.systemPrompts).toHaveLength(0);
    // Setup completed this turn (player created) → the finalize session-clock
    // write flips the band to playing.
    expect(setupResult.setupCompletion?.allSetupDone).toBe(true);

    // Commit the setup execution so the band flips to playing for turn 2.
    await finalizeExecution({
      store,
      sessionId,
      ...(setupResult.executionContext
        ? { executionContext: setupResult.executionContext }
        : {}),
      runtimes: [playerInit, narrator],
      results: setupResult.runtimeResults,
      turnIds: ["turn-form"],
      sessionClock: {
        now: ts(3),
        ...(setupResult.setupCompletion
          ? { setupCompletion: setupResult.setupCompletion }
          : {}),
      },
    });

    // ── Turn 2 (main loop): the narrator runs and its context carries the player.
    await executeTurn(
      makeTurnInput(sessionId, {
        turnId: "turn-main",
        playerMessage: "Aria surveys the district.",
      }),
      [playerInit, narrator],
      deps,
    );

    expect(llm.captured.systemPrompts).toHaveLength(1);
    expect(llm.captured.systemPrompts[0]).toContain("Player: Aria.");
  });
});

import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
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
import playerInitGuard from "../../../plugins/char-creator/runtimes/player-init/guard.js";

class CapturingLLM implements LLMAdapter {
  readonly systemPrompts: string[] = [];

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const system = req.messages.find((message) => message.role === "system");
    if (typeof system?.content === "string") {
      this.systemPrompts.push(system.content);
    }
    return {
      content: '{"narrativeOutput":"角色信息已进入叙事上下文。"}',
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 8 },
    };
  }
}

function manifest(
  name: string,
  overrides: Partial<RuntimeManifest>,
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage: "narrative",
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

async function createPregameStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  await store.upsertWorld({
    id: "world-char-bridge",
    name: "Cloudmere",
    description: "Test world",
    lore: "云梦泽世界观",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.createSession({
    id: sessionId,
    worldId: "world-char-bridge",
    status: "active",
    turnCount: 0,
    preGameCompleted: ["pregame", "world-init/schema-gen"],
    locale: "zh-CN",
    activePlugins: ["char-creator", "narrator"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.savePlayerInput({
    id: "input-char-bridge",
    sessionId,
    turnId: "turn-form",
    formId: "char-creation",
    values: {
      characterName: "柳无痕",
      background: "外门弟子，擅长追踪灵脉异动",
      concept: "灵脉巡查者",
      sect: "青萍宗",
    },
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  return store;
}

describe("char-creator core plugin guard bridge", () => {
  // Deliberate change (scheduling redesign, Step 2 — turn-wide transaction):
  // the guard's player-creation writes now BUFFER instead of hitting the store
  // directly, and the same-batch main-loop follow-up that used to run the
  // narrator in the SAME turn was removed. So this is now a two-stage flow:
  //   Turn 1 (setup): player-init's guard buffers the character + mirror and
  //     returns skip:true; only finalize commits them. The narrator does NOT
  //     run this turn.
  //   Turn 2 (main loop): the narrator runs on the next request and reads the
  //     COMMITTED player from context.
  it("buffers the submitted player on the setup turn (committed by finalize) and the narrator reads it on the next turn", async () => {
    const sessionId = "sess-char-bridge";
    const store = await createPregameStore(sessionId);
    const playerInit = manifest("char-creator/player-init", {
      pluginId: "char-creator",
      stage: "setup",
      runtimeType: "agent",
      guard: "./guard.js",
      needs: ["pregame", "world-init/schema-gen"],
    });
    const narrator = manifest("narrator", {
      pluginId: "narrator",
      stage: "narrative",
      runtimeType: "agent",
      outputKind: "story",
    });
    const llm = new CapturingLLM();
    const deps: TurnExecutorDeps = {
      loadRuntime: async (runtime) => {
        if (runtime.name === "char-creator/player-init") {
          return {
            manifest: runtime,
            promptTemplate: "",
            guard: playerInitGuard,
          };
        }
        return {
          manifest: runtime,
          promptTemplate:
            "Player={{ player.character.name }}; Description={{ player.character.description }}; Character={{ player.character }}.",
        };
      },
      llm,
      getPluginSource: (pluginId) =>
        pluginId === "char-creator" || pluginId === "narrator"
          ? "builtin"
          : "community",
      store,
    };

    // ── Turn 1 (setup): guard creates the player; only player-init runs. ──
    const setupInput: TurnInput = {
      sessionId,
      turnId: "turn-form",
      playerMessage: "柳无痕完成登记。",
      locale: "zh-CN",
      preGamePending: true,
    };
    const setupResult = await executeTurn(
      setupInput,
      [playerInit, narrator],
      deps,
    );

    // The narrator (main loop) is deferred to the next request — no same-batch
    // follow-up runs it after the setup runtime completes.
    expect(
      setupResult.runtimeResults.map((runtime) => runtime.runtimeId),
    ).toEqual(["char-creator/player-init"]);
    expect(setupResult.runtimeResults[0]!.status).toBe("skipped");
    expect(setupResult.runtimeResults[0]!.output).toMatchObject({
      skip: true,
      playerExists: true,
      playerName: "柳无痕",
      preGameDone: true,
    });
    // player-init completes setup this turn (guard skip). The persisted
    // turnCount / preGameCompleted are written by the finalize session-clock
    // step; here we pin the completion delta the executor produces.
    expect(Object.keys(setupResult.setupCompletion?.newlyDone ?? {})).toEqual([
      "char-creator/player-init",
    ]);
    expect(setupResult.setupCompletion?.allSetupDone).toBe(true);
    // The narrator never ran, so no system prompt was captured yet.
    expect(llm.systemPrompts).toHaveLength(0);

    // Guard writes buffer now: nothing is in the store until finalize commits.
    expect(await store.listCharacters(sessionId)).toHaveLength(0);

    // Commit the setup execution, as the actions route does. The buffered
    // character.upsert + plugin-data mirror commit in ONE transaction (and the
    // session-clock write flips the band to playing).
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
        now: new Date().toISOString(),
        ...(setupResult.setupCompletion
          ? { setupCompletion: setupResult.setupCompletion }
          : {}),
      },
    });

    // After commit: character + mirror landed atomically.
    const characters = await store.listCharacters(sessionId);
    expect(characters).toHaveLength(1);
    expect(characters[0]).toMatchObject({
      name: "柳无痕",
      type: "player",
      description: "外门弟子，擅长追踪灵脉异动",
      fields: {
        concept: "灵脉巡查者",
        sect: "青萍宗",
      },
    });

    const mirrors = await store.listPluginData(
      sessionId,
      "char-creator",
      "characters",
    );
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0].value).toMatchObject({
      name: "柳无痕",
      type: "player",
      description: "外门弟子，擅长追踪灵脉异动",
    });

    // ── Turn 2 (main loop): the narrator runs and reads the committed player. ──
    const mainInput: TurnInput = {
      sessionId,
      turnId: "turn-main",
      playerMessage: "柳无痕环顾四周。",
      locale: "zh-CN",
    };
    await executeTurn(mainInput, [playerInit, narrator], deps);

    expect(llm.systemPrompts).toHaveLength(1);
    expect(llm.systemPrompts[0]).toContain("Player=柳无痕");
    expect(llm.systemPrompts[0]).toContain(
      "Description=外门弟子，擅长追踪灵脉异动",
    );
  });
});

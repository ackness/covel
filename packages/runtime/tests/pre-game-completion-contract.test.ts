/**
 * Pre-Game completion contract — locks the three signals that can mark a
 * Pre-Game runtime as done: `preGameDone: true`, guard-skipped, and
 * maxTriggerCount exhaustion. Also verifies the band only flips to `playing`
 * (`allSetupDone`) when *all* Pre-Game runtimes in the active set are accounted
 * for.
 *
 * Scheduling redesign: the completion write moved out of `executeTurn` and into
 * the finalize transaction (session-clock write), so the observable contract at
 * the executeTurn boundary is now `TurnResult.setupCompletion` — the delta the
 * executor hands the finalizer — rather than the persisted `turnCount` /
 * `preGameCompleted`. The derivation of those legacy fields from the delta is
 * pinned by the session-clock / acceptance tests instead.
 *
 * This is subtle enough that drift here silently breaks opening flows
 * (player stuck on character form, main-loop never starts), so we pin
 * the behaviour with a dedicated test file.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

class NoopLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function pregameManifest(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage: "setup", // Pre-Game band
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "scheduled", interval: 1 },
    ...overrides,
  } as RuntimeManifest;
}

async function freshStore(
  sessionId: string,
  worldId = "w1",
): Promise<DataStore> {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    worldId,
    turnCount: 0,
    status: "active",
    activePlugins: [],
    preGameCompleted: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return store;
}

async function runPregameTurn(
  sessionId: string,
  manifests: readonly RuntimeManifest[],
  handlers: Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>,
  options?: {
    guards?: Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  },
): Promise<{
  store: DataStore;
  result: Awaited<ReturnType<typeof executeTurn>>;
}> {
  const store = await freshStore(sessionId);
  const input: TurnInput = { sessionId, turnId: "turn-0", playerMessage: "" };
  const deps: TurnExecutorDeps = {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "",
      handler: handlers[m.name],
      guard: options?.guards?.[m.name],
    }),
    llm: new NoopLLM(),
    store,
  };
  const result = await executeTurn(input, manifests, deps);
  return { store, result };
}

/** RuntimeIds newly marked done in this execution's setup-completion delta. */
function newlyDone(result: Awaited<ReturnType<typeof executeTurn>>): string[] {
  return Object.keys(result.setupCompletion?.newlyDone ?? {}).sort();
}

describe("Pre-Game completion contract", () => {
  it("marks a runtime done when output.preGameDone === true", async () => {
    const m = pregameManifest("pregame", { stage: "setup" });
    const { result } = await runPregameTurn("sess-done", [m], {
      pregame: async () => ({
        narrativeOutput: "welcome",
        preGameDone: true,
      }),
    });

    expect(newlyDone(result)).toEqual(["pregame"]);
    // Only Pre-Game runtime present, so everyone's done → band flips to playing.
    expect(result.setupCompletion?.allSetupDone).toBe(true);
  });

  it("marks an AGENT runtime done when its guard returns skip:true", async () => {
    // Guard is only consulted on the agent-runtime code path (function
    // runtimes use a plain handler). schema-gen is agent by default.
    const m = pregameManifest("world-init/schema-gen", {
      stage: "setup",
      runtimeType: "agent",
    });
    const { result } = await runPregameTurn(
      "sess-guard",
      [m],
      {}, // no handler — guard must short-circuit before execution.
      {
        guards: {
          "world-init/schema-gen": async () => ({
            skip: true,
            reason: "already-initialised",
          }),
        },
      },
    );

    expect(newlyDone(result)).toEqual(["world-init/schema-gen"]);
    expect(result.setupCompletion?.allSetupDone).toBe(true);
  });

  it("does NOT advance turnCount when any Pre-Game runtime is unfinished", async () => {
    const pregame = pregameManifest("pregame", { stage: "setup" });
    // player-init simulates "form shown, waiting for submission": handler
    // returns without preGameDone so the framework keeps it open across turns.
    const playerInit = pregameManifest("char-creator/player-init", {
      stage: "setup",
    });

    const { result } = await runPregameTurn(
      "sess-open",
      [pregame, playerInit],
      {
        pregame: async () => ({ preGameDone: true }),
        "char-creator/player-init": async () => ({
          ui: [{ type: "form", interactionId: "char" }],
          // preGameDone intentionally absent — form not yet submitted.
        }),
      },
    );

    // Pregame newly done; player-init NOT — so setup stays incomplete.
    expect(newlyDone(result)).toEqual(["pregame"]);
    expect(result.setupCompletion?.allSetupDone).toBe(false);
  });

  it("keeps bootstrap outside player history while setup is unfinished", async () => {
    const pregame = pregameManifest("pregame", { stage: "setup" });
    const playerInit = pregameManifest("char-creator/player-init", {
      stage: "setup",
    });
    const store = await freshStore("sess-bootstrap");
    const input = {
      sessionId: "sess-bootstrap",
      turnId: "turn-0",
      playerMessage: "",
      suppressPlayerMessage: true,
    };
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async () =>
          m.name === "pregame"
            ? { preGameDone: true }
            : { form: { formId: "character-form" } },
      }),
      llm: new NoopLLM(),
      store,
    };

    const result = await executeTurn(input, [pregame, playerInit], deps);

    const playerMessages = (
      await store.listTurnMessages("sess-bootstrap")
    ).filter((msg) => msg.sourceType === "player");
    expect(playerMessages).toHaveLength(0);
    // Pregame newly done; player-init still awaiting its form → setup pending.
    expect(newlyDone(result)).toEqual(["pregame"]);
    expect(result.setupCompletion?.allSetupDone).toBe(false);
  });

  it("continues pending setup scheduling after player history exists", async () => {
    const pregame = pregameManifest("pregame", { stage: "setup" });
    const playerInit = pregameManifest("char-creator/player-init", {
      stage: "setup",
    });
    const narrator = pregameManifest("narrator", { stage: "narrative" });
    const store = await freshStore("sess-resume");
    await store.updateSession("sess-resume", {
      preGameCompleted: ["pregame"],
      updatedAt: new Date().toISOString(),
    });
    await store.appendTurnMessage({
      id: "prior-player",
      sessionId: "sess-resume",
      turnId: "prior-turn",
      sourceType: "player",
      role: "user",
      content: "saved form values",
      order: 0,
      createdAt: new Date().toISOString(),
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async () => {
          if (m.name === "narrator") {
            return { narrativeOutput: "main loop started" };
          }
          return { preGameDone: true };
        },
      }),
      llm: new NoopLLM(),
      store,
    };

    const result = await executeTurn(
      {
        sessionId: "sess-resume",
        turnId: "turn-1",
        playerMessage: "continue setup",
      },
      [pregame, playerInit, narrator],
      deps,
    );

    // Deliberate change (Step 2): only the setup runtime runs this turn. The
    // narrator (main loop) no longer runs as a same-batch follow-up when
    // player-init completes Pre-Game — it runs on the next request, once the
    // finalize transaction has flipped the band to `playing`.
    expect(result.runtimeResults.map((r) => r.runtimeId)).toEqual([
      "char-creator/player-init",
    ]);
    // pregame already recorded; player-init completes now → last one done.
    expect(newlyDone(result)).toEqual(["char-creator/player-init"]);
    expect(result.setupCompletion?.allSetupDone).toBe(true);
  });

  it("does not mark framework upstream skips as Pre-Game completion", async () => {
    const playerInit = pregameManifest("char-creator/player-init", {
      stage: "setup",
      needs: ["pregame"],
    });

    const { result } = await runPregameTurn(
      "sess-upstream-skip",
      [playerInit],
      {
        "char-creator/player-init": async () => ({ preGameDone: true }),
      },
    );

    expect(result.runtimeResults[0]?.status).toBe("skipped");
    expect(result.runtimeResults[0]?.output).toMatchObject({
      skippedBy: "framework:needs",
    });
    // A framework upstream skip is NOT a Pre-Game completion signal, so nothing
    // is marked done and setup stays incomplete.
    expect(newlyDone(result)).toEqual([]);
    expect(result.setupCompletion?.allSetupDone).toBe(false);
  });

  it("ignores main-loop manual utilities while deciding Pre-Game completion", async () => {
    const pregame = pregameManifest("pregame", { stage: "setup" });
    const playerInit = pregameManifest("char-creator/player-init", {
      stage: "setup",
      // Order comes from declared edges (the conservative legacy chain is
      // gone) — mirror the real plugin, which `needs` pregame.
      needs: ["pregame"],
    });
    const utility = pregameManifest("character-blueprint", {
      stage: undefined,
      trigger: { type: "manual" },
    });

    const { result } = await runPregameTurn(
      "sess-manual-mainloop",
      [pregame, playerInit, utility],
      {
        pregame: async () => ({ preGameDone: true }),
        "char-creator/player-init": async () => ({ preGameDone: true }),
        "character-blueprint": async () => {
          throw new Error("manual utility should not auto-run");
        },
      },
    );

    expect(result.runtimeResults.map((r) => r.runtimeId)).toEqual([
      "pregame",
      "char-creator/player-init",
    ]);
    // The manual utility is ignored; both Pre-Game runtimes are newly done.
    expect(newlyDone(result)).toEqual(
      ["char-creator/player-init", "pregame"].sort(),
    );
    expect(result.setupCompletion?.allSetupDone).toBe(true);
  });

  it("advances turnCount when EVERY Pre-Game runtime reports done in the same turn", async () => {
    // When both plugins complete in turn 0 (e.g. pregame completes on first
    // hit, schema-gen guard skips because schema already exists), the kernel
    // must atomically record both in preGameCompleted AND bump turnCount to 1.
    const pregame = pregameManifest("pregame", { stage: "setup" });
    const playerInit = pregameManifest("char-creator/player-init", {
      stage: "setup",
    });

    const { result } = await runPregameTurn(
      "sess-both",
      [pregame, playerInit],
      {
        pregame: async () => ({ preGameDone: true }),
        "char-creator/player-init": async () => ({ preGameDone: true }),
      },
    );

    expect(newlyDone(result)).toEqual(
      ["char-creator/player-init", "pregame"].sort(),
    );
    // Both complete in the same turn → band flips to playing.
    expect(result.setupCompletion?.allSetupDone).toBe(true);
  });

  it("no longer marks maxTriggerCount-exhausted runtimes done — setup runs by mirror, not message cadence (deliberate change)", async () => {
    // Deliberate change (scheduling redesign): exhausting `maxTriggerCount`
    // never counts a setup runtime as done. Setup scheduling is now governed
    // by the persistent mirror (pending → run) and the ledger-based retry
    // budget (blocked), NOT the message-based trigger count. A prior runtime
    // message therefore no longer suppresses the run — the runtime IS invoked
    // again, and until it reports done it stays pending (heading toward blocked
    // once the ledger budget is exhausted via the finalize settle, which this
    // executeTurn-only harness does not exercise). The old "band-exhausted ⇒
    // advance anyway" (newlyDone=[pregame], allSetupDone=true) is gone.
    const pregame = pregameManifest("pregame", {
      stage: "setup",
      trigger: { type: "scheduled", interval: 1, maxTriggerCount: 1 },
    });

    const store = await freshStore("sess-exh");
    // A prior runtime-sourced message would have blocked re-scheduling under
    // the old message-cadence gate; the mirror-driven gate ignores it.
    await store.appendTurnMessage({
      id: "prior",
      sessionId: "sess-exh",
      turnId: "turn--1",
      sourceType: "runtime",
      sourcePluginId: "pregame",
      sourceRuntimeId: "pregame",
      role: "assistant",
      content: "prior pregame output",
      order: 10,
      createdAt: new Date().toISOString(),
    });

    let invoked = 0;
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        // Runs but does not report done → stays pending, never marked done.
        handler: async () => {
          invoked += 1;
          return {};
        },
      }),
      llm: new NoopLLM(),
      store,
    };
    const result = await executeTurn(
      { sessionId: "sess-exh", turnId: "turn-0", playerMessage: "" },
      [pregame],
      deps,
    );

    // The runtime IS re-invoked (mirror-driven scheduling ignores the message
    // count), and it is NOT marked done — setup stays incomplete.
    expect(invoked).toBe(1);
    expect(newlyDone(result)).toEqual([]);
    expect(result.setupCompletion?.allSetupDone).toBe(false);
  });
});

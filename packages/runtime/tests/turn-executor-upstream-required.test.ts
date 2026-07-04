/**
 * manifest.upstreamRequired — skip downstream runtimes when a declared
 * upstream failed in the same turn.
 *
 * Without this safeguard, plugins like `guide`/`codex` that inject
 * `<narrator-output>` would still run when `narrator` failed, feeding the
 * LLM an empty inject block and producing hallucinated guidance or codex
 * entries. The framework now short-circuits to `status: 'skipped'` before the
 * guard / LLM pipeline for any runtime whose upstream reported
 * `status !== 'success'` in `completedResults`.
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

async function mainLoopStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  // Seed a prior player message so turnNumber >= 1 (main-loop band).
  await store.appendTurnMessage({
    id: "seed",
    sessionId,
    turnId: "seed-turn",
    sourceType: "player",
    role: "user",
    content: "prior",
    order: 0,
    createdAt: "2024-01-01T00:00:00Z",
  });
  return store;
}

function manifest(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    priority: 500,
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

async function runTurn(
  manifests: readonly RuntimeManifest[],
  handlers: Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>,
): Promise<Awaited<ReturnType<typeof executeTurn>>> {
  const input: TurnInput = {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "x",
  };
  const deps: TurnExecutorDeps = {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "",
      handler: handlers[m.name],
    }),
    llm: new NoopLLM(),
    getConfig: () => ({}),
    store: await mainLoopStore("sess-1"),
  };
  return executeTurn(input, manifests, deps);
}

describe("executeTurn: manifest.upstreamRequired", () => {
  it("skips a downstream runtime when its declared upstream failed", async () => {
    const upstream = manifest("narrator", { priority: 500 });
    const downstream = manifest("guide", {
      priority: 550,
      upstreamRequired: ["narrator"],
    });

    const result = await runTurn([upstream, downstream], {
      // Narrator handler throws → produces a failed RuntimeResult.
      narrator: async () => {
        throw new Error("llm provider exploded");
      },
      // Should never be called because the framework skips first.
      guide: async () => {
        throw new Error("downstream should not have executed");
      },
    });

    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get("narrator")?.status).toBe("failed");
    expect(byId.get("guide")?.status).toBe("skipped");

    const skipOutput = byId.get("guide")?.output as {
      reason?: string;
      skippedBy?: string;
    } | null;
    expect(skipOutput?.reason).toMatch(/upstream/i);
  });

  it("still runs a downstream when the upstream succeeded", async () => {
    const upstream = manifest("narrator", { priority: 500 });
    const downstream = manifest("guide", {
      priority: 550,
      upstreamRequired: ["narrator"],
    });

    let downstreamRan = false;
    const result = await runTurn([upstream, downstream], {
      narrator: async () => ({ narrativeOutput: "ok" }),
      guide: async () => {
        downstreamRan = true;
        return { ok: true };
      },
    });

    expect(downstreamRan).toBe(true);
    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get("narrator")?.status).toBe("success");
    expect(byId.get("guide")?.status).toBe("success");
  });

  it("treats a guard-skipped initialization upstream as satisfied", async () => {
    const upstream = manifest("world-init/schema-gen", {
      priority: 100,
      runtimeType: "agent",
      guard: "./guard.js",
    });
    const downstream = manifest("char-creator/player-init", {
      priority: 150,
      upstreamRequired: ["world-init/schema-gen"],
    });
    let downstreamRan = false;
    const input: TurnInput = {
      sessionId: "sess-1",
      turnId: "turn-1",
      playerMessage: "x",
    };
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        ...(m.name === "world-init/schema-gen"
          ? {
              guard: async () => ({
                skip: true,
                initialized: true,
                preGameDone: true,
              }),
            }
          : {}),
        ...(m.name === "char-creator/player-init"
          ? {
              handler: async () => {
                downstreamRan = true;
                return { ok: true };
              },
            }
          : {}),
      }),
      llm: new NoopLLM(),
      getConfig: () => ({}),
      store: await mainLoopStore("sess-1"),
    };

    const result = await executeTurn(input, [upstream, downstream], deps);

    expect(downstreamRan).toBe(true);
    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get("world-init/schema-gen")?.status).toBe("skipped");
    expect(byId.get("char-creator/player-init")?.status).toBe("success");
  });

  it("skips when ANY declared upstream is missing (not scheduled)", async () => {
    // narrator is declared as required but not in the activeRuntimes
    // list (e.g. disabled for this session). Framework must still skip
    // rather than treating "absent upstream" as success.
    const downstream = manifest("guide", {
      priority: 550,
      upstreamRequired: ["narrator"],
    });

    const result = await runTurn([downstream], {
      guide: async () => {
        throw new Error("should not run");
      },
    });

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe("skipped");
  });

  it("requires ALL listed upstreams to succeed (not any)", async () => {
    const a = manifest("narrator", { priority: 500 });
    const b = manifest("npc-graph/rag-retriever", { priority: 490 });
    const downstream = manifest("guide", {
      priority: 550,
      upstreamRequired: ["narrator", "npc-graph/rag-retriever"],
    });

    const result = await runTurn([a, b, downstream], {
      narrator: async () => ({ narrativeOutput: "ok" }),
      "npc-graph/rag-retriever": async () => {
        throw new Error("retriever blew up");
      },
      guide: async () => {
        throw new Error("downstream should not have executed");
      },
    });

    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get("guide")?.status).toBe("skipped");
  });
});

describe("executeTurn: capability-based upstreamRequired", () => {
  it("runs when an in-scope capability provider succeeded — discovered by capability, not name", async () => {
    // The downstream never names chat-mode-narrator; it gates on the
    // `narrative-engine` capability, which chat-mode-narrator declares. This is
    // what lets the same guidance plugin work under either narrative engine.
    const engine = manifest("chat-mode-narrator", {
      priority: 500,
      capabilities: ["narrative-engine"],
    });
    const downstream = manifest("guide", {
      priority: 600,
      upstreamRequired: [{ capability: "narrative-engine" }],
    });

    let ran = false;
    const result = await runTurn([engine, downstream], {
      "chat-mode-narrator": async () => ({ narrativeOutput: "ok" }),
      guide: async () => {
        ran = true;
        return { ok: true };
      },
    });

    expect(ran).toBe(true);
    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get("guide")?.status).toBe("success");
  });

  it("skips when the in-scope capability provider failed", async () => {
    const engine = manifest("narrator", {
      priority: 500,
      capabilities: ["narrative-engine"],
    });
    const downstream = manifest("guide", {
      priority: 600,
      upstreamRequired: [{ capability: "narrative-engine" }],
    });

    const result = await runTurn([engine, downstream], {
      narrator: async () => {
        throw new Error("engine exploded");
      },
      guide: async () => {
        throw new Error("downstream should not have executed");
      },
    });

    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get("narrator")?.status).toBe("failed");
    expect(byId.get("guide")?.status).toBe("skipped");
  });

  it("skips when no in-scope runtime provides the capability", async () => {
    // A guidance runtime with no narrative engine active has nothing to act on.
    const downstream = manifest("guide", {
      priority: 600,
      upstreamRequired: [{ capability: "narrative-engine" }],
    });

    const result = await runTurn([downstream], {
      guide: async () => {
        throw new Error("downstream should not have executed");
      },
    });

    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get("guide")?.status).toBe("skipped");
  });
});

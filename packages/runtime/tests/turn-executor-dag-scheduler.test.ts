/**
 * turn-executor DAG scheduler integration — verifies that the main-loop
 * band always uses the DAG scheduler (no feature flag) and that same-level
 * downstreams really run concurrently instead of being serialised by
 * priority number.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
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
  priority: number,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage:
      priority <= 99
        ? "setup"
        : priority <= 499
          ? "pre-turn"
          : priority === 500
            ? "narrative"
            : priority <= 999
              ? "post-turn"
              : "audit",
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

describe("executeTurn main-loop DAG scheduler", () => {
  it("runs independent narrator downstreams concurrently", async () => {
    // narrator, then guide + extractor + codex + char-tracker in parallel (all
    // depend only on narrator). Without the DAG scheduler they would execute
    // strictly in priority order. Each downstream handler holds until all four
    // have started, so the order of events proves the overlap. No elapsed time
    // is measured: a bound on it fails on a loaded machine. A scheduler that
    // ran them one at a time would never release the first one, and the test
    // would time out.
    const narrator = manifest("narrator", 500);
    const guide = manifest("guide", 550, {
      input: {
        inject: [
          {
            kind: "runtime",
            from: "narrator",
            field: "narrativeOutput",
            as: "<n>",
          },
        ],
      },
    } as Partial<RuntimeManifest>);
    const extractor = manifest("npc-graph/extractor", 620, {
      input: {
        inject: [
          {
            kind: "runtime",
            from: "narrator",
            field: "narrativeOutput",
            as: "<n>",
          },
        ],
      },
    } as Partial<RuntimeManifest>);
    const codex = manifest("codex", 650, {
      input: {
        inject: [
          {
            kind: "runtime",
            from: "narrator",
            field: "narrativeOutput",
            as: "<n>",
          },
        ],
      },
    } as Partial<RuntimeManifest>);
    const charTracker = manifest("char-creator/character-tracker", 750, {
      input: {
        inject: [
          {
            kind: "runtime",
            from: "narrator",
            field: "narrativeOutput",
            as: "<n>",
          },
        ],
      },
    } as Partial<RuntimeManifest>);

    const downstreams = [
      "guide",
      "npc-graph/extractor",
      "codex",
      "char-creator/character-tracker",
    ];
    const events: string[] = [];
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    const makeHandler = (name: string) => async () => {
      events.push(`start:${name}`);
      if (downstreams.includes(name)) {
        if (++started === downstreams.length) release();
        await allStarted;
      } else {
        // The narrator stays open across one turn of the event loop. A
        // scheduler that started the downstreams beside it would then log
        // their starts before its end; a narrator that returns at once ends
        // first under any scheduler.
        await new Promise((resolve) => setImmediate(resolve));
      }
      events.push(`end:${name}`);
      return { outcome: "success", value: { narrativeOutput: "x" } } as const;
    };

    const input: TurnInput = {
      sessionId: "sess-dag",
      turnId: "turn-1",
      playerMessage: "go",
    };
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: makeHandler(m.name),
      }),
      llm: new NoopLLM(),
      store: await mainLoopStore("sess-dag"),
    };

    const result = await executeTurn(
      input,
      [narrator, guide, extractor, codex, charTracker],
      deps,
    );

    // All runtimes must have completed.
    expect(result.runtimeResults.every((r) => r.status === "success")).toBe(
      true,
    );

    const at = (event: string) => {
      const index = events.indexOf(event);
      expect(index, event).toBeGreaterThanOrEqual(0);
      return index;
    };
    const firstDownstreamEnd = Math.min(
      ...downstreams.map((name) => at(`end:${name}`)),
    );
    for (const name of downstreams) {
      // Narrator finished before any downstream started.
      expect(at(`start:${name}`)).toBeGreaterThan(at("end:narrator"));
      // Every downstream had started before the first one finished.
      expect(at(`start:${name}`)).toBeLessThan(firstDownstreamEnd);
    }
  });
});

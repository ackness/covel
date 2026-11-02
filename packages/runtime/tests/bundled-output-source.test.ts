import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { tool, withModelView } from "@covel/tools";
import {
  discoverPluginAt,
  loadPluginDefinition,
  loadRuntime,
} from "@covel/plugin-loader";
import {
  makeExecutor,
  queuedLLM,
  runLoop,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

it.each([
  [
    "world-time",
    "world-time/advance",
    {
      tick: 2,
      summary: {
        display: "Evening",
        unit: "minute",
        elapsedSinceStart: 2,
        elapsedThisTurn: 1,
      },
    },
  ],
  [
    "world-ir",
    "world-ir",
    {
      schemaVersion: 1,
      summary: "Rain stopped.",
      entities: [],
      relations: [],
      events: [],
      statements: [],
    },
  ],
  [
    "world-init",
    "world-init/schema-gen",
    {
      success: true,
      preGameDone: true,
      attributeCount: 0,
      dimensionCount: 0,
      worldSchema: { types: [], attributes: [] },
    },
  ],
  ["story-events", "story-events/plot", { events: [] }],
  [
    "guide",
    "guide",
    {
      scene: "Pier",
      recap: "Rain stopped.",
      decision: "Where next?",
      prompts: [{ text: "Wait" }, { text: "Ask" }, { text: "Leave" }],
    },
  ],
] as const)(
  "%s finishes with {} and keeps the canonical public result",
  async (plugin, runtimeId, canonical) => {
    const discovery = await discoverPluginAt(
      path.resolve(import.meta.dirname, "../../../plugins", plugin),
    );
    const definition = await loadPluginDefinition(discovery!);
    const loaded = await loadRuntime(
      discovery!,
      runtimeId,
      "en-US",
      definition,
    );
    const source = loaded.manifest.output?.from?.tool;
    expect(source).toBeDefined();
    const business = tool({
      name: source!,
      description: "Canonical business result",
      parameters: z.object({}),
      execute: async () =>
        withModelView(canonical, {
          summary: "Done",
          data: { wrapper: canonical },
        }),
    });
    const llm = queuedLLM([
      toolCall(source!, {}, "work"),
      toolCall("submit-output", {}, "submit"),
    ]);
    const result = await runLoop({
      llm,
      manifest: loaded.manifest,
      loaded,
      deps: { toolExecutor: makeExecutor([business]) },
    });
    expect(result.stop.reason).toBe("completed");
    expect(result.acceptedOutput).toEqual(canonical);
    expect(result.executedToolCalls).toHaveLength(1);
    expect(llm.requests).toHaveLength(2);
  },
);

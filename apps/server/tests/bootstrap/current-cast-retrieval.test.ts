import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { executeTurn } from "@covel/runtime";
import { createMemoryStore } from "@covel/store";

// Exercise the actual bundled manifests, schema loader, stage scheduler,
// function contexts and input bindings, without a provider or early commit.
it("passes this turn's cast to graph retrieval while its stored cast is still uncommitted", async () => {
  const discoveries = await discoverPlugins(
    path.resolve(import.meta.dirname, "../../../../plugins"),
  );
  const byId = new Map(discoveries.map((d) => [d.id, d]));
  const cast = (await loadPluginManifest(byId.get("scene-cast")!))[0].manifest;
  const graph = (await loadPluginManifest(byId.get("npc-graph")!)).find(
    (p) => p.manifest.name === "npc-graph/rag-retriever",
  )!.manifest;
  const store = createMemoryStore();
  const sessionId = "cast-integration";
  await store.upsertCharacter({
    id: "character-alice",
    sessionId,
    name: "Alice",
    type: "npc",
    description: "Merchant",
    fields: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  await store.appendTurnMessage({
    id: "prior",
    sessionId,
    turnId: "previous-turn",
    sourceType: "player",
    role: "user",
    content: "Alice arrived.",
    order: 0,
    createdAt: "2026-01-01T00:00:00Z",
  });
  const seed = async (namespace: string, key: string, value: unknown) =>
    store.setPluginData({
      id: `${namespace}-${key}`,
      sessionId,
      pluginId: "npc-graph",
      namespace,
      key,
      value,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  await seed("nodes", "graph-alice", {
    id: "graph-alice",
    name: "Alice",
    type: "individual",
  });
  await seed("nodes", "graph-bob", {
    id: "graph-bob",
    name: "Bob",
    type: "individual",
  });
  await seed("edges", "promise", {
    id: "promise",
    source: "graph-alice",
    target: "graph-bob",
    relation: "PROMISED",
    fact: "Alice promised to return Bob's book.",
    validAt: 1,
  });
  await seed("index", "by-source:graph-alice", ["promise"]);
  const generate = vi.fn();
  const result = await executeTurn(
    {
      sessionId,
      turnId: "current-turn",
      playerMessage: "Ask her about the promise.",
    },
    [graph, cast],
    {
      store,
      getPluginSource: () => "builtin",
      llm: { generate },
      loadRuntime: (manifest) =>
        loadRuntime(byId.get(manifest.pluginId)!, manifest.name),
    },
  );
  expect(result.runtimeResults.map((r) => [r.runtimeId, r.status])).toEqual([
    ["scene-cast", "success"],
    ["npc-graph/rag-retriever", "success"],
  ]);
  expect(result.runtimeResults[0]?.output?.speakers).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "Alice" })]),
  );
  const retrieved = result.runtimeResults.find(
    (r) => r.runtimeId === graph.name,
  );
  expect(retrieved?.output).not.toHaveProperty("error");
  expect(retrieved?.output?.npcContext).toContain("return Bob's book");
  expect(
    await store.getPluginData(
      sessionId,
      "scene-cast",
      "active-cast",
      "current",
    ),
  ).toBeNull();
  expect(generate).not.toHaveBeenCalled();
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSqliteStore } from "@covel/store";
import { createCommitPipeline } from "@covel/runtime";
import createGraphTool from "../../../../plugins/npc-graph/tools/upsert-npc-graph.js";

const context = {
  sessionId: "restart",
  pluginId: "npc-graph",
  runtimeId: "npc-graph/extractor",
  turnId: "before",
  turnNumber: 1,
};
const node = (name: string) => ({
  name,
  type: "individual",
  summary: `Stored profile for ${name}`,
});

describe("graph identity across SQLite and allocator restarts", () => {
  it("preserves old nodes and edge endpoints when new and existing names share a batch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "covel-graph-restart-"));
    let store = createSqliteStore(path.join(root, "session.sqlite"));
    try {
      const now = new Date().toISOString();
      await store.createSession({
        id: context.sessionId,
        worldId: null,
        phase: "playing",
        status: "active",
        completedPlayerTurns: 1,
        activePlugins: [context.pluginId],
        setupRuntimes: {},
        createdAt: now,
        updatedAt: now,
      });
      for (const [key, name] of [
        ["npc-1", "神代澪"],
        ["npc-2", "轻音部"],
      ]) {
        await store.setPluginData({
          id: key!,
          sessionId: context.sessionId,
          pluginId: context.pluginId,
          namespace: "nodes",
          key: key!,
          value: {
            ...node(name!),
            id: key,
            firstSeenTurn: 1,
            lastSeenTurn: 1,
            attributes: { original: true },
          },
          createdAt: now,
          updatedAt: now,
        });
      }
      const toolkit = await import("@covel/tools");
      const before = createGraphTool({ ...toolkit, store });
      const first = await before.execute(
        {
          nodes: [node("新闻部")],
          edges: [
            {
              sourceName: "神代澪",
              targetName: "轻音部",
              relation: "JOINS",
              strength: 1,
              fact: "神代澪是轻音部的一名成员。",
            },
          ],
        },
        context,
      );
      const firstCommit = await createCommitPipeline(store).commitAll(
        toolkit.getPendingProposals(first),
      );
      expect(firstCommit.every((result) => result.committed)).toBe(true);
      const oldNodes = await store.listPluginData(
        context.sessionId,
        context.pluginId,
        "nodes",
      );
      const oldEdges = await store.listPluginData(
        context.sessionId,
        context.pluginId,
        "edges",
      );
      await store.close();
      vi.resetModules();
      store = createSqliteStore(path.join(root, "session.sqlite"));
      const freshToolkit = await import("@covel/tools");
      const after = createGraphTool({ ...freshToolkit, store });
      const second = await after.execute(
        {
          nodes: [
            node("椎名夏帆"),
            { ...node("轻音部"), summary: "Updated club summary" },
          ],
        },
        { ...context, turnId: "after", turnNumber: 2 },
      );
      const committed = await createCommitPipeline(store).commitAll(
        freshToolkit.getPendingProposals(second),
      );
      expect(committed.every((result) => result.committed)).toBe(true);
      const nodes = await store.listPluginData(
        context.sessionId,
        context.pluginId,
        "nodes",
      );
      expect(nodes).toHaveLength(oldNodes.length + 1);
      for (const old of oldNodes.filter((row) => row.key !== "npc-2")) {
        expect(nodes.find((row) => row.key === old.key)?.value).toEqual(
          old.value,
        );
      }
      expect(nodes.find((row) => row.key === "npc-2")?.value).toMatchObject({
        name: "轻音部",
        firstSeenTurn: 1,
        attributes: { original: true },
      });
      expect(nodes.some((row) => row.value.name === "椎名夏帆")).toBe(true);
      expect(
        await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "edges",
        ),
      ).toEqual(oldEdges);

      const colliding = createGraphTool({
        ...freshToolkit,
        store,
        shortIdBatch: () => ["npc-1"],
      });
      await expect(
        colliding.execute({ nodes: [node("新角色")] }, context),
      ).rejects.toThrow("ID collision");
      expect(
        await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "nodes",
        ),
      ).toEqual(nodes);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

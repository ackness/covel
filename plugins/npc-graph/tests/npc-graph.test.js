/**
 * npc-graph plugin tests.
 *
 * Covered:
 *  1. Plugin manifest discovery & parsing
 *  2. upsert-npc-graph creates new nodes with short IDs
 *  3. Second upsert on the same name merges instead of duplicating
 *  4. Edges resolve sourceName/targetName to node IDs
 *  5. Duplicate edges (same source/target/relation) are skipped
 *  6. Adjacency index `by-source` / `by-target` is maintained
 *  7. list-npc-graph returns compact summaries
 *  8. Orphan-endpoint edges are flagged, not crashed
 */

import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";
import { getPendingProposals, tool, z, shortIdBatch } from "@covel/tools";
import createUpsertNpcGraph from "../tools/upsert-npc-graph.js";
import createListNpcGraph from "../tools/list-npc-graph.js";

// ── Minimal plugin_data mock store ────────────────────────────────

function createMockStore() {
  /** @type {Map<string, any>} */
  const data = new Map();
  const makeKey = (sid, pid, ns, k) => `${sid}:${pid}:${ns}:${k}`;

  return {
    data,
    async setPluginData(record) {
      data.set(
        makeKey(
          record.sessionId,
          record.pluginId,
          record.namespace,
          record.key,
        ),
        {
          namespace: record.namespace,
          key: record.key,
          value: record.value,
          updatedAt: record.updatedAt,
        },
      );
    },
    async setPluginDataBatch(records) {
      for (const r of records) await this.setPluginData(r);
    },
    async getPluginData(sessionId, pluginId, namespace, key) {
      return data.get(makeKey(sessionId, pluginId, namespace, key)) ?? null;
    },
    async listPluginData(sessionId, pluginId, namespace) {
      const prefix = namespace
        ? `${sessionId}:${pluginId}:${namespace}:`
        : `${sessionId}:${pluginId}:`;
      const results = [];
      for (const [k, v] of data) {
        if (k.startsWith(prefix)) results.push(v);
      }
      return results;
    },
  };
}

async function applyPendingPluginData(result, store) {
  for (const proposal of getPendingProposals(result)) {
    if (proposal.type !== "plugin.data.batch") continue;
    await store.setPluginDataBatch(
      proposal.payload.items.map((item, index) => ({
        id: `${proposal.id}:${index}`,
        sessionId: proposal.sessionId,
        pluginId: proposal.source.pluginId,
        namespace: item.namespace,
        key: item.key,
        value: item.value,
        createdAt: proposal.timestamp,
        updatedAt: proposal.timestamp,
      })),
    );
  }
}

async function executeAndCommit(toolModule, params, context, store) {
  const result = await toolModule.execute(params, context);
  await applyPendingPluginData(result, store);
  return result;
}

const ctx = {
  sessionId: "sess-npc",
  turnId: "turn-3",
  pluginId: "npc-graph",
  runtimeId: "npc-graph",
};

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

// ── Manifest discovery ──────────────────────────────────────────

describe("npc-graph manifests", () => {
  /** @type {import('@covel/shared').RuntimeManifest[]} */
  let manifests;

  beforeEach(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const discovery = discoveries.find((d) => d.id === "npc-graph");
    expect(discovery).toBeDefined();
    const parsed = await loadPluginManifest(discovery);
    manifests = parsed.map((p) => p.manifest);
  });

  it("discovers both extractor and rag-retriever runtimes", () => {
    const names = manifests.map((m) => m.name);
    expect(names).toContain("npc-graph/extractor");
    expect(names).toContain("npc-graph/rag-retriever");
  });

  it("extractor declares the expected metadata", () => {
    const extractor = manifests.find((m) => m.name === "npc-graph/extractor");
    expect(extractor).toBeDefined();
    expect(extractor.pluginType).toBe("plugin");
    // Narrator-downstream layer — shares priority 600 with guide, codex,
    // and character-tracker. The scheduler runs all four in parallel.
    expect(extractor.priority).toBe(600);
    expect(extractor.capabilities).toContain("npc-graph");
    expect(extractor.tools?.plugin).toContain("upsert-npc-graph");
    expect(extractor.tools?.plugin).toContain("list-npc-graph");
    expect(extractor.trigger?.type).toBe("scheduled");
    expect(extractor.trigger?.interval).toBe(1);
    // Main-loop band membership is enforced by priority >= 100 server-side;
    // manifest no longer carries a `trigger.phases` field.
    expect(extractor.priority).toBeGreaterThanOrEqual(100);
  });

  it("rag-retriever is a function runtime that runs before narrator", () => {
    const retriever = manifests.find(
      (m) => m.name === "npc-graph/rag-retriever",
    );
    expect(retriever).toBeDefined();
    expect(retriever.runtimeType).toBe("function");
    expect(retriever.handler).toBe("./handler.js");
    // Narrator-prep layer — runs before narrator (500).
    expect(retriever.priority).toBe(400);
    expect(retriever.capabilities).toContain("graph-rag");
    // Main-loop band membership enforced by priority >= 100 server-side.
    expect(retriever.priority).toBeGreaterThanOrEqual(100);
  });
});

// ── Tool behaviour ──────────────────────────────────────────────

describe("upsert-npc-graph", () => {
  let store;
  let upsertTool;
  let listTool;

  beforeEach(() => {
    store = createMockStore();
    upsertTool = createUpsertNpcGraph({ tool, z, shortIdBatch, store });
    listTool = createListNpcGraph({ tool, z, store });
  });

  it("creates new nodes with short IDs and persists them", async () => {
    const result = await executeAndCommit(
      upsertTool,
      {
        nodes: [
          {
            name: "萧衍笙",
            type: "individual",
            labels: ["sect-leader"],
            summary: "碧波宗宗主，云梦泽修为最高者，金丹九层。",
          },
          {
            name: "碧波宗",
            type: "faction",
            labels: ["sect"],
            summary: "云梦泽最大的宗门，占据一等灵脉碧波灵渊。",
          },
        ],
      },
      ctx,
      store,
    );

    expect(result.nodes.created).toBe(2);
    expect(result.nodes.updated).toBe(0);
    expect(result.nodes.results).toHaveLength(2);
    for (const r of result.nodes.results) {
      expect(r.id).toMatch(/^npc-/);
    }

    const list = await listTool.execute({}, ctx);
    expect(list.nodeCount).toBe(2);
    expect(list.nodes.map((n) => n.name).sort()).toEqual(
      ["萧衍笙", "碧波宗"].sort(),
    );
  });

  it("merges when a node with the same name is upserted twice", async () => {
    await executeAndCommit(
      upsertTool,
      {
        nodes: [
          { name: "陆沉渊", type: "individual", summary: "青萍宗宗主。" },
        ],
      },
      ctx,
      store,
    );
    const second = await executeAndCommit(
      upsertTool,
      {
        nodes: [
          {
            name: "陆沉渊",
            type: "individual",
            labels: ["sect-leader", "researcher"],
            summary: "青萍宗宗主，据说正在研究一种古老的阵法。",
            attributes: { suspected: true },
          },
        ],
      },
      ctx,
      store,
    );

    expect(second.nodes.created).toBe(0);
    expect(second.nodes.updated).toBe(1);

    const list = await listTool.execute({}, ctx);
    expect(list.nodeCount).toBe(1);
    expect(list.nodes[0].labels).toEqual(["sect-leader", "researcher"]);
    expect(list.nodes[0].summary).toMatch(/古老的阵法/);
  });

  it("resolves edge sourceName/targetName to node IDs and persists the adjacency index", async () => {
    const out = await executeAndCommit(
      upsertTool,
      {
        nodes: [
          { name: "萧衍笙", type: "individual", summary: "碧波宗宗主。" },
          { name: "陆沉渊", type: "individual", summary: "青萍宗宗主。" },
        ],
        edges: [
          {
            sourceName: "萧衍笙",
            targetName: "陆沉渊",
            relation: "COMPETES_WITH",
            strength: -0.3,
            fact: "萧衍笙长期视陆沉渊为潜在竞争者，在公开场合保持表面客套。",
          },
        ],
      },
      ctx,
      store,
    );

    expect(out.nodes.created).toBe(2);
    expect(out.edges.created).toBe(1);
    const edgeRow = out.edges.results[0];
    expect(edgeRow.id).toMatch(/^edge-/);

    // Adjacency index must include the new edge
    const bySource = await store.getPluginData(
      ctx.sessionId,
      ctx.pluginId,
      "index",
      `by-source:${edgeRow.source}`,
    );
    const byTarget = await store.getPluginData(
      ctx.sessionId,
      ctx.pluginId,
      "index",
      `by-target:${edgeRow.target}`,
    );
    expect(bySource?.value).toContain(edgeRow.id);
    expect(byTarget?.value).toContain(edgeRow.id);
  });

  it("skips duplicate edges (same source, target, relation)", async () => {
    await executeAndCommit(
      upsertTool,
      {
        nodes: [
          {
            name: "A",
            type: "individual",
            summary: "First character placeholder.",
          },
          {
            name: "B",
            type: "individual",
            summary: "Second character placeholder.",
          },
        ],
        edges: [
          {
            sourceName: "A",
            targetName: "B",
            relation: "TRUSTS",
            strength: 0.5,
            fact: "A initially trusted B after a shared ordeal in the bamboo grove.",
          },
        ],
      },
      ctx,
      store,
    );

    const dup = await executeAndCommit(
      upsertTool,
      {
        edges: [
          {
            sourceName: "A",
            targetName: "B",
            relation: "TRUSTS",
            strength: 0.9,
            fact: "Another phrasing of the same trust relationship — should be dropped.",
          },
        ],
      },
      ctx,
      store,
    );

    expect(dup.edges.created).toBe(0);
    expect(dup.edges.skipped).toBe(1);
    expect(dup.edges.results[0].skipped).toBe("duplicate relation");
  });

  it("flags edges whose endpoint node cannot be resolved", async () => {
    const out = await executeAndCommit(
      upsertTool,
      {
        edges: [
          {
            sourceName: "Ghost",
            targetName: "Phantom",
            relation: "KNOWS_ABOUT",
            strength: 0.1,
            fact: "Ghost has heard rumours about Phantom but both are unknown to the graph.",
          },
        ],
      },
      ctx,
      store,
    );
    expect(out.edges.created).toBe(0);
    expect(out.edges.skipped).toBe(1);
    expect(out.edges.results[0].skipped).toBe("missing endpoint node");
  });
});

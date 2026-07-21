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

  it("keeps an existing lastSeenTurn when a re-upsert carries no turnNumber", async () => {
    const seeded = await executeAndCommit(
      upsertTool,
      {
        nodes: [
          { name: "陆沉渊", type: "individual", summary: "青萍宗宗主。" },
        ],
      },
      { ...ctx, turnNumber: 5 },
      store,
    );
    const nodeId = seeded.nodes.results[0].id;

    // Re-upsert without turnNumber (currentTurn = -1). The node's real
    // lastSeenTurn must not regress to the "unknown" sentinel.
    await executeAndCommit(
      upsertTool,
      {
        nodes: [
          { name: "陆沉渊", type: "individual", summary: "更新后的简介。" },
        ],
      },
      { ...ctx, turnNumber: undefined },
      store,
    );

    const row = await store.getPluginData(
      ctx.sessionId,
      ctx.pluginId,
      "nodes",
      nodeId,
    );
    expect(row.value.lastSeenTurn).toBe(5);
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

  /** Seed A —TRUSTS→ B at strength 0.5 on turn 3. */
  async function seedTrustEdge() {
    return executeAndCommit(
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
      { ...ctx, turnNumber: 3 },
      store,
    );
  }

  it("skips an identical edge (same source, target, relation, strength, fact)", async () => {
    await seedTrustEdge();

    const dup = await executeAndCommit(
      upsertTool,
      {
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
      { ...ctx, turnNumber: 4 },
      store,
    );

    expect(dup.edges.created).toBe(0);
    expect(dup.edges.skipped).toBe(1);
    expect(dup.edges.results[0].skipped).toBe("unchanged relation");
  });

  // Relationships evolve: the old code de-duplicated on (source, target,
  // relation) alone, so a changed strength or fact was dropped and the graph
  // froze at whatever the first turn happened to record. `validAt` was also
  // filled from the stored-edge COUNT, which measures graph size, not time.
  it("supersedes an existing relation when its strength or fact changes", async () => {
    const seeded = await seedTrustEdge();
    const originalId = seeded.edges.results[0].id;

    const updated = await executeAndCommit(
      upsertTool,
      {
        edges: [
          {
            sourceName: "A",
            targetName: "B",
            relation: "TRUSTS",
            strength: -0.4,
            fact: "A now doubts B after finding the forged seal in his quarters.",
          },
        ],
      },
      { ...ctx, turnNumber: 9 },
      store,
    );

    expect(updated.edges.created).toBe(1);
    expect(updated.edges.skipped).toBe(0);
    expect(updated.edges.results[0].supersedes).toBe(originalId);

    const list = await listTool.execute({}, ctx);
    const previous = list.edges.find((e) => e.id === originalId);
    const current = list.edges.find((e) => e.id !== originalId);

    // The old version is closed at the turn the new fact arrived; the new one
    // opens there. Both timestamps are real turn indices, not row counts.
    expect(previous.invalidAt).toBe(9);
    expect(previous.validAt).toBe(3);
    expect(current.invalidAt).toBeUndefined();
    expect(current.validAt).toBe(9);
    expect(current.strength).toBe(-0.4);

    // The superseded id is pruned from the adjacency index — a revised relation
    // nets zero index growth (new id in, closed id out) rather than piling up
    // closed ids forever.
    const aNode = list.nodes.find((n) => n.name === "A");
    const idx = await store.getPluginData(
      ctx.sessionId,
      ctx.pluginId,
      "index",
      `by-source:${aNode.id}`,
    );
    expect(idx.value).toContain(current.id);
    expect(idx.value).not.toContain(originalId);
  });

  it("keeps distinct versions when the same relation is revised across calls in one turn", async () => {
    // Tool calls within a turn don't commit between each other and each starts
    // its batch index at 0, so a turn+index suffix reused the same id for a
    // relation revised in three separate calls of the same turn — the later
    // versions overwrote the earlier rows' provenance.
    const turn = { ...ctx, turnNumber: 7 };
    const revise = (strength, fact) =>
      executeAndCommit(
        upsertTool,
        {
          nodes: [
            { name: "A", type: "individual", summary: "First subject." },
            { name: "B", type: "individual", summary: "Second subject." },
          ],
          edges: [
            {
              sourceName: "A",
              targetName: "B",
              relation: "TRUSTS",
              strength,
              fact,
            },
          ],
        },
        turn,
        store,
      );

    const r1 = await revise(0.5, "Initial trust.");
    const r2 = await revise(0.1, "Growing doubt.");
    const r3 = await revise(-0.6, "Open betrayal.");

    const ids = [
      r1.edges.results[0].id,
      r2.edges.results[0].id,
      r3.edges.results[0].id,
    ];
    // All three ids are distinct — no version overwrote another.
    expect(new Set(ids).size).toBe(3);

    // Every version persisted: two closed at turn 7, one still open.
    const list = await listTool.execute({}, ctx);
    const trustEdges = list.edges.filter((e) => e.relation === "TRUSTS");
    expect(trustEdges).toHaveLength(3);
    expect(trustEdges.filter((e) => e.invalidAt === undefined)).toHaveLength(1);
    expect(trustEdges.find((e) => e.invalidAt === undefined).strength).toBe(
      -0.6,
    );
  });

  it("self-heals a relation that already has two open versions", async () => {
    // Corrupted state a pre-fix same-turn double revision could leave: two open
    // rows for one relation (writes don't commit between tool calls in a turn,
    // so each call opened its own version). The next write must close all but
    // the newest so retrieval never carries two contradictory facts forever.
    await store.setPluginDataBatch([
      {
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: "nodes",
        key: "npc-a",
        value: { id: "npc-a", name: "A", type: "individual" },
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: "nodes",
        key: "npc-b",
        value: { id: "npc-b", name: "B", type: "individual" },
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    const seedOpen = (id, validAt, strength) =>
      store.setPluginData({
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: "edges",
        key: id,
        value: {
          id,
          source: "npc-a",
          target: "npc-b",
          relation: "TRUSTS",
          strength,
          fact: `Open version at turn ${validAt}.`,
          validAt,
        },
        updatedAt: "2026-01-01T00:00:00Z",
      });
    await seedOpen("edge-old-3", 3, 0.3);
    await seedOpen("edge-old-5", 5, 0.5);

    await executeAndCommit(
      upsertTool,
      {
        edges: [
          {
            sourceName: "A",
            targetName: "B",
            relation: "TRUSTS",
            strength: -0.2,
            fact: "A grows wary of B.",
          },
        ],
      },
      { ...ctx, turnNumber: 9 },
      store,
    );

    const list = await listTool.execute({}, ctx);
    const trust = list.edges.filter((e) => e.relation === "TRUSTS");
    const open = trust.filter((e) => e.invalidAt === undefined);
    // Exactly one open version survives — the brand-new revision.
    expect(open).toHaveLength(1);
    expect(open[0].strength).toBe(-0.2);
    // Both pre-existing open rows were closed at the current turn.
    expect(trust.find((e) => e.id === "edge-old-3").invalidAt).toBe(9);
    expect(trust.find((e) => e.id === "edge-old-5").invalidAt).toBe(9);
  });

  it("gives superseding versions distinct ids even when endpoint names are long", async () => {
    // Edge ids slugify (source + relation + target) and truncate to 24 chars.
    // With long names the truncated slug is identical across versions, so the
    // version suffix must survive OUTSIDE the slugified part — otherwise the
    // new version reuses the old id and overwrites its provenance row.
    const longNodes = [
      {
        name: "Grand Chancellor Xiao Yansheng of the Eastern Court",
        type: "individual",
        summary: "A long-named official.",
      },
      {
        name: "Field Marshal Lu Chenyuan of the Northern Garrison",
        type: "individual",
        summary: "A long-named commander.",
      },
    ];
    const relation = {
      sourceName: longNodes[0].name,
      targetName: longNodes[1].name,
      relation: "SECRETLY_DISTRUSTS",
    };

    const seeded = await executeAndCommit(
      upsertTool,
      {
        nodes: longNodes,
        edges: [{ ...relation, strength: 0.3, fact: "Guarded cordiality." }],
      },
      { ...ctx, turnNumber: 4 },
      store,
    );
    const originalId = seeded.edges.results[0].id;

    const updated = await executeAndCommit(
      upsertTool,
      {
        edges: [
          {
            ...relation,
            strength: -0.6,
            fact: "Open hostility after the purge.",
          },
        ],
      },
      { ...ctx, turnNumber: 11 },
      store,
    );
    const newId = updated.edges.results[0].id;

    expect(updated.edges.results[0].supersedes).toBe(originalId);
    expect(newId).not.toBe(originalId);

    // Both versions coexist: the old one closed for provenance, the new open.
    const list = await listTool.execute({}, ctx);
    const previous = list.edges.find((e) => e.id === originalId);
    const current = list.edges.find((e) => e.id === newId);
    expect(previous).toBeDefined();
    expect(previous.invalidAt).toBe(11);
    expect(current.invalidAt).toBeUndefined();
    expect(current.strength).toBe(-0.6);
  });

  it("treats an edge stored before versioning as the open version", async () => {
    // Legacy row: no `invalidAt`, and a `validAt` that came from the old
    // row-count clock. It must still be found and superseded, not duplicated.
    await store.setPluginData({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      namespace: "edges",
      key: "edge-legacy",
      value: {
        id: "edge-legacy",
        source: "npc-old1",
        target: "npc-old2",
        relation: "TRUSTS",
        strength: 0.2,
        fact: "A legacy fact recorded before edges carried a valid interval.",
        validAt: 0,
      },
      updatedAt: "2024-01-01T00:00:00Z",
    });
    await store.setPluginDataBatch([
      {
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: "nodes",
        key: "npc-old1",
        value: { id: "npc-old1", name: "Old A", type: "individual" },
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: "nodes",
        key: "npc-old2",
        value: { id: "npc-old2", name: "Old B", type: "individual" },
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    const out = await executeAndCommit(
      upsertTool,
      {
        edges: [
          {
            sourceName: "Old A",
            targetName: "Old B",
            relation: "TRUSTS",
            strength: 0.8,
            fact: "Old A came to rely on Old B completely after the siege.",
          },
        ],
      },
      { ...ctx, turnNumber: 12 },
      store,
    );

    expect(out.edges.results[0].supersedes).toBe("edge-legacy");
    const legacy = await store.getPluginData(
      ctx.sessionId,
      ctx.pluginId,
      "edges",
      "edge-legacy",
    );
    expect(legacy.value.invalidAt).toBe(12);
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

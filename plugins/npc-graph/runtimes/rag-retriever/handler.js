/**
 * npc-graph/rag-retriever — function runtime handler.
 *
 * Pulls the NPC subgraph relevant to the current player message and
 * returns it as a markdown list for narrator consumption. Entirely
 * structured retrieval (name matching + adjacency BFS) — no LLM, no
 * embeddings. Phase 3.5 will upgrade to hybrid retrieval once the
 * framework exposes gateway access to function runtimes.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const { sessionId, playerMessage } = ctx;
  const pluginId = "npc-graph";
  const store = /** @type {any} */ (ctx.store);

  try {
    const nodeRows =
      (await listPluginData(store, sessionId, pluginId, "nodes")) ?? [];
    const edgeRows =
      (await listPluginData(store, sessionId, pluginId, "edges")) ?? [];

    // Short-circuit when there is nothing to retrieve — zero-cost for
    // fresh sessions and for worlds that never trigger the extractor.
    if (nodeRows.length === 0 || edgeRows.length === 0) {
      return {
        npcContext: "",
        matchedNodes: [],
        edgeCount: 0,
      };
    }

    const nodes = nodeRows.map((row) => row.value).filter(Boolean);
    const edges = edgeRows.map((row) => row.value).filter(Boolean);

    /** @type {Map<string, any>} */
    const nodeById = new Map();
    for (const node of nodes) {
      if (node?.id) nodeById.set(node.id, node);
    }

    // ── 1. Name + alias matching against playerMessage ───────────
    const haystack = (playerMessage ?? "").toLowerCase();
    /** @type {Set<string>} */
    const seedNodeIds = new Set();
    if (haystack.length > 0) {
      for (const node of nodes) {
        if (!node?.name || !node?.id) continue;
        const candidates = [node.name, ...(node.aliases ?? [])];
        for (const candidate of candidates) {
          if (typeof candidate !== "string" || candidate.length === 0) continue;
          if (haystack.includes(candidate.toLowerCase())) {
            seedNodeIds.add(node.id);
            break;
          }
        }
      }
    }

    if (seedNodeIds.size === 0) {
      return {
        npcContext: "",
        matchedNodes: [],
        edgeCount: edges.length,
      };
    }

    // ── 2. 2-hop BFS via adjacency index ─────────────────────────
    /** @type {Set<string>} */
    const visitedNodeIds = new Set(seedNodeIds);
    /** @type {Set<string>} */
    const collectedEdgeIds = new Set();

    let frontier = Array.from(seedNodeIds);
    const maxHops = 2;
    for (let hop = 0; hop < maxHops; hop += 1) {
      /** @type {Set<string>} */
      const nextFrontier = new Set();
      for (const nodeId of frontier) {
        const neighbourEdgeIds = await loadAdjacency(
          store,
          sessionId,
          pluginId,
          nodeId,
        );
        for (const edgeId of neighbourEdgeIds) {
          collectedEdgeIds.add(edgeId);
        }
      }
      // Expand the frontier using the edges we just collected.
      for (const edgeId of collectedEdgeIds) {
        const edge = edges.find((e) => e.id === edgeId);
        if (!edge) continue;
        for (const endpoint of [edge.source, edge.target]) {
          if (!visitedNodeIds.has(endpoint)) {
            visitedNodeIds.add(endpoint);
            nextFrontier.add(endpoint);
          }
        }
      }
      if (nextFrontier.size === 0) break;
      frontier = Array.from(nextFrontier);
    }

    // ── 3. Select, filter time, rank, cap ────────────────────────
    const turnCount = edges.length; // rough clock — Phase 4 will use a real turn index
    const eligibleEdges = edges
      .filter((e) => collectedEdgeIds.has(e.id))
      .filter((e) => e.invalidAt === undefined || e.invalidAt > turnCount - 20);

    eligibleEdges.sort((a, b) => {
      const recencyDiff = (b.validAt ?? 0) - (a.validAt ?? 0);
      if (recencyDiff !== 0) return recencyDiff;
      return Math.abs(b.strength ?? 0) - Math.abs(a.strength ?? 0);
    });

    const topEdges = eligibleEdges.slice(0, 20);

    // ── 4. Format as markdown for narrator injection ─────────────
    const lines = [];
    if (topEdges.length > 0) {
      lines.push("## 已知 NPC 关系（从图谱检索）");
      lines.push("");
      for (const edge of topEdges) {
        const src = nodeById.get(edge.source);
        const tgt = nodeById.get(edge.target);
        const srcName = src?.name ?? edge.source;
        const tgtName = tgt?.name ?? edge.target;
        const sign =
          edge.strength > 0.33 ? "+" : edge.strength < -0.33 ? "-" : "·";
        lines.push(
          `- [${sign}] **${srcName}** → **${tgtName}** (${edge.relation}): ${edge.fact}`,
        );
      }
    }

    return {
      npcContext: lines.join("\n"),
      matchedNodes: Array.from(visitedNodeIds),
      edgeCount: topEdges.length,
    };
  } catch (err) {
    console.warn("[npc-graph/rag-retriever] handler error:", err);
    return {
      npcContext: "",
      matchedNodes: [],
      edgeCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Load adjacent edge IDs for a node by merging `by-source:{id}` and
 * `by-target:{id}` entries from the index namespace.
 *
 * @param {any} store
 * @param {string} sessionId
 * @param {string} pluginId
 * @param {string} nodeId
 * @returns {Promise<string[]>}
 */
async function loadAdjacency(store, sessionId, pluginId, nodeId) {
  /** @type {string[]} */
  const out = [];
  for (const indexKey of [`by-source:${nodeId}`, `by-target:${nodeId}`]) {
    const row = await getPluginData(
      store,
      sessionId,
      pluginId,
      "index",
      indexKey,
    );
    if (row && Array.isArray(row.value)) {
      for (const edgeId of row.value) {
        if (typeof edgeId === "string") out.push(edgeId);
      }
    }
  }
  return out;
}

/**
 * Function runtimes receive a scoped FunctionStoreView in the framework, while
 * direct plugin tests often pass a full DataStore. Support both call shapes.
 *
 * @param {any} store
 * @param {string} sessionId
 * @param {string} pluginId
 * @param {string} namespace
 */
async function listPluginData(store, sessionId, pluginId, namespace) {
  if (store.listPluginData.length <= 1) {
    return store.listPluginData(namespace);
  }
  return store.listPluginData(sessionId, pluginId, namespace);
}

/**
 * @param {any} store
 * @param {string} sessionId
 * @param {string} pluginId
 * @param {string} namespace
 * @param {string} key
 */
async function getPluginData(store, sessionId, pluginId, namespace, key) {
  if (store.getPluginData.length <= 2) {
    return store.getPluginData(namespace, key);
  }
  return store.getPluginData(sessionId, pluginId, namespace, key);
}

/**
 * npc-graph/rag-retriever — function runtime handler.
 *
 * Pulls the NPC subgraph relevant to the current player message and
 * returns it as a markdown list for narrator consumption. Entirely
 * structured retrieval (name matching + adjacency BFS) — no LLM, no
 * embeddings. Phase 3.5 will upgrade to hybrid retrieval once the
 * framework exposes gateway access to function runtimes.
 *
 */
import { pickLocaleText } from "@covel/plugin-handlers-utils";

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const { playerMessage, locale } = ctx;
  // ctx.pluginData is the one scoped plugin-data path — same shape for
  // trusted and community runtimes, so no store arity sniffing.
  const pluginData = ctx.pluginData;
  // This markdown header is injected into the narrator prompt, so resolve it to
  // the session locale instead of emitting a fixed-language heading.
  const relHeader = pickLocaleText(
    locale,
    "## 已知 NPC 关系（从图谱检索）",
    "## Known NPC relationships (from graph retrieval)",
  );

  try {
    const nodeRows = pluginData ? ((await pluginData.list("nodes")) ?? []) : [];
    const edgeRows = pluginData ? ((await pluginData.list("edges")) ?? []) : [];

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
        const neighbourEdgeIds = await loadAdjacency(pluginData, nodeId);
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

    // ── 3. Select, filter by valid interval, rank, cap ───────────
    //
    // Only edges whose valid interval is still open reach the narrator. A
    // superseded version keeps its row for provenance but must not be
    // injected — otherwise the prompt carries two contradictory facts about
    // the same pair. Rows written before edge versioning have no `invalidAt`
    // and read as open, so old sessions keep rendering.
    //
    // The previous filter compared `invalidAt` against `edges.length`, i.e.
    // the number of stored edges used as a stand-in clock. Nothing ever set
    // `invalidAt`, so it was a no-op; now that the upsert tool closes
    // superseded versions at a real turn index, plain openness is the whole
    // predicate and no clock is needed here.
    const eligibleEdges = edges
      .filter((e) => collectedEdgeIds.has(e.id))
      .filter((e) => e.invalidAt === undefined);

    eligibleEdges.sort((a, b) => {
      const recencyDiff = (b.validAt ?? 0) - (a.validAt ?? 0);
      if (recencyDiff !== 0) return recencyDiff;
      return Math.abs(b.strength ?? 0) - Math.abs(a.strength ?? 0);
    });

    const topEdges = eligibleEdges.slice(0, 20);

    // ── 4. Format as markdown for narrator injection ─────────────
    const lines = [];
    if (topEdges.length > 0) {
      lines.push(relHeader);
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
    await ctx.logger?.warn?.("rag-retriever handler error", {
      error: err instanceof Error ? err.message : String(err),
    });
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
 * @param {import('@covel/plugin-loader').PluginDataWriter | undefined} pluginData
 * @param {string} nodeId
 * @returns {Promise<string[]>}
 */
async function loadAdjacency(pluginData, nodeId) {
  /** @type {string[]} */
  const out = [];
  if (!pluginData) return out;
  for (const indexKey of [`by-source:${nodeId}`, `by-target:${nodeId}`]) {
    const value = await pluginData.get("index", indexKey);
    if (Array.isArray(value)) {
      for (const edgeId of value) {
        if (typeof edgeId === "string") out.push(edgeId);
      }
    }
  }
  return out;
}

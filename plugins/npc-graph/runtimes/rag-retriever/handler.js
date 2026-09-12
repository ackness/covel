/**
 * npc-graph/rag-retriever — function runtime handler.
 *
 * Pulls the NPC subgraph relevant to the current player message and
 * returns it as a markdown list for narrator consumption. Entirely
 * structured retrieval (name matching + adjacency BFS) — no LLM, no
 * embeddings. Current cast is an optional same-execution input, used only
 * when the player's message does not name a graph node.
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
        outcome: "success",
        value: {
          npcContext: "",
          matchedNodes: [],
          edgeCount: 0,
        },
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

    // Character ids and graph node ids belong to different namespaces. Only
    // unambiguous full names/aliases connect the current cast to graph nodes.
    const cast = ctx.inputs?.currentCast?.value;
    if (seedNodeIds.size === 0 && Array.isArray(cast)) {
      for (const speaker of cast) {
        if (typeof speaker?.name !== "string") continue;
        const name = speaker.name.trim().toLowerCase();
        if (!name) continue;
        const matches = nodes.filter(
          (node) =>
            node?.id &&
            (!node.type || node.type === "individual") &&
            [
              node.name,
              ...(Array.isArray(node.aliases) ? node.aliases : []),
            ].some(
              (candidate) =>
                typeof candidate === "string" &&
                candidate.trim().toLowerCase() === name,
            ),
        );
        if (matches.length === 1) seedNodeIds.add(matches[0].id);
      }
    }

    if (seedNodeIds.size === 0) {
      return {
        outcome: "success",
        value: {
          npcContext: "",
          matchedNodes: [],
          edgeCount: edges.length,
        },
      };
    }

    const openByRelation = new Map();
    for (const edge of edges) {
      if (edge.invalidAt !== undefined) continue;
      const key = JSON.stringify([edge.source, edge.target, edge.relation]);
      const prior = openByRelation.get(key);
      if (!prior || (edge.validAt ?? -1) > (prior.validAt ?? -1)) {
        openByRelation.set(key, edge);
      }
    }
    const currentEdges = Array.from(openByRelation.values());
    const edgeById = new Map(currentEdges.map((edge) => [edge.id, edge]));

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
          if (edgeById.has(edgeId)) collectedEdgeIds.add(edgeId);
        }
      }
      // Expand the frontier using the edges we just collected.
      for (const edgeId of collectedEdgeIds) {
        const edge = edgeById.get(edgeId);
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

    // ── 3. Rank the reachable current relations and cap the prompt ─────
    const eligibleEdges = currentEdges.filter((edge) =>
      collectedEdgeIds.has(edge.id),
    );

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
      outcome: "success",
      value: {
        npcContext: lines.join("\n"),
        matchedNodes: Array.from(visitedNodeIds),
        edgeCount: topEdges.length,
      },
    };
  } catch (err) {
    await ctx.logger?.warn?.("rag-retriever handler error", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Graceful degradation stays a success carrying an empty context + error
    // marker — a retrieval miss must not fail the narration turn.
    return {
      outcome: "success",
      value: {
        npcContext: "",
        matchedNodes: [],
        edgeCount: 0,
        error: err instanceof Error ? err.message : String(err),
      },
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

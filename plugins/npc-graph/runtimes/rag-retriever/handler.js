/**
 * npc-graph/rag-retriever — function runtime handler.
 *
 * Pulls the NPC subgraph relevant to the current player message and
 * returns it as a markdown list for narrator consumption. Entirely
 * structured retrieval (name matching + BFS over the current edges) — no LLM, no
 * embeddings. Current cast is an optional same-execution input, used only
 * when the player's message does not name a graph node.
 *
 */
import { translate } from "@covel/plugin-handlers-utils";
import { mentionedNodeIds } from "../../lib/mentions.js";

/**
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const { playerMessage } = ctx;
  // ctx.pluginData is the one scoped plugin-data path — same shape for
  // trusted and community runtimes, so no store arity sniffing.
  const pluginData = ctx.pluginData;
  // This markdown header is injected into the narrator prompt, so resolve it to
  // the session locale instead of emitting a fixed-language heading.
  const relHeader = translate(
    ctx,
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
    const seedNodeIds = mentionedNodeIds(playerMessage, nodes);

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

    // ── 2. 2-hop BFS over the current edges ──────────────────────
    // Built from the edges already read, so it cannot drift from them.
    /** @type {Map<string, string[]>} */
    const adjacency = new Map();
    for (const edge of currentEdges) {
      for (const endpoint of [edge.source, edge.target]) {
        const list = adjacency.get(endpoint);
        if (list) list.push(edge.id);
        else adjacency.set(endpoint, [edge.id]);
      }
    }
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
        for (const edgeId of adjacency.get(nodeId) ?? []) {
          collectedEdgeIds.add(edgeId);
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
    // The narrator's input is optional, so a failed retrieval does not stop
    // the turn, but the run is recorded as failed instead of an empty success.
    return {
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

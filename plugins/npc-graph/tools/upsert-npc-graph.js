/**
 * Plugin-local tool: upsert-npc-graph
 *
 * Batch-upsert NPC nodes and relationship edges for the current turn.
 *
 * ### LLM contract
 *
 * The LLM provides nodes and edges keyed by canonical **name** (not ID).
 * The tool is responsible for:
 *
 *  1. Loading existing nodes from `plugin_data[namespace="nodes"]`.
 *  2. Assigning short IDs to newly-named nodes via `shortIdBatch`.
 *  3. Merging updates into existing nodes (aliases, labels, summary,
 *     attributes) so one relationship turn cannot nuke prior context.
 *  4. Rewriting edge `sourceName` / `targetName` to node IDs.
 *  5. Versioning edges by (source, target, relation): an unchanged relation is
 *     a no-op, a changed one closes the open version and opens a new one.
 *  6. Maintaining the `index` namespace — adjacency lists keyed by
 *     `by-source:{nodeId}` and `by-target:{nodeId}` for fast k-hop
 *     traversal in the forthcoming retrieval tool.
 *
 * No LLM embedding is performed here — vector storage of edge facts is
 * wired in Phase 3 where the retrieval path lives.
 *
 * @param {{ tool: Function, z: import('zod'), shortIdBatch: Function, store: any }} injection
 */
import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

export default function ({ tool, z, shortIdBatch, store }) {
  const nodeInputSchema = z.object({
    name: z
      .string()
      .min(1)
      .describe(
        "Canonical name of the person/group/faction (used for de-duplication)",
      ),
    aliases: z.array(z.string()).optional().describe("List of aliases"),
    type: z
      .enum(["individual", "group", "faction"])
      .describe("Node kind: individual=person, group, faction"),
    labels: z
      .array(z.string())
      .max(5)
      .optional()
      .describe('Ontology labels (e.g. ["merchant","ally"]), max 5'),
    summary: z
      .string()
      .min(4)
      .max(200)
      .describe(
        "A profile summary of no more than 200 characters, used as the node's dossier",
      ),
    attributes: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Free-form attribute key-value pairs (e.g. {"profession":"merchant"})',
      ),
  });

  const edgeInputSchema = z.object({
    sourceName: z
      .string()
      .min(1)
      .describe(
        "The source node's name — may reference a new or an existing node",
      ),
    targetName: z.string().min(1).describe("The target node's name"),
    relation: z
      .string()
      .min(1)
      .max(48)
      .regex(/^[\p{Letter}][\p{Letter}\p{Number}_\-\s]*$/u)
      .describe(
        "Relation type; accepts a structured English identifier or a natural-language relation label (e.g. TRUSTS, ALLIED_WITH, RIVALS)",
      ),
    strength: z
      .number()
      .min(-1)
      .max(1)
      .describe(
        "Relationship strength [-1..1]; negative values indicate hostility",
      ),
    fact: z
      .string()
      .min(8)
      .max(400)
      .describe(
        "A complete natural-language fact in one sentence, with subject, verb, and object",
      ),
  });

  return tool({
    name: "upsert-npc-graph",
    description:
      "Batch-write NPC nodes and relationship edges. Nodes are de-duplicated by name. Edges are versioned by (sourceName, targetName, relation): resubmit a relation whose strength or fact changed and the tool supersedes the previous version; resubmitting an identical one is a no-op. No need to list existing data first — the tool merges and updates internally.",
    parameters: z.object({
      nodes: z
        .array(nodeInputSchema)
        .max(8)
        .optional()
        .describe("Nodes to create or update this turn, max 8"),
      edges: z
        .array(edgeInputSchema)
        .max(12)
        .optional()
        .describe("Relationship edges to create this turn, max 12"),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      const currentTurnId = context.turnId ?? "unknown";
      // Authoritative logical turn (player-message count). These fields used
      // to be filled from the node COUNT, which measures how much has been
      // recorded rather than when — so a graph that grew fast looked "old"
      // and one mentioned repeatedly in a single turn advanced as if turns
      // had passed. Anything derived from them (relationship decay, recency
      // ranking) was meaningless. `-1` marks "unknown" for callers outside a
      // turn rather than silently pretending turn 0.
      const currentTurn = context.turnNumber ?? -1;

      const incomingNodes = params.nodes ?? [];
      const incomingEdges = params.edges ?? [];

      // ── 1. Load existing nodes and build a name → NpcNode index ──
      const existingNodeRows =
        (await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "nodes",
        )) ?? [];
      /** @type {Map<string, any>} */
      const nodeByName = new Map();
      for (const row of existingNodeRows) {
        const v = row.value ?? {};
        if (typeof v.name === "string") {
          nodeByName.set(v.name.toLowerCase(), v);
        }
        for (const alias of v.aliases ?? []) {
          nodeByName.set(alias.toLowerCase(), v);
        }
      }

      // ── 2. Assign short IDs to nodes that don't already exist ──
      const newNodeNames = incomingNodes
        .map((n) => n.name)
        .filter((name) => !nodeByName.has(name.toLowerCase()));
      const assignedIds =
        newNodeNames.length > 0
          ? shortIdBatch("npc", newNodeNames, context.sessionId)
          : [];
      /** @type {Map<string, string>} */
      const newNameToId = new Map();
      for (let i = 0; i < newNodeNames.length; i += 1) {
        newNameToId.set(newNodeNames[i].toLowerCase(), assignedIds[i]);
      }

      // ── 3. Compute per-node merged records and stage writes ──
      /** @type {Array<{ namespace: string; key: string; value: any }>} */
      const pluginDataWrites = [];
      /** @type {Array<{ id: string; name: string; status: 'created' | 'updated' }>} */
      const nodeResults = [];

      for (const incoming of incomingNodes) {
        const lookupKey = incoming.name.toLowerCase();
        const existing = nodeByName.get(lookupKey);

        if (existing) {
          // Merge — existing wins on immutable fields, new wins on extendable ones.
          const merged = {
            ...existing,
            name: existing.name,
            type: existing.type ?? incoming.type,
            aliases: Array.from(
              new Set([
                ...(existing.aliases ?? []),
                ...(incoming.aliases ?? []),
              ]),
            ),
            labels: Array.from(
              new Set([...(existing.labels ?? []), ...(incoming.labels ?? [])]),
            ).slice(0, 5),
            summary: incoming.summary || existing.summary,
            attributes: {
              ...existing.attributes,
              ...incoming.attributes,
            },
            lastSeenTurn: currentTurn,
          };
          pluginDataWrites.push({
            namespace: "nodes",
            key: existing.id,
            value: merged,
          });
          nodeByName.set(lookupKey, merged);
          nodeResults.push({
            id: existing.id,
            name: existing.name,
            status: "updated",
          });
        } else {
          const id = newNameToId.get(lookupKey);
          if (!id) continue;
          const fresh = {
            id,
            name: incoming.name,
            aliases: incoming.aliases ?? [],
            type: incoming.type,
            labels: (incoming.labels ?? []).slice(0, 5),
            summary: incoming.summary,
            firstSeenTurn: currentTurn,
            lastSeenTurn: currentTurn,
            attributes: incoming.attributes ?? {},
          };
          pluginDataWrites.push({
            namespace: "nodes",
            key: id,
            value: fresh,
          });
          nodeByName.set(lookupKey, fresh);
          for (const alias of fresh.aliases) {
            nodeByName.set(alias.toLowerCase(), fresh);
          }
          nodeResults.push({ id, name: fresh.name, status: "created" });
        }
      }

      // ── 4. Load existing edges and index the open version of each relation ──
      //
      // An edge is a *versioned* fact, not a unique row: (source, target,
      // relation) can hold many versions over a session, of which at most one
      // is open (`invalidAt === undefined`). Re-submitting the same relation
      // with a new strength or a new fact closes the open version and opens a
      // new one, so a relationship can actually evolve. Rows written before
      // versioning existed carry no `invalidAt` and therefore read as open —
      // an old session keeps working and simply gets superseded from here on.
      const existingEdgeRows =
        (await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "edges",
        )) ?? [];
      /** @type {Map<string, any>} */
      const openEdgeByKey = new Map();
      for (const row of existingEdgeRows) {
        const v = row.value ?? {};
        if (!v.source || !v.target || !v.relation) continue;
        if (v.invalidAt !== undefined) continue;
        const key = `${v.source}::${v.target}::${v.relation}`;
        const prior = openEdgeByKey.get(key);
        if (!prior) {
          openEdgeByKey.set(key, v);
          continue;
        }
        // Two open versions of one relation must never coexist. A later tool
        // call in the same turn (writes don't commit between calls) reads the
        // pre-turn store and can open a second version, leaving two open rows
        // after commit — the retriever would then inject contradictory facts
        // forever. Self-heal on the next write: keep the newest by validAt as
        // the live version and close the older one at the current turn.
        const [live, stale] =
          (v.validAt ?? -1) >= (prior.validAt ?? -1) ? [v, prior] : [prior, v];
        openEdgeByKey.set(key, live);
        pluginDataWrites.push({
          namespace: "edges",
          key: stale.id,
          value: { ...stale, invalidAt: currentTurn },
        });
      }

      /** @type {Array<{ id: string; source: string; target: string; relation: string; fact: string; skipped?: string; supersedes?: string }>} */
      const edgeResults = [];
      /** @type {Map<string, { byNode: Map<string, Set<string>> }>} */
      const adjacencyUpdates = new Map();

      for (const incoming of incomingEdges) {
        const src = nodeByName.get(incoming.sourceName.toLowerCase());
        const tgt = nodeByName.get(incoming.targetName.toLowerCase());
        if (!src || !tgt) {
          edgeResults.push({
            id: "",
            source: incoming.sourceName,
            target: incoming.targetName,
            relation: incoming.relation,
            fact: incoming.fact,
            skipped: "missing endpoint node",
          });
          continue;
        }
        const edgeKey = `${src.id}::${tgt.id}::${incoming.relation}`;
        const openEdge = openEdgeByKey.get(edgeKey);
        if (
          openEdge &&
          openEdge.strength === incoming.strength &&
          openEdge.fact === incoming.fact
        ) {
          // Nothing changed — re-recording it would only churn the version
          // history and cost the retriever a slot.
          edgeResults.push({
            id: openEdge.id,
            source: src.id,
            target: tgt.id,
            relation: incoming.relation,
            fact: incoming.fact,
            skipped: "unchanged relation",
          });
          continue;
        }
        if (openEdge) {
          // Close the previous version at the current turn. The row survives
          // for provenance; retrieval only surfaces open edges.
          pluginDataWrites.push({
            namespace: "edges",
            key: openEdge.id,
            value: { ...openEdge, invalidAt: currentTurn },
          });
        }
        // `shortIdBatch` slugifies the label and truncates it to 24 chars, so a
        // version suffix placed INSIDE the label is silently cut off for long
        // endpoint names — two versions of the same relation would collapse to
        // one id and the newer would overwrite the older's provenance. Keep the
        // slugified part to the (endpoints + relation) base for readability and
        // append a suffix outside the truncated slug. The suffix must be unique
        // per version, and neither turn nor batch index guarantees that: tool
        // calls within one turn don't commit between each other and each starts
        // its batch index at 0, so a relation revised in three separate calls
        // of the same turn would reuse one id. A random token needs no
        // cross-call state and can't collide across turns, calls, or restarts.
        const [edgeBase] = shortIdBatch(
          "edge",
          [`${src.name}-${incoming.relation}-${tgt.name}`],
          context.sessionId,
        );
        const edgeId = `${edgeBase}-${crypto.randomUUID().slice(0, 8)}`;
        const edge = {
          id: edgeId,
          source: src.id,
          target: tgt.id,
          relation: incoming.relation,
          strength: incoming.strength,
          fact: incoming.fact,
          // Authoritative logical turn, same clock as the node timestamps.
          // This used to be the number of edge rows already stored, which made
          // `validAt` a measure of graph size rather than of time — recency
          // ranking and the retriever's staleness window both read garbage.
          validAt: currentTurn,
          // Each version carries only the turns that produced it; the closed
          // predecessor keeps its own, so provenance stays per-version.
          evidenceTurnIds: [currentTurnId],
        };
        pluginDataWrites.push({
          namespace: "edges",
          key: edgeId,
          value: edge,
        });
        openEdgeByKey.set(edgeKey, edge);
        edgeResults.push({
          id: edgeId,
          source: src.id,
          target: tgt.id,
          relation: incoming.relation,
          fact: incoming.fact,
          ...(openEdge ? { supersedes: openEdge.id } : {}),
        });

        // Adjacency index staging
        stageAdjacency(adjacencyUpdates, `by-source:${src.id}`, edgeId);
        stageAdjacency(adjacencyUpdates, `by-target:${tgt.id}`, edgeId);
      }

      // ── 5. Load existing index entries for staged keys and merge ──
      for (const [indexKey, bucket] of adjacencyUpdates) {
        const existing = await store.getPluginData(
          context.sessionId,
          context.pluginId,
          "index",
          indexKey,
        );
        /** @type {string[]} */
        const prev = Array.isArray(existing?.value) ? existing.value : [];
        const merged = Array.from(
          new Set([...prev, ...bucket.byNode.get(indexKey)]),
        );
        pluginDataWrites.push({
          namespace: "index",
          key: indexKey,
          value: merged,
        });
      }

      // ── 6. Persist everything in one batch ──
      return withPendingProposals(
        {
          nodes: {
            created: nodeResults.filter((r) => r.status === "created").length,
            updated: nodeResults.filter((r) => r.status === "updated").length,
            results: nodeResults,
          },
          edges: {
            created: edgeResults.filter((r) => !r.skipped).length,
            skipped: edgeResults.filter((r) => r.skipped).length,
            results: edgeResults,
          },
        },
        pluginDataWrites.length > 0
          ? [
              makeProposal(context, now, "plugin.data.batch", {
                items: pluginDataWrites,
              }),
            ]
          : [],
      );
    },
  });
}

/**
 * @param {Map<string, { byNode: Map<string, Set<string>> }>} container
 * @param {string} indexKey
 * @param {string} edgeId
 */
function stageAdjacency(container, indexKey, edgeId) {
  const bucket = container.get(indexKey) ?? { byNode: new Map() };
  const set = bucket.byNode.get(indexKey) ?? new Set();
  set.add(edgeId);
  bucket.byNode.set(indexKey, set);
  container.set(indexKey, bucket);
}

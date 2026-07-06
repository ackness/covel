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
 *  5. De-duplicating edges by (source, target, relation).
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
      "Batch-write NPC nodes and relationship edges. Nodes are de-duplicated by name; edges by (sourceName, targetName, relation). No need to list existing data first — the tool merges and updates internally.",
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
            lastSeenTurn: existing.lastSeenTurn + 1,
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
            firstSeenTurn: existingNodeRows.length,
            lastSeenTurn: existingNodeRows.length,
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

      // ── 4. Load existing edges and de-duplicate by (source, target, relation) ──
      const existingEdgeRows =
        (await store.listPluginData(
          context.sessionId,
          context.pluginId,
          "edges",
        )) ?? [];
      /** @type {Set<string>} */
      const existingEdgeKeys = new Set();
      for (const row of existingEdgeRows) {
        const v = row.value ?? {};
        if (v.source && v.target && v.relation) {
          existingEdgeKeys.add(`${v.source}::${v.target}::${v.relation}`);
        }
      }

      /** @type {Array<{ id: string; source: string; target: string; relation: string; fact: string; skipped?: string }>} */
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
        if (existingEdgeKeys.has(edgeKey)) {
          edgeResults.push({
            id: "",
            source: src.id,
            target: tgt.id,
            relation: incoming.relation,
            fact: incoming.fact,
            skipped: "duplicate relation",
          });
          continue;
        }
        const [edgeId] = shortIdBatch(
          "edge",
          [`${src.name}-${incoming.relation}-${tgt.name}`],
          context.sessionId,
        );
        const edge = {
          id: edgeId,
          source: src.id,
          target: tgt.id,
          relation: incoming.relation,
          strength: incoming.strength,
          fact: incoming.fact,
          validAt: existingEdgeRows.length,
          evidenceTurnIds: [currentTurnId],
        };
        pluginDataWrites.push({
          namespace: "edges",
          key: edgeId,
          value: edge,
        });
        existingEdgeKeys.add(edgeKey);
        edgeResults.push({
          id: edgeId,
          source: src.id,
          target: tgt.id,
          relation: incoming.relation,
          fact: incoming.fact,
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

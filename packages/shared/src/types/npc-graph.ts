/**
 * NPC relationship graph types.
 *
 * Data model for the `npc-graph` plugin. Nodes represent individuals
 * and groups; edges carry relationship facts with timestamps so the graph
 * can evolve across turns. Facts are the unit of Graph-RAG retrieval —
 * when a future turn needs context, it embeds a query, finds the most
 * similar edge facts, and walks k hops outward.
 *
 * Storage layout (in `plugin_data` under pluginId=`npc-graph`):
 *
 *   namespace "nodes"  → key=nodeId,  value=NpcNode
 *   namespace "edges"  → key=edgeId,  value=NpcEdge
 *   namespace "index"  → key=by-source:{nodeId} | by-target:{nodeId}, value=string[]
 *   namespace "meta"   → key=ontology, value=NpcGraphOntology
 *
 * Design rationale: we deliberately mirror MiroFish's "10 entity types +
 * 10 edge types + Person/Organization fallbacks" ontology pattern but
 * keep the storage pure Covel plugin_data — no external graph database.
 */

/** Kind of NPC node. `faction` is a group with organizational identity. */
export type NpcNodeType = "individual" | "group" | "faction";

/**
 * A node in the NPC relationship graph — an individual, a group, or a
 * faction referenced by the narrative.
 */
export interface NpcNode {
  /** Short ID like `npc-0a7c` — LLM-friendly, stable within a session. */
  readonly id: string;
  /** Canonical display name. Used as the join key when the LLM revisits. */
  readonly name: string;
  /** Alternative names / aliases. Used by the adjacency indexer. */
  readonly aliases?: readonly string[];
  readonly type: NpcNodeType;
  /** Ontology labels, e.g. ['merchant', 'ally']. Max 5. */
  readonly labels: readonly string[];
  /** LLM-generated ≤200 char profile, updated as the character evolves. */
  readonly summary: string;
  /** Turn index when the node was first created. */
  readonly firstSeenTurn: number;
  /** Turn index when the node was most recently updated. */
  readonly lastSeenTurn: number;
  /** Free-form attributes — e.g. { profession: 'merchant', age: 'elder' }. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * A directed edge between two nodes carrying a single natural-language
 * fact. Edges are append-mostly but support soft expiry via `invalidAt`
 * (mirrors Graphiti's bitemporal model).
 */
export interface NpcEdge {
  /** Short ID like `edge-1f3a`. */
  readonly id: string;
  /** Source node ID. */
  readonly source: string;
  /** Target node ID. */
  readonly target: string;
  /**
   * Edge relation type, UPPER_SNAKE_CASE for LLM consistency. Examples:
   *   TRUSTS, FEARS, OWES_DEBT_TO, ALLY_OF, WORKS_FOR, SUBORDINATE_OF,
   *   COMPETES_WITH, SUPPORTS, OPPOSES, KNOWS_ABOUT
   */
  readonly relation: string;
  /** Strength in [-1, 1]. Negative values encode adversarial ties. */
  readonly strength: number;
  /**
   * A single-sentence natural-language fact. This is the Graph-RAG
   * retrieval unit — future queries embed and match against this field.
   */
  readonly fact: string;
  /** Turn index when the fact became valid. */
  readonly validAt: number;
  /** Turn index when the fact was superseded, if any. */
  readonly invalidAt?: number;
  /**
   * Turn IDs that contributed to this edge. Supports provenance — the
   * user can trace which narrator turn introduced a relationship.
   */
  readonly evidenceTurnIds: readonly string[];
}

/**
 * The per-session ontology — soft LLM-defined typology for nodes and
 * edges. The LLM generates this on the first turn it sees the world and
 * may extend it sparingly. `Person` and `Organization` are always
 * included as fallbacks, matching the MiroFish pattern.
 */
export interface NpcGraphOntology {
  readonly version: number;
  /**
   * Node labels the LLM is encouraged to use when assigning node types
   * and extra labels. Max 10 + fallbacks.
   */
  readonly entityTypes: readonly string[];
  /**
   * Edge relation types the LLM is encouraged to use. UPPER_SNAKE_CASE,
   * max 10 for cognitive load.
   */
  readonly edgeTypes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Result of a structured (non-ANN) adjacency traversal. */
export interface NpcGraphSubgraph {
  readonly nodes: readonly NpcNode[];
  readonly edges: readonly NpcEdge[];
}

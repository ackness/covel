# NPC Graph + Graph-RAG Architecture

> Single-page reference for the `npc-graph` plugin and its supporting
> infrastructure across `@covel/store`, `@covel/shared`, and `@covel/web`.

## Why

Inspired by [MiroFish](https://github.com/666ghj/MiroFish), but built
without external graph services (no Zep, no Neo4j). The goal is a
self-contained **session-scoped knowledge graph** that:

1. Tracks NPCs, factions, and the relationships the LLM mentions
2. Survives across turns and re-injects relevant relationship facts
   into the narrator prompt so character behaviour stays consistent
3. Provides a live force-directed visualization in the right panel
4. Stays optional — every backend (Memory / SQLite / Postgres / IDB)
   keeps working whether or not the vector capability is available

## Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│  Player turn N                                                       │
└──────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  stage: pre-turn — npc-graph/rag-retriever (function runtime)   │
│                                                                      │
│  • reads playerMessage                                               │
│  • loads nodes/edges/index from plugin_data                          │
│  • name + alias matching → seed nodes                                │
│  • 2-hop BFS via adjacency index                                     │
│  • time filter (validAt / invalidAt)                                 │
│  • rank by (validAt desc, |strength| desc), top-20                   │
│  • emits npcContext markdown via runtime output                      │
└──────────────────────────────────────────────────────────────────────┘
        │
        ▼ injected via input.inject as <npc-relationships>
┌──────────────────────────────────────────────────────────────────────┐
│  stage: narrative — narrator (agent runtime)                    │
│                                                                      │
│  • sees prior facts in <npc-relationships> tag                       │
│  • generates narrative consistent with established trust/enmity      │
└──────────────────────────────────────────────────────────────────────┘
        │
        ▼ narrative output
┌──────────────────────────────────────────────────────────────────────┐
│  stage: post-turn — npc-graph/extractor (agent runtime)         │
│                                                                      │
│  • LLM reads <narrator-output> + the existing graph, both already    │
│    in the prompt (input.inject pulls nodes/edges as                  │
│    <existing-npcs> / <existing-relations>) — no per-turn list call   │
│  • calls upsert-npc-graph to write; list-npc-graph only on demand,   │
│    when a truncated summary hides the full `fact` it needs           │
│  • upsert tool maintains nodes/edges/index in plugin_data            │
└──────────────────────────────────────────────────────────────────────┘
        │
        ▼ plugin-data.changed SSE
┌──────────────────────────────────────────────────────────────────────┐
│  apps/web right panel: GraphCanvas (lazy)                            │
│                                                                      │
│  • react-force-graph-2d, lazy-loaded chunk                           │
│  • reads pluginData[npc-graph][nodes/edges] live                │
│  • node colour by type, edge colour by sign of strength              │
│  • click → in-panel detail card                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Model

Defined in `packages/shared/src/types/npc-graph.ts`.

```ts
type NpcNodeType = "individual" | "group" | "faction";

interface NpcNode {
  id: string; // short ID, e.g. "npc-0a7c"
  name: string; // canonical, used for LLM joins
  aliases?: readonly string[];
  type: NpcNodeType;
  labels: readonly string[]; // ontology tags, max 5
  summary: string; // ≤200 chars
  firstSeenTurn: number;
  lastSeenTurn: number;
  attributes?: Readonly<Record<string, unknown>>;
}

interface NpcEdge {
  id: string; // short ID, e.g. "edge-1f3a"
  source: string; // node ID
  target: string; // node ID
  relation: string; // UPPER_SNAKE_CASE
  strength: number; // [-1, 1]
  fact: string; // single sentence — RAG unit
  validAt: number;
  invalidAt?: number; // end of the fact's validity interval
  evidenceTurnIds: readonly string[];
}
```

## Storage Layout

All persisted via `plugin_data` under `pluginId = 'npc-graph'`:

| namespace | key                  | value                 |
| --------- | -------------------- | --------------------- |
| `nodes`   | `{npcId}`            | `NpcNode`             |
| `edges`   | `{edgeId}`           | `NpcEdge`             |
| `index`   | `by-source:{nodeId}` | `string[]` (edge IDs) |
| `index`   | `by-target:{nodeId}` | `string[]` (edge IDs) |
| `meta`    | `ontology`           | `NpcGraphOntology`    |

The adjacency index is maintained inside `upsert-npc-graph` so the
retriever can do O(1) neighbour lookups instead of scanning all edges.

## Plugin Tools

`plugins/npc-graph/tools/`:

- **`list-npc-graph.js`** — returns compact summaries of nodes and
  edges so the LLM can avoid duplicate creates without paging through
  the full plugin_data.
- **`upsert-npc-graph.js`** — the heavy-lift tool. Resolves node IDs
  by name (case-insensitive), assigns short IDs to new nodes via
  `shortIdBatch`, merges aliases / labels / summary / attributes into
  existing nodes, de-duplicates edges by `(source, target, relation)`,
  and refreshes the adjacency index in one transaction.

Both tools follow the existing zero-dep injection pattern:
`({ tool, z, shortIdBatch, store }) => tool({ ... })`.

## Embedding And Vector Capabilities

The `npc-graph` retriever currently uses deterministic name and alias matching
followed by a two-hop graph traversal. It does not generate embeddings or query
the vector store, so the plugin does not require an embedding slot.

The framework has lower-level primitives that other features can use:

- `@covel/ai-provider` supports embedding requests through its internal gateway.
  Example embedding slots in `llm.toml`:

  ```toml
  [covel.embed-default]
  provider = "ollama"
  model    = "nomic-embed-text-v2-moe"
  baseUrl  = "http://localhost:11434/v1"
  protocol = "openai-chat-v1"
  output   = ["embedding"]

  [covel.embed-multimodal]
  provider = "openrouter"
  model    = "nvidia/llama-nemotron-embed-vl-1b-v2:free"
  baseUrl  = "https://openrouter.ai/api/v1"
  protocol = "openai-chat-v1"
  output   = ["embedding"]
  embeddingFormat = "nemotron-multimodal"
  ```

- `@covel/store` exposes the optional `VectorStoreCapability`. MemoryStore uses
  an in-memory brute-force implementation, SqliteStore uses `sqlite-vec`, and
  PgStore uses `pgvector`. Vector rows are partitioned by session and can be
  filtered by plugin, namespace, and data key.

These capabilities are independent of the plugin's current structured
retrieval path.

## Visualization

`apps/web/src/lib/graph-canvas.tsx` registers a `GraphCanvas`
component into the shared json-render catalog. The component is
lazy-loaded so the d3-force/canvas bundle (~60KB gzipped) only ships
when the user opens the panel. It reads from the live pluginData
store, so SSE-driven mutations re-render automatically.

The plugin's right-panel spec lives at
`plugins/npc-graph/runtimes/extractor/ui/npc-graph-panel.json`:

```json
{
  "id": "npc-graph",
  "icon": "network",
  "label": { "zh": "人物图谱", "en": "NPC Graph" },
  "view": {
    "component": "GraphCanvas",
    "props": {
      "pluginId": "npc-graph",
      "nodesNamespace": "nodes",
      "edgesNamespace": "edges",
      "height": 480
    }
  }
}
```

## Cross-references

- `docs/reference/plugins.md` — full plugin registry with both runtimes
- `docs/reference/ui-panels.md` — GraphCanvas catalog entry
- `docs/reference/tools.md` — upsert-npc-graph and list-npc-graph
- `packages/shared/src/types/npc-graph.ts` — type source of truth
- `plugins/npc-graph/` — the plugin itself
- `apps/web/src/lib/graph-canvas.tsx` — visualization component
- `plugins/npc-graph/tests/` — plugin contract and integration tests

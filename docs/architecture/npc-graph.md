# NPC Graph + Graph-RAG Architecture

> Single-page reference for the `npc-graph` plugin and its
> supporting infrastructure across `@covel/ai-provider`, `@covel/store`,
> `@covel/shared`, and `@covel/web`. For implementation history see
> the Phase 0–4 commits on this branch.

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
  invalidAt?: number; // bitemporal expiry (Phase 4 placeholder)
  evidenceTurnIds: readonly string[];
}
```

## Storage Layout

All persisted via `plugin_data` under `pluginId = 'npc-graph'`:

| namespace | key                  | value                           |
| --------- | -------------------- | ------------------------------- |
| `nodes`   | `{npcId}`            | `NpcNode`                       |
| `edges`   | `{edgeId}`           | `NpcEdge`                       |
| `index`   | `by-source:{nodeId}` | `string[]` (edge IDs)           |
| `index`   | `by-target:{nodeId}` | `string[]` (edge IDs)           |
| `meta`    | `ontology`           | `NpcGraphOntology` (Phase 3.5+) |

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

## Embedding & Vector Layer (Phase 1, currently latent)

Wired and tested but not yet consumed by the retriever. The framework
blocker is **gone**: `FunctionHandlerContext.gateway` (an optional
`PluginRuntimeGateway` facade, `packages/plugin-loader/src/types.ts`) already
exposes LLM / image / embedding access to function runtimes, and its calls are
traced as `gateway.calling` / `gateway.responded` / `gateway.failed`. Phase 3.5
is now plugin-side work only.

- `@covel/ai-provider` — `gateway.embed()` already routes through
  `openai-chat.ts:embed()` to either Ollama (local default) or
  OpenRouter (Nemotron multimodal). Slot config in `llm.toml`:

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

- `@covel/store` — `VectorStoreCapability` is an _optional_ interface
  alongside `DataStore`. SqliteStore implements it via `sqlite-vec`
  (lazy `vec_memory_f{dim}` virtual tables, partition key on
  `session_id`, metadata filter on `plugin_id`/`namespace`/`data_key`).
  MemoryStore implements an in-memory brute-force fallback.
  PgStore exports a pgvector skeleton + bootstrap SQL but the methods
  currently throw — Phase 2 of the vector layer will fill it in.

- Validation evidence lives under `scripts/embedding-bench/` and
  `debugs/embedding/` (Phase 0).

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

## Test Coverage

| Suite                            | Count  | Location                      |
| -------------------------------- | ------ | ----------------------------- |
| Manifest discovery               | 3      | `tests/npc-graph.test.js`     |
| upsert-npc-graph behaviour       | 5      | `tests/npc-graph.test.js`     |
| rag-retriever handler            | 7      | `tests/rag-retriever.test.js` |
| End-to-end extractor → retriever | 3      | `tests/integration.test.js`   |
| **Total**                        | **18** |                               |

Plus the `@covel/store` vector-contract suite (MemoryStore and SqliteStore
backends) and the `@covel/ai-provider` embedding-path tests (loader /
openai-chat dispatch / gateway routing). Exact counts drift with every
commit — run `pnpm test` for the current numbers rather than trusting a
figure written here.

## Phase Status

| Phase | Scope                                                                                                                                     | Commit    | Status                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| 0     | Bench scripts validating Ollama, Nemotron, sqlite-vec, end-to-end                                                                         | `e513e61` | ✅                                                                                  |
| 1     | Embedding layer in `@covel/ai-provider`, VectorStoreCapability in `@covel/store`, sqlite-vec + memory + pgvector skeleton, contract tests | `b5776b6` | ✅                                                                                  |
| 2     | NPC graph data model, plugin scaffolding, upsert/list tools                                                                               | `1d2d68a` | ✅                                                                                  |
| 3     | rag-retriever function runtime + narrator inject + 2-hop structured retrieval                                                             | `87a77ae` | ✅                                                                                  |
| 3.5   | Switch retriever to embedding-backed hybrid retrieval                                                                                     | —         | deferred — framework side unblocked (`ctx.gateway` exists); plugin work not started |
| 4     | GraphCanvas component + lazy-loaded force-graph + plugin UI spec                                                                          | `33f44e3` | ✅                                                                                  |
| 5     | Integration test + this architecture doc                                                                                                  | (current) | ✅                                                                                  |

## Phase 3.5 — The Vector Upgrade Path

The retriever currently does name matching + structured BFS. To
upgrade to true Graph-RAG (embed query → vector search → expand)
without breaking the existing tests, the cleanest path is:

1. ~~Extend `FunctionHandlerContext` with an optional `gateway` reference.~~
   **Already done** — `ctx.gateway` is a live `PluginRuntimeGateway` facade
   (handlers must still null-check it: harnesses may construct a context
   without one).
2. In `npc-graph/extractor`, after `upsert-npc-graph` returns,
   embed each newly-written `edge.fact` via `gateway.embed()` and
   call `store.upsertVector()` (using `supportsVector(store)` as a
   feature flag). Skip silently when the store can't store vectors.
3. In `npc-graph/rag-retriever`, prepend a vector search step:
   embed `playerMessage` once, query `store.searchVectors()` for the
   top-20 edge IDs, then use those edge endpoints as additional seeds
   for the existing BFS expansion.
4. Document the new dependency on a configured embedding slot in
   `docs/reference/embeddings.md` (TODO).

The structured fallback already covers the no-embedding case, so the
upgrade is purely additive — old sessions and embeddings-disabled
deployments keep working.

## Cross-references

- `docs/reference/plugins.md` — full plugin registry with both runtimes
- `docs/reference/ui-panels.md` — GraphCanvas catalog entry
- `docs/reference/tools.md` — upsert-npc-graph and list-npc-graph
- `packages/shared/src/types/npc-graph.ts` — type source of truth
- `plugins/npc-graph/` — the plugin itself
- `apps/web/src/lib/graph-canvas.tsx` — visualization component
- `scripts/embedding-bench/` — Phase 0 validation harness

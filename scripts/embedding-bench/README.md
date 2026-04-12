# Embedding Bench — Phase 0 Validation Scripts

Purpose: validate every building block of the planned NPC-graph + Graph-RAG feature
**before** writing any production code. Each script is standalone, imports from the
repo root `node_modules/`, and writes human-inspectable artifacts under `debugs/embedding/`.

**Do not** import anything from these scripts into `packages/` or `apps/`. Phase 1 will
port the validated logic into `@covel/ai-provider` and `@covel/store`.

## Scripts

| # | Script | What it proves | Network | Requires |
|---|--------|----------------|---------|----------|
| 01 | `01-ollama-smoke.ts` | Vercel AI SDK `embedMany` works against local Ollama via OpenAI-compatible endpoint | local Ollama | `ollama serve` + embed model pulled |
| 02 | `02-openrouter-nemotron-custom.ts` | OpenRouter accepts the non-standard multimodal `content: [{type, ...}]` embeddings request body for `nvidia/llama-nemotron-embed-vl-1b-v2:free` | OpenRouter | `OPENROUTER_API_KEY` |
| 03 | `03-sqlite-vec-smoke.ts` | `sqlite-vec` loads into `better-sqlite3`, vec0 virtual tables support partition key + metadata columns + aux columns, hybrid metadata-filtered KNN works, multiple dims coexist | none | — |
| 04 | `04-embed-store-e2e.ts` | End-to-end: chunk real world lore → Ollama embed → upsert to sqlite-vec → semantic query retrieves relevant chunks | local Ollama | `ollama serve` + embed model pulled |

## Prerequisites

### 1. Ollama (for 01 and 04)

```bash
# macOS
brew install ollama
ollama serve &

# pull the default embed model used by the plan
ollama pull nomic-embed-text-v2-moe

# or fall back to the standard one
ollama pull nomic-embed-text
OLLAMA_EMBED_MODEL=nomic-embed-text npx tsx scripts/embedding-bench/01-ollama-smoke.ts
```

Health check:

```bash
curl http://localhost:11434/api/tags
```

### 2. OpenRouter API key (for 02)

Add to `.env.llm`:

```
OPENROUTER_API_KEY=sk-or-v1-xxx
```

### 3. No setup needed for 03

`sqlite-vec` ships prebuilt binaries for macOS arm64 / Linux x64 / Windows x64.
`better-sqlite3` is already a workspace dep.

## Running

From repo root:

```bash
# 03 — zero network, safest to run first
npx tsx scripts/embedding-bench/03-sqlite-vec-smoke.ts

# 01 — after Ollama is running
npx tsx scripts/embedding-bench/01-ollama-smoke.ts

# 02 — after adding OPENROUTER_API_KEY to .env.llm
npx tsx --env-file=.env.llm scripts/embedding-bench/02-openrouter-nemotron-custom.ts

# 04 — end to end (needs Ollama)
npx tsx scripts/embedding-bench/04-embed-store-e2e.ts
```

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | 01, 04 |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text-v2-moe` | 01, 04 |
| `OLLAMA_API_KEY` | `ollama-local` (dummy) | 01, 04 — Ollama ignores it but the SDK requires a non-empty string |
| `OPENROUTER_API_KEY` | — | 02 |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | 02 |

## Expected artifacts

After a successful run, `debugs/embedding/` should contain:

- `ollama-smoke.json` — 01 summary (dims, usage, first/last vector preview)
- `nemotron-multimodal.json` — 02 per-case result (text-only ok? text+image ok? what dim?)
- `sqlite-vec-smoke.log` — 03 full stdout (DDL, KNN results, filter consistency)
- `e2e-result.md` — 04 markdown table of query → top-3 chunks with distances, plus a human verdict section

## Phase 0 acceptance gate

All four scripts must succeed **and** the human verdict in `e2e-result.md` must be ✅
before Phase 1 (writing production embedding adapters in `@covel/ai-provider` and
`VectorStore` capability in `@covel/store`) starts.

If a script fails, do NOT proceed to Phase 1 — adjust the plan (e.g. swap the Vercel AI SDK
path for direct fetch, pick a different Ollama model, fall back to pgvector) and re-run.

## Why raw fetch for script 02?

`@openrouter/ai-sdk-provider` is text-only — its `OpenRouterEmbeddingSettings` has no
multimodal `content` field and all its e2e tests only pass `value: string`. The Nemotron
model requires a non-standard `content: [{type: "text"|"image_url", ...}]` array shape
in the `input` field. Script 02 uses raw `fetch` to validate the *upstream HTTP contract*
first; Phase 1 will wrap this as a proper `EmbeddingModelV2<NemotronInput>` custom
provider once we know the shape works end-to-end.

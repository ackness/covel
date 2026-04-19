# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Covel is an AI RPG plugin-based framework (modular monolith architecture). Core philosophy: **plugins carry gameplay logic, the kernel provides primitives and orchestration**. The system provides a workbench UI for interactive storytelling/gameplay, backed by a plugin-driven kernel that orchestrates LLM calls, context assembly, and turn execution.

Detailed architecture docs: `devs/docs/` (refactor plans, plugin system requirements, prompt/world specs). Framework reference: `docs/reference/` (plugins, tools registries).

## Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Start both web (5173) and server (3001) in dev mode
pnpm dev:web              # Start only web frontend
pnpm dev:server           # Start only API server (MemoryStore backend)
pnpm dev:pg               # Start only API server with STORE_BACKEND=pg
pnpm build                # Build all packages
pnpm lint                 # Lint all packages (tsc --noEmit)
pnpm test                 # Run all tests (vitest via turbo, cached)
pnpm test:coverage        # Run all tests with coverage report
pnpm clean                # Clean all dist directories

# Database (PostgreSQL via Docker)
pnpm db:up                # Start PostgreSQL container only
pnpm db:down              # Stop all containers
pnpm db:generate          # Generate Drizzle migrations
pnpm db:migrate           # Run Drizzle migrations
pnpm db:studio            # Open Drizzle Studio

# Tests (vitest — all packages)
pnpm --filter @covel/runtime test          # Run runtime tests
pnpm --filter @covel/context test          # Run context tests
pnpm --filter @covel/plugin-loader test    # Run plugin-loader tests
pnpm --filter @covel/store test            # Run store tests
pnpm --filter @covel/ai-provider test      # Run ai-provider tests
pnpm --filter @covel/server test           # Run server tests
pnpm --filter @covel/plugin-test-utils test # Run test-utils tests
# Add --watch for watch mode, --run for single run

# E2E scripts (real LLM, requires .env.llm)
npx tsx --env-file=.env --env-file=.env.llm scripts/test-full-3plugins.ts
# Plugin-level e2e harness — API-driven, auto-discovers plugins, observes per-runtime
# See docs/guide/e2e-plugin-verify.md for CLI reference and 7-phase pipeline
npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts --slot e2e_local --turns 3

# E2E tests (Playwright)
pnpm e2e                  # Run all E2E tests headless
pnpm e2e:ui               # Open Playwright UI mode
pnpm e2e:docker           # Build+start full Docker stack, run E2E, then tear down

# Docker (full-stack production image)
pnpm docker:build         # Build and start app + PostgreSQL containers
pnpm docker:up            # Start app + PostgreSQL containers (no rebuild)
pnpm docker:down          # Stop containers (keep volumes)
pnpm docker:logs          # Tail container logs
```

## Config File Setup

Three config files are needed (copy from examples):

```bash
cp .env.example .env               # DB, store backend, server settings
cp llm.toml.example llm.toml       # LLM provider slots (story, utility, image…)
cp .env.llm.example .env.llm       # LLM provider API keys
```

- `.env` — infrastructure config (`STORE_BACKEND`, `DATABASE_URL`, `SERVER_PORT`, etc.)
- `llm.toml` — slot-based model routing (see `llm.toml.example` for provider examples)
- `.env.llm` — API keys per provider (e.g. `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`); loaded alongside `.env` by the dev server

The dev server (`tsx watch`) loads both `../../.env` and `../../.env.llm` from the repo root.

## Monorepo Structure

- **pnpm workspaces** + **Turborepo** for task orchestration
- Package manager: `pnpm@10.7.0`, Node.js `>=20.19.0`
- ESM-only (`"type": "module"`), TypeScript strict mode, target ES2022
- All packages use direct TypeScript source exports (`"import": "./src/index.ts"` — no build step for dev)
- Use `.js` extensions in TypeScript imports (NodeNext module resolution)

### Workspace Layout

```
apps/
  web/              @covel/web              — React 19 + Vite 8 + TailwindCSS v4 + TanStack Router (legacy, being replaced)
  web-v2/           @covel/web-v2           — Plugin-driven frontend: json-render + dynamic panels (port 5174)
  server/           @covel/server           — Hono API server + Drizzle ORM

packages/
  shared/           @covel/shared           — Shared types and contracts (pure types, zero runtime deps)
  context/          @covel/context          — Context assembly (template interpolation, inject blocks, prompt building)
  ai-provider/      @covel/ai-provider      — Multi-provider LLM abstraction (preset routing, model capability auto-detection, 2597-model LiteLLM database)
  plugin-loader/    @covel/plugin-loader    — Plugin discovery, PLUGIN.md parsing, progressive loading, registry, session scope
  runtime/          @covel/runtime          — Turn execution engine (trigger → schedule → context → LLM → tool loop → result) + PR-3 plugin RPC registry/executor/defaults + PR-6 runtime-slot-resolver
  store/            @covel/store            — Data abstraction with 4 backends: MemoryStore, SqliteStore, IdbStore (IndexedDB), PgStore (PostgreSQL)
  state/            @covel/state            — State management (dynamic tables, change history, write conflict collection)
  events/           @covel/events           — Event bus (pub/sub, event persistence)
  tools/            @covel/tools            — Tool system (tool() wrapper, registry, builtin UI tools, short ID generator, output validation)
  approval/         @covel/approval         — Approval pipeline (permission rules, approval gates, PR-7 RPC approval gate with once/session scope + pending queue cap)
  lorebook/         @covel/lorebook         — World/plugin/session lorebook entries (constant + selective scanning, NovelAI-style Reserved Tokens budget)
  plugin-test-utils/ @covel/plugin-test-utils — Testing utilities for plugin authors (MockLLM, TestHarness, factories)

plugins/                    — Core gameplay plugins (PLUGIN.md-centric, see Plugin Inventory below)
  core-pregame/             — Game initialization (priority 0, first turn only)
  core-world-init/          — World dimension initialization (guard + agent runtime)
  core-narrator/            — Main narrative generation
  core-guide/               — Action guidance + choice panels (after narrator)
  core-npc-graph/           — NPC relationship graph + Graph-RAG memory (MiroFish-inspired)
  core-codex/               — Knowledge codex with local tools
  core-char-creator/        — Character subsystem (player-init + character-tracker runtimes)

prompts/                    — Externalized prompt templates (locale-aware markdown)
  server/                   — Server route prompts (generate-world, extract-dimensions)

worlds/                     — File-based world packages (YAML manifest + markdown lore)
  cloudmere/                — World package
  mistport/                 — World package
  neonridge/                — World package
```

### Dependency Flow

```
@covel/shared  ←  @covel/context  ←  @covel/runtime  ←  @covel/server (composes all)
                  @covel/ai-provider ←─────────────────────┘
                  @covel/plugin-loader ←────────────────────┘
                  @covel/store ←────────────────────────────┘
                  @covel/state ←────────────────────────────┘
                  @covel/events ←───────────────────────────┘
                  @covel/tools ←────────────────────────────┘
                  @covel/approval
                  @covel/lorebook   (depends on @covel/context for TokenEstimator)
                  @covel/plugin-test-utils (dev/test only)
```

## Architecture

### Core Execution Primitives

First-class execution primitives: **Runtime, Tool, Hook, Context, Proposal** — not plugins. A Plugin Package is a distribution/packaging unit that declares and bundles these primitives.

### Five-Layer Architecture

1. **Experience Layer** — Game UI, editing, plugin config, branching
2. **Application Layer** — Run management, asset assembly, fork/restore
3. **Runtime Kernel** — Router, scheduler, context, runner, commit
4. **Extension Layer** — Plugins, runtimes, tools, hooks, UI slots
5. **Infrastructure Layer** — Storage, queue, providers, tracing

### Server Bootstrap

`bootstrapApi()` in `apps/server/src/routes/api/bootstrap.ts` creates a fully wired Hono app: discovers plugins, creates registries, injects dependencies into routes via middleware. `app.ts` is a thin composition root (~80 lines): middleware → init → mount routes. Model DB routes live in `routes/model-db.ts`. All API endpoints are under the `/api/` prefix.

### Turn Execution Pipeline

Each turn follows a fixed pipeline (`packages/runtime`):

```
Input/Event → Trigger Router → Priority Scheduler → [For each priority group:]
  → TurnContextStore.init() → PromptAssembler.build() → Runtime Runner
  → Tool/Hook Loop → Proposal Collector → TurnContextStore.ingest()
→ Validation/Policy → Commit Service → Render/Side Effects
→ Follow-up Events (may re-enter Router)
```

Key stages:
1. **Trigger Router** — event type identification, `RuntimeTriggerEvent` generation, candidate filtering by trigger rules (modes: `always`, `interval`, `manual`, `event`)
2. **Priority Scheduler** — sort by `priority` (0-1000, default 500). 0 = highest = first. Same priority = parallel group. See **Priority Bands (kernel-enforced)** below for the turn-band filter applied before each group executes.
3. **Context Assembly** — `TurnContextStore` accumulates turn context across 10 slices (chat, world, characters, state, record, events, runtime, runtimeSettings, narrative, archive); `PromptAssembler` builds per-runtime prompts (instructions + sections + previous outputs); `Compactor` handles long-session history compaction
4. **Runtime Runner** — two modes: `runtimeType: 'agent'` (default) loads PLUGIN.md, binds provider/tools/hooks/budget, drives LLM tool-calling loop; `runtimeType: 'function'` directly calls a JS handler function without LLM. `maxSteps`/`timeoutMs` = hard limits, `maxTokens` = best-effort
5. **Tool/Hook Loop** — whitelisted tools; hooks at lifecycle points: `TurnStart`, `PreToolUse`, `PostToolUse`, `PreStateCommit`, `PostStateCommit`, `TurnStop`
6. **Proposal Collector** — normalizes to `KernelProposalEnvelope`: `narrative.append`, `state.patch`, `event.emit`, `record.upsert`, `ui.render`, `asset.generate`
7. **Commit Chain** — `proposal → validate → commit`. All writes go through this chain. Plugins never write directly to DB.

### Priority Bands (kernel-enforced)

| Turn | Scheduled priority range | Phase |
|------|-------------------------|-------|
| 0    | 0-99                    | Pre-Game (may iterate multiple player submissions) |
| ≥1   | 100-1000                | Main loop: Pre-Turn 100-499, Narrator 500, After-Turn 501-999, Audit 1000 |

The scheduler filters runtimes by the turn-number band before executing each group. Pre-Game runtimes report `preGameDone: true` in their output to mark session-level completion; the kernel tracks these in `SessionRecord.preGameCompleted` and advances `turnCount` from 0 to 1 once all Pre-Game band runtimes report done. Runtimes that hit `maxTriggerCount` or are skipped by a guard are also marked done.

### Plugin System

Plugins declare capabilities in `plugin.json` manifests. Structure:

```
plugin/
  plugin.json      — Manifest: capabilities, metadata, i18n, blockSchemas
  PLUGIN.md        — Runtime instructions (= LLM agent skill prompt)
  prompts/         — Externalized locale-aware prompt templates (<name>.zh.md, <name>.en.md)
  schemas/         — Input/output schemas
  server/          — Runtime / tool / hook implementations
  client/          — UI slot extensions
```

**Session-scoped activation**: Global pool loaded at startup; each `KernelSession` has a `SessionPluginScope` (Set of active plugin IDs). Scoped registry views (`ScopedRuntimeRegistry`, `ScopedToolRegistry`, `ScopedHookRegistry`) filter by active set. Enable/disable mid-session; changes apply on next turn. World manifest `requiredPlugins`/`recommendedPlugins` seed initial set.

**Plugin source trust**: builtin (auto-load, green badge), official (whitelist, green), community (user confirm required, orange/red warning).

**Trigger modes**: `always`, `interval` (every N turns), `manual` (button press), `event` (context threshold, goal achievement, session start, explicit events).

### Plugin Inventory

Current plugins (PLUGIN.md-centric format):

| Priority | Plugin | Role | Trigger |
|----------|--------|------|---------|
| 10 | core-pregame | Game initialization (function runtime, no LLM, Pre-Game band) | scheduled (maxTriggerCount=1) |
| 50 | core-char-creator/player-init | Player character creation (Pre-Game band) | auto |
| 85 | core-world-init/schema-gen | World dimension schema + entries via LLM (Pre-Game band, guard skips if data exists) | scheduled (maxTriggerCount=1) |
| 500 | core-narrator | Main narrative generation | auto (every turn) |
| 550 | core-guide | Action guidance + choice panels (analyzes narrator output) | scheduled (interval=1, cooldown=1) |
| 620 | core-npc-graph | NPC relationship graph + Graph-RAG memory (capabilities: `npc-graph`, `relationship-tracking`) | scheduled (interval=2, cooldown=1) |
| 650 | core-codex | Knowledge/lore codex with persistent plugin-data | scheduled (interval=2, cooldown=1) |
| 750 | core-char-creator/character-tracker | NPC detection + character state tracking | scheduled (interval=1, cooldown=1) |

**UI-only plugins** (no runtime scheduling): `core-memory` — contributes UI panels/blocks only, not included in the scheduler.

Additional plugins planned: core-persona, core-combat, core-inventory, core-quest, core-image, etc.

### Plugin UI System (Declarative Panels)

Plugins declare UI contributions via `ui:` field in PLUGIN.md frontmatter, referencing external JSON files:

```yaml
ui:
  right:      # Right sidebar panel tabs
    - ./ui/my-panel.json
  message:    # Inline message blocks
    - ./ui/my-block.json
  left:       # Left sidebar content
    - ./ui/my-settings.json
```

**Rendering**: All UI is rendered via [json-render](https://github.com/vercel-labs/json-render) with a framework-defined component catalog (~25 components). Plugins compose UI from these primitives — no React code needed.

**Three-tier resolution**: Custom React (`.tsx` in `client/`) → json-render spec (`.json` in `ui/`) → raw JSON fallback.

**Data flow**: Plugin tools write to plugin-data store → `plugin-data.changed` SSE event → frontend `pluginData` state → json-render re-renders panels.

**API**: `GET /api/ui-specs` aggregates all plugin UI declarations by slot (right/message/left). Frontend discovers panels at boot and renders dynamically.

**Right panel**: VSCode-style vertical activity bar. Each plugin declaring `ui.right` gets an icon tab. No hardcoded tabs — entirely plugin-driven (except World tab which is framework-owned).

### Plugin Data Storage

Plugins have session-scoped persistent KV storage via the `plugin_data` table. Data is isolated by `(sessionId, pluginId, namespace, key)`.

**Builtin tools** (available to all agent runtimes):
- `plugin-data-set` — write plugin data
- `plugin-data-get` — read own plugin's data (cross-plugin read removed for security)
- `plugin-data-list` — list own plugin's entries in a namespace
- `create-character`, `update-character`, `list-characters`, `get-character` — character subsystem (writes `characters` table, mirrors to caller plugin's `plugin_data[namespace="characters"]` for panel reactivity; list/get are session-scoped, cross-plugin visible)

**REST API**: `GET/PUT/DELETE /api/session/:id/plugin-data/:pluginId/:namespace/:key`

**Context injection**: Plugin data from `core-world-init` is pre-loaded at turn start and injected via `getConfig` → `{{ config.worldSchema }}`, `{{ config.worldEntries }}`, `{{ config.worldDimensions }}`. Latest player form submission is exposed via `{{ player.lastFormValues }}` (JSON string) — plugins read this to process form submissions without server-side magic.

**Self plugin-data injection** (agent runtimes only): `input.inject` supports a `kind: plugin-data` source that reads the runtime's OWN plugin-data namespace and inlines a summarised view into the system prompt. This avoids a tool-call round-trip for "increment-maintaining" plugins (codex, character-tracker, extractor). Declared in PLUGIN.md:
```yaml
input:
  inject:
    - kind: plugin-data
      namespace: entries
      as: "<existing-entries>"
      format: summary   # or: ids-only | full
      maxEntries: 100
```
When any manifest declares a `kind: plugin-data` inject, `turn-executor` switches that runtime to `buildContextAsync` which calls `store.listPluginData(sessionId, pluginId, namespace)` during prompt build. Other runtimes stay on the sync `buildContext` path. Two-pass truncation (oldest anchors + recent active) keeps old entries visible even in late-session turns; store errors propagate to runtime failure (never leak into downstream context per Phase 0 isolation audit). Cross-plugin reads are intentionally not supported.

### Model Slot System

Named slots for provider routing. The first slot defined in `llm.toml` automatically becomes `default`; its original name is also accessible:
- `default` — main narrative, complex reasoning (auto-aliased to first slot)
- `fast` — plugin default, lightweight judgment
- `balance` — referee plugins, complex logic
- `image` — image generation (optional)

Unconfigured slots fall back to `default`. Primary config via `llm.toml` using `[covel.<slot>]` sections (see `llm.toml.example`), legacy fallback to `packages/ai-provider/presets/default.toml`. Supports OpenAI, Anthropic, DeepSeek, Qwen (Aliyun DashScope) protocols.

**API key security**: Keys in browser localStorage only, passed per-request via `X-Provider-Keys` header (base64), never persisted server-side.

### Model Capability System

Each slot's model capabilities (multimodal support, features, token limits, pricing) are auto-detected via multi-source resolution:

1. **Frontend user overrides** (localStorage `covel:capabilityOverrides`) — highest priority
2. **`llm.toml` manual fields** (`input`/`output`/`features`/`contextWindow`/`maxOutputTokens`/`pricing`)
3. **Hand-curated known models** (`capability/known-models.ts`, ~60 common models)
4. **LiteLLM full database** (`data/model-db.json`, 2597 models, updatable from GitHub)
5. **Protocol defaults** — lowest priority

**Directional modality design** (follows OpenRouter taxonomy):
- `input: InputModality[]` = what the model ACCEPTS (e.g. `["text", "image"]` = vision)
- `output: OutputModality[]` = what the model PRODUCES (e.g. `["image"]` = image generation)
- `"image"` in input ≠ `"image"` in output. Same for audio (transcription vs synthesis).

Types: `InputModality` = `text | image | audio | video | file`; `OutputModality` = `text | image | audio | embedding`; `ModelFeature` = `function_calling | structured_output | streaming | reasoning | vision | prompt_caching | web_search | computer_use`.

**Update command**: `pnpm --filter @covel/ai-provider update-model-db` refreshes the bundled `data/model-db.json`.

### Prompt Externalization

All LLM prompts are externalized as locale-aware markdown files (see `devs/docs/prompt-externalization-spec.md`):

- Server prompts: `prompts/server/<name>.md`
- Plugin prompts: `plugins/<plugin>/prompts/<name>.{zh,en}.md`
- Template variables: `{{variable}}` syntax
- Locale resolution: exact match → language fallback → no-locale default → error
- API: `loadPrompt(dir, name, locale)`, `interpolate(template, vars)` from `@covel/context`

### World Package System

File-based world content format (see `devs/docs/world-package-spec.md`):

```
worlds/<world-id>/
  world.yaml       — Manifest (schemaVersion, id, name, summary, dimensions, plugin deps)
  WORLD.md         — Default lore (fallback)
  WORLD.zh.md      — Chinese lore
  WORLD.en.md      — English lore
```

- Manifest validated with Zod (`worldPackageMetaSchema`)
- Names use `I18nText` (`string | Record<string, string>`)
- `requiredPlugins`/`recommendedPlugins` seed session plugin set
- `dimensions` (geography, factions, etc.) can be AI-extracted from lore via `/api/ai/extract-dimensions`

### Schema-Driven Block Rendering

Three-tier resolution for plugin UI:
1. **Custom Renderer** — hand-written React component
2. **Schema Renderer** — auto-generated from `blockSchemas` in plugin.json (JSON Schema → dynamic form/display)
3. **Raw Fallback** — JSON display (dev/debug)

### State & Persistence

Core runtime objects (never collapse into single JSON):
- **Run** — session root
- **Branch** — world-line branch
- **Snapshot** — restorable state point
- **State** — current structured facts (key-value with scope)
- **Event** — append-only business events
- **Record** — searchable long-term knowledge (characters, quests, etc.)
- **Character** — dynamic character cards (evolved through gameplay, not static templates)
- **PluginData** — plugin-scoped persistent KV storage, isolated by `(sessionId, pluginId, namespace, key)`

Session lifecycle is tracked via three fields:
- `status: SessionStatus` = `'active' | 'paused' | 'ended'`. `paused`/`ended` halts scheduling.
- `turnCount: number` = band selector. `0` = Pre-Game band (priority 0-99 scheduled). `>=1` = main loop (priority 100-1000 scheduled). Kernel auto-advances from 0 → 1 when all Pre-Game runtimes report `preGameDone`.
- `preGameCompleted: string[]` = runtimeIds of Pre-Game runtimes that have finished their one-time initialization work.

Store backends (`@covel/store`): MemoryStore (dev/test), IdbStore (browser IndexedDB), PgStore (production PostgreSQL via Drizzle ORM).

**Store selection** (server startup): `STORE_BACKEND=pg` + `DATABASE_URL` → PgStore, otherwise MemoryStore. World seeds loaded from `COVEL_WORLDS_DIR` (default: `worlds/`).

### Server Route Layout

All endpoints under `/api/` prefix (Vite dev server proxies `/api` → backend). RESTful convention: resources use plural nouns.

- Sessions (CRUD): `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/:id` (PATCH accepts `status` + PR-6 `runtimeModelOverrides` map of runtime-id → slot)
- Session Turn: `POST /api/sessions/:id/turn`, `GET /api/sessions/:id/turns`, `GET /api/sessions/:id/results`
- Session Messages: `GET /api/sessions/:id/messages`, `POST /api/sessions/:id/messages/sync`
- Session Plugins: `GET /api/sessions/:id/plugins`, `POST /api/sessions/:id/plugins/enable`, `POST /api/sessions/:id/plugins/disable`
- Session State: `GET /api/sessions/:id/state`, `GET /api/sessions/:id/state/:table`, `GET /api/sessions/:id/state/:table/:field/history`
- Session State Persistence: `GET/PUT /api/sessions/:id/state-snapshot`, `GET /api/sessions/:id/state-patches`
- Session Plugin Data: `GET/PUT/DELETE /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`
- Session Characters: `GET/POST /api/sessions/:id/characters`
- Session Snapshot: `GET /api/sessions/:id/snapshot` (complete state for restore — messages, characters, characterSchema, gameState, traces)
- Session Submit: `POST /api/sessions/:id/submit-inputs` (legacy alias, forwards to plugin-rpc `submit-form`)
- Session Plugin RPC (PR-3): `POST /api/sessions/:id/plugin-rpc` — unified action/runtime RPC channel, sync mode, framework defaults (`submit-form`) + plugin-declared actions
- Session Runtime Outputs (PR-1): `GET /api/sessions/:id/runtime-outputs`, `GET /api/sessions/:id/runtime-outputs/:id`, `GET /api/sessions/:id/runtime-outputs/:id/full-prompt`, `GET /api/sessions/:id/interaction-records`
- Session Approvals (PR-7): `GET /api/sessions/:id/approvals` — list pending RPC approvals for this session
- Approvals (PR-7): `GET /api/approvals/:approvalId`, `POST /api/approvals/:approvalId/decision` (`{decision: allow|deny, scope?: once|session}`)
- Worlds: `GET/POST /api/worlds`, `GET/PATCH /api/worlds/:id`
- Plugins (global): `GET /api/plugins`, `GET /api/plugins/:id`
- Actions: `POST /api/actions` (SSE action bridge)
- Events: `GET /api/events/stream` (SSE), `POST /api/events/emit`
- AI: `POST /api/ai/ping`, `POST /api/ai/generate-world`
- Model DB: `GET /api/model-db`, `GET /api/model-db/search`, `GET /api/model-db/lookup`, `POST /api/model-db/refresh`
- Traces: `GET /api/traces/:sessionId`, `GET /api/traces/:sessionId/turns`
- Config: `GET /api/presets`, `GET /api/packages`, `GET /api/commands`, `GET /api/block-schemas`, `GET /api/ui-specs`, `GET /api/llm-config`, `GET /api/provider-keys`
- Health: `GET /api/health`

### Frontend

Two frontend apps exist side by side:

**`apps/web/` (V1, legacy)** — React 19 + TanStack Router. Right panel is split into two sections separated by a thin divider: **framework tabs** (世界 = Lorebook, 数据库 = live state-table browser) followed by **plugin tabs** (dynamic from `/api/ui-specs`). The previously hardcoded 角色 and 世界观 tabs were removed because they duplicated core-char-creator and core-world-init plugin contributions; the pretty `WorldDimensionsPanel` rendering moved into core-world-init's 世界维度 tab (新增 `总览` subtab) via the `WorldDimensions` component in `covelRegistry`. Routes: `/` (landing), `/session` (workbench), `/debug`. Port 5173.

**`apps/web-v2/` (V2, active development)** — Plugin-driven UI architecture (see `docs/reference/ui-panels.md`):
- All rendering through [json-render](https://github.com/vercel-labs/json-render) with ~25 component catalog
- Right panel: VSCode-style activity bar, tabs from `/api/ui-specs` — no hardcoded panels
- Message area: Prose (narrative), Form (char creation), Alert (notification), Button (choices) — all json-render
- pluginData drives panel data, `plugin-data.changed` SSE events for real-time updates
- Port 5174, `@` path alias → `apps/web-v2/src/`

**V2 game flow**: World Select → `createSession` → `POST /api/actions` (start_session, SSE stream) → narrative + char form → `POST /api/sessions/:id/submit-inputs` (template fill + char create; kernel advances `turnCount` 0 → 1 once Pre-Game runtimes report done) → `POST /api/actions` (player_action) → next Turn

**Shared infrastructure**:
- Unified SSE protocol: `ProtocolEventType` names (see `docs/reference/protocol.md`)
- Two SSE channels: `/actions` (in-turn) + `/events/stream` (out-of-band)
- Session restore: `GET /api/sessions/:id/snapshot`

**V1 DataService layer** (`apps/web/src/services/data-service.ts`): `LocalDataService` (IndexedDB, T1/T2) or `RemoteDataService` (PostgreSQL, T3). Auto-detected via `GET /api/health` → `storeBackend`.

### Deployment Tiers

Three deployment tiers:

| Tier | Name | Storage | API Keys |
|------|------|---------|----------|
| T1 | Self-Deploy | Browser IDB | User-managed, no auth |
| T2 | Demo Host | Browser IDB | User-managed, HTTPS required |
| T3 | Commercial | PostgreSQL | Platform + User, auth required |

Key env vars: `DEPLOYMENT_TIER`, `CORS_ORIGIN`, `ENABLE_DEBUG_PAGE`, `RATE_LIMIT_RPM`, `STORE_BACKEND`.

## Testing Conventions

All packages use **vitest** as the test runner (`vitest run` for CI, `vitest` for watch mode). No package uses Node's built-in `node:test`. Turborepo orchestrates test runs with caching (`turbo test`). Coverage via `@vitest/coverage-v8` is configured in all packages — run with `--coverage` flag.

### Test Organization

```
packages/<pkg>/tests/       # Unit & integration tests for each package
apps/server/tests/          # Server store & route tests
plugins/<plugin>/tests/     # Plugin-specific tests (if any)
```

### Test Patterns

- **Contract tests** (`store-contract.ts`): Shared test suite defining behavioral expectations for the `DataStore` interface. Each backend (MemoryStore, SqliteStore, IdbStore, PgStore) runs the same contract tests to ensure consistency. New store backends MUST pass the contract suite.
- **Server tests**: `apps/server/tests/api/` — API routes, bootstrap, session management, SSE events.
- **Plugin tests**: Use `@covel/plugin-test-utils` for consistent test setup — `MockLLM`, `createTestHarness`, factory functions (`makeTurnInput`, `makeTriggerContext`, `makeRuntimeResult`).
- **E2E scripts**: `scripts/test-full-3plugins.ts` (real LLM, 3-plugin integration via HTTP API), `scripts/test-real-llm.ts` (single-plugin real LLM test), `scripts/e2e-plugin-verify.ts` (plugin-level API-driven harness, auto-discovers via `/api/plugin-flows`, 7-phase pipeline, artefacts to `debugs/e2e-logs/`; see `docs/guide/e2e-plugin-verify.md`).

### Test Style

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("ComponentName", () => {
  // Group by method or behavior
  describe("methodName", () => {
    it("should describe expected behavior", () => {
      // Arrange → Act → Assert
    });
  });
});
```

- Use `vi.fn()` for mocks, `vi.spyOn()` for spying
- Use `beforeEach` for per-test isolation (fresh store/registry instances)
- IDB tests use `fake-indexeddb` polyfill
- PG tests use a real local database (Docker: `pnpm db:up`)
- JSONB columns: use `sql.json(value as JSONValue)` for writes — never `JSON.stringify()` (causes double-serialization)

## Conventions

- Validation uses Zod schemas throughout
- Database access via Drizzle ORM (PostgreSQL/SQLite); 23 tables: worlds, sessions, turn_results, runtime_results, tool_calls, state_schemas, state_entries, state_changes, events, approvals, messages, characters, plugin_data, plugin_configs, trace_events, turn_messages, player_inputs, working_memory, session_summaries, suspensions, state_snapshots, runtime_outputs, interaction_records
- **PR-6 session columns**: `sessions.runtime_model_overrides` (JSONB map of runtime-id → slot name) — snapshotted into `TurnInput` each turn and consulted by `runtime-slot-resolver` before `manifest.model` / gateway default. Provider + API keys continue through `X-Provider-Keys` header + localStorage (never persisted)
- Locale is a **system capability**: enters execution chain via `KernelInput.locale` → `RuntimeContextView.locale`. Resolution: request → run → world default → app default (`zh-CN`)
- Plugin manifests use `I18nText` (`string | Record<string, string>`) for display fields

### Plugin Authoring Rules

- Depend ONLY on Public Plugin API (manifest/runtime/tool/hook/UI slot/provider binding/proposal contracts)
- Must NOT depend on: DB table names, ORM models, kernel internals, frontend components
- All tool writes through proposals; tools must have schemas; high-risk tools declare permissions
- Hooks guard/rewrite/audit — do NOT carry main gameplay logic
- UI slots: `settings_panel`, `message_block`, `world_panel`, `action_panel`
- Provider access through binding declarations, never direct SDK usage
- Plugin minimum: `PLUGIN.md` + `package.json`
- Declare `outputKind` in frontmatter: `story` (main narrative), `plugin` (default), `system` (hidden)
- Declare `capabilities` in frontmatter for framework discovery (e.g. `[narrative]`, `[world-data-provider]`, `[image-generation]`)

### Framework–Plugin Isolation Rule (CRITICAL)

**框架代码（`packages/`、`apps/server/src/`、`apps/web/src/`）中禁止出现任何具体插件 ID 或插件名称。**

违规示例：
- `pluginId === 'core-narrator'` — 禁止
- `store.listPluginData(sessionId, 'core-world-init', ...)` — 禁止
- `p.id === "core-image"` — 禁止
- `KNOWN_KEYS.has("core-codex")` — 禁止

正确做法：
- 通过 `RuntimeManifest.outputKind` 判断输出类型（如 `story` vs `plugin`）
- 通过 `RuntimeManifest.capabilities` 发现插件能力（如 `world-data-provider`、`image-generation`）
- 通过 `pluginType` 判断是否为核心插件
- 测试文件中可以使用具体插件名作为测试数据，但不能在生产代码中硬编码

此规则确保框架完全独立于任何具体插件实现，任何插件都可以被替换而不修改框架代码。

**Block 提交约定**：插件 block 通过 `_eventType` 字段触发内核事件，而非框架硬编码 block 类型：
```json
{ "_eventType": "image.settings.updated", "settings": { ... } }
```

**角色创建约定**：插件通过 `_createCharacter: true` 标记表单为角色创建，框架据此自动创建 CharacterRecord。

### Identity Model: pluginId vs runtimeId

`RuntimeManifest` 包含两个独立标识符：
- `pluginId` — 插件包 ID（如 `core-world-init`），从 `name` 中的 `/` 前部分派生
- `name` (即 runtimeId) — 运行时全名（如 `core-world-init/schema-gen`）

单运行时插件中两者相同。多运行时插件中 `pluginId` 用于数据隔离、工具作用域、信任检查；`runtimeId` 用于 LLM 调用追踪和日志。所有 store 写入使用 `pluginId`，所有追踪日志使用 `runtimeId`。

### Tool Scoping

工具按插件作用域隔离。`bootstrap.ts` 构建 `pluginToolAccess: Map<string, Set<string>>`，将每个插件声明的 local tools 映射到该插件。`findTool(name, context)` 检查：
- Builtin tools → 所有插件可访问
- Local tools → 仅声明该工具的插件可访问

### Security Conventions

- **SSRF 防护**：`ai-provider/adapters/http.ts` 中 `validateBaseUrl()` 对用户提供的 LLM baseUrl 进行域名白名单校验（已知提供商 + localhost + `COVEL_ALLOWED_LLM_HOSTS` 环境变量），阻止 RFC1918/元数据服务地址
- **Session ID**：格式为 `{worldId}-{uuid8}`，使用 `crypto.randomUUID()` 后缀防止枚举
- **worldId 校验**：`/^[a-z0-9_-]{1,64}$/i` 正则白名单
- **Plugin 信任**：`builtin`/`official` 自动加载，`community` 延迟到显式审批后才 `import()`
- **速率限制**：`middleware/rate-limit.ts` 提供 `rateLimiter()` 和 `singleFlight()` 中间件
- **错误消息**：`middleware/sanitize-error.ts` 在生产环境剥离文件路径和堆栈信息

### Dev-Mode LLM Replay Cache

`packages/ai-provider/src/adapters/replay-cache.ts` + `http.ts` 为开发期提供 LLM 请求录制/回放，方便定位问题时反复重放同一次模型调用。**仅在 `COVEL_LLM_REPLAY` 环境变量被设置时启用**，未设置时整链路零开销、零行为变化。

环境变量：
- `COVEL_LLM_REPLAY=auto` — 命中缓存就回放，未命中调真实 provider 后录制（开发首选）
- `COVEL_LLM_REPLAY=record` — 强制调真实 provider 并覆盖缓存
- `COVEL_LLM_REPLAY=replay` — 只读缓存，未命中抛错（用于调试断点重现）
- `COVEL_LLM_REPLAY_DIR` — 缓存目录，默认 `debugs/llm-cache/`（已 gitignore）

缓存键 = `sha256(method + url + canonicalJson(body))`，相同 ai-provider + 相同参数稳定命中。`authorization`/`api_key` 等敏感字段在哈希和落盘前会被屏蔽为 `<REDACTED>`。流式响应通过 `TransformStream` tee：实时转发给调用方的同时缓存原始 SSE 文本，buffer 上限 10MB，超过则跳过录制。

### Store File Organization

每个 SQL store backend 分为两个文件：
- `*-store-mappers.ts` — DDL 常量 + Row→Record 转换函数
- `*-store.ts` — Factory 函数 + DataStore 方法实现

### Documentation Sync Rules

**Every code change that affects framework capabilities MUST update the corresponding reference docs.** Reference docs live in `docs/reference/`.

| 变更类型 | 需要更新的文档 |
|---------|--------------|
| 添加/修改/删除插件 | `docs/reference/plugins.md` |
| 添加/修改/删除工具（builtin 或 local） | `docs/reference/tools.md` |
| 修改审批策略或工具来源分类 | `docs/reference/tools.md` |
| 添加/修改模型 slot | `docs/reference/slots.md`（创建后） |
| 修改 SSE 事件类型或通讯协议 | `docs/reference/protocol.md` |
| 修改右侧面板 Tab 或数据源 | `docs/reference/ui-panels.md` |
| 修改/添加 API 端点 | `docs/reference/api.md` |
| 修改包结构或依赖关系 | `CLAUDE.md` Workspace Layout + Dependency Flow |
| 添加/修改 PLUGIN.md frontmatter 字段 | `docs/reference/plugins.md`「新增 frontmatter 字段」小节 + `docs/guide/plugin-authoring.md` |
| 添加/修改 RPC action 或 framework default | `docs/reference/api.md` `plugin-rpc` 小节 + `docs/reference/protocol.md` 插件 RPC 表 |
| 添加/修改 approval 流程或信任级别 | `docs/reference/api.md` RPC Approval 流程 + `docs/reference/protocol.md` |

不同步文档的 PR 应被视为未完成。

### Observability

**Trace chain**: `traceId` → `runId` → `branchId` → `turnId` → `runtimeId` → `pluginId`.

**Dual-channel design**:
- **Runtime trace** (DB `trace_events` table): structured turn/runtime hierarchy. Captures LLM calls (delta messages + response), tool calls (input/output), proposals, hooks, provider binding, context fragments. Uses delta recording to avoid storing duplicate prompt history.
- **Infrastructure logging** (pino): server startup, plugin loading, DB operations, SSE connections.

**Trace consumption**: REST API (`/api/traces`), Langfuse export (`TraceExporter` interface), JSON export for player download.

**Frontend debug page** (`/debug`): Session Timeline, Runtime Inspector (LLM call chain + tool calls), Prompt Viewer (full prompt reconstruction with diff), Data Explorer.

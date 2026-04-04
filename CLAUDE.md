# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Covel is an AI RPG plugin-based framework (modular monolith architecture). Core philosophy: **plugins carry gameplay logic, the kernel provides primitives and orchestration**. The system provides a workbench UI for interactive storytelling/gameplay, backed by a plugin-driven kernel that orchestrates LLM calls, context assembly, and turn execution.

Detailed architecture docs: `docs/system-architecture-v0/` (read order: framework-architecture → execution-flow → runtime-kernel-spec → public-plugin-api-spec → agent-runtime-alignment → deployment-security-model). Also see `docs/prompt-externalization-spec.md` and `docs/world-package-spec.md`.

## Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Start both web (5173) and server (3001) in dev mode
pnpm dev:web              # Start only web frontend
pnpm dev:server           # Start only API server
pnpm build                # Build all packages
pnpm lint                 # Lint all packages (tsc --noEmit)
pnpm clean                # Clean all dist directories

# Database (PostgreSQL via Docker)
pnpm db:up                # Start PostgreSQL container
pnpm db:down              # Stop PostgreSQL container
pnpm db:generate          # Generate Drizzle migrations
pnpm db:migrate           # Run Drizzle migrations
pnpm db:studio            # Open Drizzle Studio

# Tests (vitest — all packages)
pnpm --filter @covel/kernel test           # Run kernel tests
pnpm --filter @covel/plugin-runtime test   # Run plugin-runtime tests
pnpm --filter @covel/runtime test          # Run runtime tests
pnpm --filter @covel/ai-provider test      # Run ai-provider tests
pnpm --filter @covel/store test            # Run store tests
pnpm --filter @covel/server test           # Run server tests
# Add --watch for watch mode, --run for single run

# Docker (full-stack production image)
docker compose -f docker/docker-compose.yml build   # Build app image
docker compose -f docker/docker-compose.yml up -d    # Start PostgreSQL + app
docker compose -f docker/docker-compose.yml logs app  # View app logs
```

## Monorepo Structure

- **pnpm workspaces** + **Turborepo** for task orchestration
- Package manager: `pnpm@10.7.0`, Node.js `>=20.19.0`
- ESM-only (`"type": "module"`), TypeScript strict mode, target ES2022
- All packages use direct TypeScript source exports (`"import": "./src/index.ts"` — no build step for dev)
- Use `.js` extensions in TypeScript imports (NodeNext module resolution)

### Workspace Layout

```
apps/
  web/        @covel/web              — React 19 + Vite 8 + TailwindCSS v4 + TanStack Router
  server/     @covel/server           — Hono API server + Drizzle ORM

packages/
  shared/           @covel/shared           — Shared types and contracts (character, kernel, plugin, world, data-access)
  ai-provider/      @covel/ai-provider      — Multi-provider LLM abstraction (preset routing, model capability auto-detection, 2597-model LiteLLM database)
  runtime/          @covel/runtime          — Turn runtime execution engine (LLM tool-calling loop + budget enforcement)
  context/          @covel/context          — Unified context builder (TurnContextStore + PromptAssembler + Compactor + Normalizer + PromptLoader)
  kernel/           @covel/kernel           — Orchestration kernel (scheduling, tool execution, proposals, rendering)
  plugin-runtime/   @covel/plugin-runtime   — Plugin loader, registries (tool/hook/runtime/command), host
  store/            @covel/store            — Data abstraction with 3 backends: MemoryStore, IdbStore (IndexedDB), PgStore (PostgreSQL)
  plugin-test-utils/ @covel/plugin-test-utils — Testing utilities for plugin authors

plugins/                    — 16 core gameplay plugins (see Plugin Inventory below)

prompts/                    — Externalized prompt templates (locale-aware markdown, loaded by @covel/context)
  server/                   — Server route prompts (generate-world, extract-dimensions)

worlds/                     — File-based world packages (YAML manifest + markdown lore)
  cloudmere/                — World package
  mistport/                 — World package
  neonridge/                — World package

modules/                    — Standalone modules (not in pnpm workspace)
  artifact-store/           — Artifact storage system
  sdk-package/              — SDK packaging utilities

extensions/                 — Extension packages (not in pnpm workspace)
  core-presets/             — Preset management
  core-worldbook/           — World book system
```

### Dependency Flow

```
@covel/shared  ←  @covel/ai-provider  ←  @covel/runtime  ←  @covel/context  ←  @covel/kernel
                  @covel/plugin-runtime →                                        →
                  @covel/store →                               @covel/server (composes all)
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

### Kernel Lifecycle

Two-phase initialization: `bootstrapKernel()` creates the kernel instance with global registries, then `createSession()` creates per-session scoped views. `createKernel()` is a compat wrapper combining both steps.

### Kernel Execution Pipeline

Each turn follows a fixed pipeline (`packages/kernel`):

```
Input/Event → Trigger Router → Priority Scheduler → [For each priority group:]
  → TurnContextStore.init() → PromptAssembler.build() → Runtime Runner
  → Tool/Hook Loop → Proposal Collector → TurnContextStore.ingest()
→ Validation/Policy → Commit Service → Render/Side Effects
→ Follow-up Events (may re-enter Router)
```

Key stages:
1. **Trigger Router** — event type identification, `RuntimeTriggerEvent` generation, candidate filtering by trigger rules (modes: `always`, `interval`, `manual`, `event`)
2. **Priority Scheduler** — sort by `priority` (0-1000, default 500). 0 = highest = first. Same priority = parallel group. Priority bands: 0-199 system init, 200-399 preprocessing, 400-599 core narrative, 600-799 post-processing, 800-999 background, 1000 cleanup
3. **Context Assembly** — `TurnContextStore` accumulates turn context across 10 slices (chat, world, characters, state, record, events, runtime, runtimeSettings, narrative, archive); `PromptAssembler` builds per-runtime prompts (instructions + sections + previous outputs); `Compactor` handles long-session history compaction
4. **Runtime Runner** — loads PLUGIN.md, binds provider/tools/hooks/budget, drives LLM tool-calling loop. `maxSteps`/`timeoutMs` = hard limits, `maxTokens` = best-effort
5. **Tool/Hook Loop** — whitelisted tools; hooks at lifecycle points: `TurnStart`, `PreToolUse`, `PostToolUse`, `PreStateCommit`, `PostStateCommit`, `TurnStop`
6. **Proposal Collector** — normalizes to `KernelProposalEnvelope`: `narrative.append`, `state.patch`, `event.emit`, `record.upsert`, `ui.render`, `asset.generate`
7. **Commit Chain** — `proposal → validate → commit`. All writes go through this chain. Plugins never write directly to DB.

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

Default gameplay loop by priority:

| Priority | Plugin | Role |
|----------|--------|------|
| 100 | core-persona | Narrator/AI persona configuration (always) |
| 400 | core-narrator | Main narrative generation (always) |
| 420 | core-combat | Structured turn-based combat (event-triggered) |
| 420 | core-npc-init | NPC initialization (event-triggered) |
| 450 | core-init-wizard | Character creation onboarding (event-triggered) |
| 550 | core-world-state | World state tracking (event-triggered) |
| 600 | core-char-tracker | Character identification/parsing (event-triggered) |
| 600 | core-guide | Story guidance and choice panels (event-triggered) |
| 600 | core-inventory | Item/equipment management (event-triggered) |
| 650 | core-event | Event tracking system (event-triggered) |
| 650 | core-quest | Quest tracking + tools (event-triggered) |
| 700 | core-codex | Knowledge/lore codex (event-triggered) |
| 800 | core-image | Story image generation (event-triggered) |
| 900 | core-memory | Memory summarizer (interval) |
| — | core-dice | Randomness/dice rolls (utility, no runtime) |
| — | core-notification | Event notifications + block renderers (utility, no runtime) |

### Model Slot System

Named slots for provider routing. The first slot defined in `llm.toml` automatically becomes `default`; its original name is also accessible:
- `default` — main narrative, complex reasoning (auto-aliased to first slot)
- `fast` — plugin default, lightweight judgment
- `balance` — referee plugins, complex logic
- `image` — image generation (optional)

Unconfigured slots fall back to `default`. Primary config via `llm.toml` (slot-centric), legacy fallback to `packages/ai-provider/presets/default.toml`. Supports OpenAI, Anthropic, DeepSeek, Qwen (Aliyun DashScope) protocols.

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

All LLM prompts are externalized as locale-aware markdown files (see `docs/prompt-externalization-spec.md`):

- Server prompts: `prompts/server/<name>.md`
- Plugin prompts: `plugins/<plugin>/prompts/<name>.{zh,en}.md`
- Template variables: `{{variable}}` syntax
- Locale resolution: exact match → language fallback → no-locale default → error
- API: `loadPrompt(dir, name, locale)`, `interpolate(template, vars)` from `@covel/context`

### World Package System

File-based world content format (see `docs/world-package-spec.md`):

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
- **Run** — session root, phase: `init` → `character_creation` → `playing` → `ended`
- **Branch** — world-line branch
- **Snapshot** — restorable state point
- **State** — current structured facts (key-value with scope)
- **Event** — append-only business events
- **Record** — searchable long-term knowledge (characters, quests, etc.)
- **Character** — dynamic character cards (evolved through gameplay, not static templates)

Store backends (`@covel/store`): MemoryStore (dev/test), IdbStore (browser IndexedDB), PgStore (production PostgreSQL via Drizzle ORM).

**Store selection** (server startup): `STORE_BACKEND=pg` + `DATABASE_URL` → PgStore, otherwise MemoryStore. World seeds loaded from `COVEL_WORLDS_DIR` (default: `worlds/`).

### Server Route Layout

Two route sets:

**`/api/*` — internal programmatic API:**
- AI: `ai/generate`, `ai/stream`, `ai/ping`, `ai/generate-world`, `ai/extract-dimensions`
- Kernel: `kernel/turn`
- Plugins: `plugins`, `block-schemas`
- Commands: `commands`, `commands/execute`
- Config: `config/presets`, `llm-config`, `provider-keys`
- Model DB: `model-db`, `model-db/search`, `model-db/lookup`, `model-db/refresh`
- Trace: `traces`
- Health: `health`

**Root-level routes (frontend-facing, proxied by Vite in dev):**
- `/worlds`, `/sessions`, `/actions`, `/characters`, `/commands`, `/packages`, `/presets`, `/archives`
- Session plugins: `GET /sessions/:id/plugins`, `POST /sessions/:id/plugins/enable`, `POST /sessions/:id/plugins/disable`

### Frontend

- Three-panel workbench: left rail (navigation), main content, side panel (settings)
- Routes: `/` (landing), `/session` (game workbench, `?sid=<id>` for resume), `/debug` (debugger)
- `@` path alias → `apps/web/src/`
- i18n via i18next: `zh-CN` (default) + `en-US`
- Vite plugins: `@tailwindcss/vite` + `@tanstack/router-plugin/vite` + `@vitejs/plugin-react`
- Game messages support markdown rendering (react-markdown + remark-gfm)
- Session messages/state persist to IndexedDB for refresh survival

### Deployment Tiers

Three deployment tiers (see `docs/system-architecture-v0/deployment-security-model.md`):

| Tier | Name | Storage | API Keys |
|------|------|---------|----------|
| T1 | Self-Deploy | Browser IDB | User-managed, no auth |
| T2 | Demo Host | Browser IDB | User-managed, HTTPS required |
| T3 | Commercial | PostgreSQL | Platform + User, auth required |

Key env vars: `DEPLOYMENT_TIER`, `CORS_ORIGIN`, `ENABLE_DEBUG_PAGE`, `RATE_LIMIT_RPM`, `STORE_BACKEND`.

## Testing Conventions

All packages use **vitest** as the test runner (`vitest run` for CI, `vitest` for watch mode). No package uses Node's built-in `node:test`.

### Test Organization

```
packages/<pkg>/tests/       # Unit & integration tests for each package
apps/server/tests/          # Server store & route tests
plugins/<plugin>/tests/     # Plugin-specific tests (if any)
```

### Test Patterns

- **Contract tests** (`store-contract.ts`): Shared test suite defining behavioral expectations for the `DataStore` interface. Each backend (MemoryStore, IdbStore, PgStore) runs the same contract tests to ensure consistency. New store backends MUST pass the contract suite.
- **ServerStore tests**: `apps/server/tests/memory-store.test.ts` (in-memory, fast), `pg-server-store.test.ts` (requires local PG — `DATABASE_URL=postgresql://covel:covel_dev@localhost:5432/covel`).
- **Tool call tests**: `packages/kernel/tests/builtin-data-tools.test.ts` (all 10 builtin data tools), `tool-call-integration.test.ts` (full lifecycle: registration → sanitization → scoping → execution → hooks → proposals).
- **Plugin API tests**: `packages/plugin-runtime/tests/plugin-registrar-api.test.ts` (PluginRegistrar interface for plugin authors: tool/hook/context/runtime/command registration).

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
- Database access via Drizzle ORM (PostgreSQL); 8 tables: runs, branches, snapshots, state_entries, events, records, characters, trace_events
- Locale is a **system capability**: enters execution chain via `KernelInput.locale` → `RuntimeContextView.locale`. Resolution: request → run → world default → app default (`zh-CN`)
- Plugin manifests use `I18nText` (`string | Record<string, string>`) for display fields

### Plugin Authoring Rules

- Depend ONLY on Public Plugin API (manifest/runtime/tool/hook/UI slot/provider binding/proposal contracts)
- Must NOT depend on: DB table names, ORM models, kernel internals, frontend components
- All tool writes through proposals; tools must have schemas; high-risk tools declare permissions
- Hooks guard/rewrite/audit — do NOT carry main gameplay logic
- UI slots: `settings_panel`, `message_block`, `world_panel`, `action_panel`
- Provider access through binding declarations, never direct SDK usage
- Plugin minimum: `plugin.json` + `PLUGIN.md`

### Observability

**Trace chain**: `traceId` → `runId` → `branchId` → `turnId` → `runtimeId` → `pluginId`.

**Dual-channel design**:
- **Runtime trace** (DB `trace_events` table): structured turn/runtime hierarchy. Captures LLM calls (delta messages + response), tool calls (input/output), proposals, hooks, provider binding, context fragments. Uses delta recording to avoid storing duplicate prompt history.
- **Infrastructure logging** (pino): server startup, plugin loading, DB operations, SSE connections.

**Trace consumption**: REST API (`/api/traces`), Langfuse export (`TraceExporter` interface), JSON export for player download.

**Frontend debug page** (`/debug`): Session Timeline, Runtime Inspector (LLM call chain + tool calls), Prompt Viewer (full prompt reconstruction with diff), Data Explorer.

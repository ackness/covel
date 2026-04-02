# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Covel is an AI RPG plugin-based framework (modular monolith architecture). Core philosophy: **plugins carry gameplay logic, the kernel provides primitives and orchestration**. The system provides a workbench UI for interactive storytelling/gameplay, backed by a plugin-driven kernel that orchestrates LLM calls, context assembly, and turn execution.

Detailed architecture docs: `docs/system-architecture-v0/` (read order: framework-architecture → execution-flow → runtime-kernel-spec → public-plugin-api-spec).

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

# Tests (vitest)
pnpm --filter @covel/kernel test           # Run kernel tests
pnpm --filter @covel/plugin-runtime test   # Run plugin-runtime tests
pnpm --filter @covel/runtime test          # Run runtime tests
pnpm --filter @covel/ai-provider test      # Run ai-provider tests
pnpm --filter @covel/store test            # Run store tests
# Add --watch for watch mode, --run for single run
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
  server/     @covel/server           — Hono API server + Drizzle ORM + pg-boss

packages/
  shared/           @covel/shared           — Shared types and contracts (character, kernel, plugin, world, data-access)
  ai-provider/      @covel/ai-provider      — Multi-provider LLM abstraction (OpenAI/Anthropic/DeepSeek/Qwen, preset-based routing)
  runtime/          @covel/runtime          — Turn runtime execution engine (LLM tool-calling loop + budget enforcement)
  context/          @covel/context          — Unified context builder (TurnContextStore + PromptAssembler + Compactor)
  kernel/           @covel/kernel           — Orchestration kernel (scheduling, tool execution, proposals, rendering)
  plugin-runtime/   @covel/plugin-runtime   — Plugin loader, registries (tool/hook/runtime/command), host
  store/            @covel/store            — Data abstraction with 3 backends: MemoryStore, IdbStore (IndexedDB), PgStore (PostgreSQL)
  trace/            @covel/trace            — Structured runtime trace collection (TurnTrace/RuntimeTrace hierarchy, delta recording, Langfuse export)
  plugin-test-utils/ @covel/plugin-test-utils — Testing utilities for plugin authors

plugins/
  core-persona/       — Narrator/AI persona configuration (priority 100)
  core-narrator/      — Main narrative generation (priority 400)
  core-combat/        — Structured turn-based combat (priority 420)
  core-init-wizard/   — Onboarding wizard (priority 450)
  core-char-tracker/  — Character identification (priority 600)
  core-guide/         — Story guidance and choice panels (priority 600)
  core-inventory/     — Item/equipment management (priority 600)
  core-quest/         — Quest tracking + tools (priority 600)
  core-dice/          — Randomness/dice rolls
  core-memory/        — Memory summarizer
  core-world-state/   — World state tracking
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
2. **Priority Scheduler** — sort by `priority` (0-1000, default 500). 0 = highest = first. Same priority = parallel group
3. **Context Assembly** — `TurnContextStore` accumulates turn context; `PromptAssembler` builds per-runtime prompts (instructions + sections + previous outputs); `Compactor` handles long-session history compaction
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
  schemas/         — Input/output schemas
  server/          — Runtime / tool / hook implementations
  client/          — UI slot extensions
```

**Session-scoped activation**: Global pool loaded at startup; each `KernelSession` has a `SessionPluginScope` (Set of active plugin IDs). Scoped registry views (`ScopedRuntimeRegistry`, `ScopedToolRegistry`, `ScopedHookRegistry`) filter by active set. Enable/disable mid-session; changes apply on next turn. World manifest `requiredPlugins`/`recommendedPlugins` seed initial set.

**Default gameplay loop**: core-persona (100, context) → core-narrator (400, narrative) → core-combat (420, if triggered) → core-init-wizard (450, turn 1) → guide/tracker/inventory/quest (600, parallel) → background (900+).

**Trigger modes**: `always`, `interval` (every N turns), `manual` (button press), `event` (context threshold, goal achievement, session start, explicit events).

### Model Slot System

Named slots for provider routing:
- `heavy` — main narrative, complex reasoning (required)
- `fast` — plugin default, lightweight judgment
- `balance` — referee plugins, complex logic
- `image` — image generation (optional)

Unconfigured slots fall back to `heavy`. Config in `packages/ai-provider/presets/default.toml`. Supports OpenAI, Anthropic, DeepSeek, Qwen (Aliyun DashScope) protocols.

**API key security**: Keys in browser localStorage only, passed per-request via `X-Provider-Keys` header (base64), never persisted server-side.

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
- **State** — current structured facts
- **Event** — append-only business events
- **Record** — searchable long-term knowledge

Store backends (`@covel/store`): MemoryStore (dev/test), IdbStore (browser IndexedDB), PgStore (production PostgreSQL via Drizzle ORM).

### Server Route Layout

Two route sets:
- `/api/*` — internal programmatic API: `ai/generate`, `ai/stream`, `ai/ping`, `kernel/turn`, `plugins`, `block-schemas`, `commands`, `commands/execute`, `config/presets`, `health`
- Root-level routes (frontend-facing, proxied by Vite): `/worlds`, `/sessions`, `/actions`, `/characters`, `/commands`, `/packages`, `/presets`, `/block-schemas`
- Session plugin routes: `GET /sessions/:id/plugins`, `POST /sessions/:id/plugins/enable`, `POST /sessions/:id/plugins/disable`

### Frontend

- Three-panel workbench: left rail (navigation), main content, side panel (settings)
- Routes: `/` (landing), `/session` (game workbench), `/debug` (debugger)
- `@` path alias → `apps/web/src/`
- i18n via i18next: `zh-CN` (default) + `en-US`

## Conventions

- Validation uses Zod schemas throughout
- Database access via Drizzle ORM (PostgreSQL)
- Locale is a **system capability**: enters execution chain via `KernelInput.locale` → `RuntimeContextView.locale`. Resolution: request → run → world default → app default (`zh-CN`)
- Plugin manifests use `I18nText` (`string | Record<string, string>`) for display fields

### Plugin Authoring Rules

- Depend ONLY on Public Plugin API (manifest/runtime/tool/hook/UI slot/provider binding/proposal contracts)
- Must NOT depend on: DB table names, ORM models, kernel internals, frontend components
- All tool writes through proposals; tools must have schemas; high-risk tools declare permissions
- Hooks guard/rewrite/audit — do NOT carry main gameplay logic
- UI slots: `settings_panel`, `message_block`, `world_panel`, `action_panel`
- Provider access through binding declarations, never direct SDK usage

### Observability

**Trace chain**: `traceId` → `runId` → `branchId` → `turnId` → `runtimeId` → `pluginId`.

**Dual-channel design**:
- **Runtime trace** (`@covel/trace` package): structured `TurnTrace` → `RuntimeTrace` hierarchy. Captures LLM calls (delta messages + response), tool calls (input/output), proposals, hooks, provider binding, context fragments. Uses delta recording to avoid storing duplicate prompt history.
- **Infrastructure logging** (pino): server startup, plugin loading, DB operations, SSE connections.

**Trace consumption**: REST API (`/api/trace/*`), SSE push (`trace.*` events), Langfuse export (`TraceExporter` interface), JSON export for player download.

**Frontend debug page** (`/debug`): Session Timeline, Runtime Inspector (LLM call chain + tool calls), Prompt Viewer (full prompt reconstruction with diff), Data Explorer.

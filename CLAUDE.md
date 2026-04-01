# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Covel is an AI RPG plugin-based framework (modular monolith architecture). The core philosophy: **plugins carry gameplay logic, the kernel provides primitives and orchestration**. The system provides a workbench UI for interactive storytelling/gameplay, backed by a plugin-driven kernel that orchestrates LLM calls, context assembly, and turn execution.

Detailed architecture docs live in `docs/system-architecture-v0/` (read order: framework-architecture -> execution-flow -> runtime-kernel-spec -> public-plugin-api-spec).

## Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Start both web (5173) and server (3001) in dev mode
pnpm dev:web              # Start only web frontend
pnpm dev:server           # Start only API server
pnpm build                # Build all packages
pnpm lint                 # Lint all packages (tsc --noEmit)

# Database (PostgreSQL via Docker)
pnpm db:up                # Start PostgreSQL container
pnpm db:down              # Stop PostgreSQL container
pnpm db:generate          # Generate Drizzle migrations
pnpm db:migrate           # Run Drizzle migrations
pnpm db:studio            # Open Drizzle Studio

# Tests (vitest)
pnpm --filter @covel/kernel test        # Run kernel tests
pnpm --filter @covel/plugin-runtime test  # Run plugin-runtime tests
pnpm --filter @covel/runtime test       # Run runtime tests
pnpm --filter @covel/ai-provider test   # Run ai-provider tests
# Add --watch for watch mode in any package
```

## Monorepo Structure

- **pnpm workspaces** with **Turborepo** for task orchestration
- Package manager: `pnpm@10.7.0`, Node.js `>=20.19.0`
- ESM-only (`"type": "module"`), TypeScript strict mode, target ES2022

### Workspace Layout

```
apps/
  web/        @covel/web       — React 19 + Vite 8 + TailwindCSS v4 + TanStack Router
  server/     @covel/server    — Hono API server + Drizzle ORM + pg-boss

packages/
  shared/         @covel/shared          — Shared types and contracts
  ai-provider/    @covel/ai-provider     — Multi-provider LLM abstraction (preset-based routing)
  runtime/        @covel/runtime         — Turn runtime execution engine
  kernel/         @covel/kernel          — Orchestration kernel (scheduling, context assembly, tool execution, proposals, rendering)
  plugin-runtime/ @covel/plugin-runtime  — Plugin loader, registries (tool/hook/runtime/command), host

plugins/
  core-guide/         — Story guidance and next-step choice panels
  core-persona/       — Narrator/AI persona configuration
  core-char-tracker/  — Character tracking
  core-init-wizard/   — Onboarding wizard
```

### Dependency Flow

```
@covel/shared  <-  @covel/ai-provider  <-  @covel/runtime  <-  @covel/kernel
                   @covel/plugin-runtime ->                     ->
                                               @covel/server (composes all)
```

## Architecture

### Core Execution Primitives

The system's first-class execution primitives are **Runtime, Tool, Hook, Context, Proposal** — not plugins. A Plugin Package is only a distribution/packaging unit that declares and bundles these primitives.

### Kernel Execution Pipeline

The kernel (`packages/kernel`) orchestrates each turn through a fixed pipeline:

```
Input/Event -> Trigger Router -> Runtime Scheduler -> Context Assembly
-> Runtime Runner -> Tool/Hook Loop -> Proposal Collector
-> Validation/Policy -> Commit Service -> Render/Side Effects
-> Follow-up Events (may re-enter Router)
```

1. **Trigger Router** — identifies event type, generates `RuntimeTriggerEvent`, filters candidate runtimes by trigger rules (modes: `always`, `interval`, `manual`, `event`)
2. **Runtime Scheduler** — orders runtimes by: phase -> dependency topology layer -> `plugin.loadingOrder` -> explicit priority -> stable id sort. Phases: `pre_story` -> `story` -> `post_story` -> `background`. Same-layer runtimes run in parallel.
3. **Context Assembly** — builds minimal read-only context per runtime's `readScopes`. 10 slices: `chat`, `world`, `characters`, `state`, `record`, `events`, `runtime`, `runtimeSettings`, `narrative`, `archive`. Resolves locale explicitly (not by guessing).
4. **Runtime Runner** — loads instructions (PLUGIN.md), binds provider/tools/hooks/budget, drives LLM tool-calling loop. Budget: `maxSteps`/`timeoutMs` are hard limits, `maxTokens` is best-effort.
5. **Tool/Hook Loop** — executes whitelisted tools, hooks can guard/rewrite/audit/block at lifecycle points (`TurnStart`, `PreToolUse`, `PostToolUse`, `PreStateCommit`, `PostStateCommit`, `TurnStop`)
6. **Proposal Collector** — normalizes outputs into `KernelProposalEnvelope` with typed items: `narrative.append`, `state.patch`, `event.emit`, `record.upsert`, `ui.render`, `asset.generate`
7. **Validation/Policy** — schema + permission + policy checks, parallel conflict detection (scope isolation preferred, same-key conflicts rejected by default)
8. **Commit** — writes State, appends Event, updates Record, generates Snapshot
9. **Render** — maps commit results to message blocks, panel updates, side effects

### The Commit Chain Invariant

**All writes go through `proposal -> validate -> commit`.** Plugins never write directly to the database or bypass this chain. This is the foundation for auditing, replay, diffing, and migration.

### Plugin System

Plugins declare capabilities in `plugin.json` manifests (schema version 1.0). Recommended plugin structure:

```
plugin/
  plugin.json      — Manifest: capabilities, metadata, i18n
  PLUGIN.md        — Runtime instructions (= agent skill prompt for the LLM)
  schemas/         — Input/output schemas
  server/          — Runtime / tool / hook implementations
  client/          — UI slot extensions
  scripts/         — Deterministic scripts (dice roll, formulas — avoid LLM for math)
  references/      — Rule materials (RAG sources, lore supplements)
```

The `PluginHost` (`plugin-runtime`) scans the `plugins/` directory, validates manifests, loads modules, and populates registries. The `CommandBus` dispatches slash commands to registered handlers.

**Runtime** is a complete, independently-callable LLM execution unit (not just code attached to a chat turn). Each runtime has its own provider binding, context contract, tool whitelist, hook set, and budget.

**Default gameplay loop**: story runtime runs first (narrative only), then `post_story` plugin runtimes read the narrative + state and produce proposals, then `validate -> commit -> render`. Background runtimes (memory, archive) run after without blocking.

**Plugin trigger timing**: "after main narrative" is the default profile, NOT the only option. Plugins can trigger on: session start, every N turns, context threshold, goal achievement, manual button press, explicit events.

### Model Slot System

Named model slots for provider routing (not simple primary/auxiliary split):
- `heavy` — main narrative, complex reasoning (required, minimum 1 LLM)
- `fast` — plugin default, lightweight judgment
- `balance` — referee plugins, complex logic agents
- `image` — image generation (optional)

Unconfigured slots fall back to `heavy`. Runtime references slots via `providerBinding` field.

**Preset system**: Presets are pre-filled templates (provider, baseUrl, model, protocol). Only API key requires user input. Users can create custom presets (saved in browser localStorage, exportable as JSON without API key). Advanced model parameters (temperature, topP, etc.) use provider defaults unless explicitly overridden via settings panel.

**API key security**: Keys stored only in browser localStorage, passed per-request via `X-Provider-Keys` header (base64), never persisted server-side.

### Schema-Driven Block Rendering

Three-tier resolution for plugin UI blocks:
1. **Custom Renderer** — hand-written React component (highest quality, for core interactions)
2. **Schema Renderer** — auto-generated from plugin's `blockSchemas` in `plugin.json` (JSON Schema → dynamic form/display)
3. **Raw Fallback** — JSON display (development/debug)

Plugins declare `blockSchemas` with `dataSchema` (JSON Schema) and optional `submitSchema`. LLM generates structured content conforming to schema; proposal validator checks compliance; renderer resolves by tier.

### Character Card System

Dynamic, plugin-driven character cards (inspired by SillyTavern V2/V3 but mutable during play):
- Base fields: `id`, `worldId`, `runId`, `name`, `type` (player/npc/companion), `description`, `version`
- Dynamic fields: `fields: Record<string, unknown>` constrained by world `characterSchema`
- Extension fields: `extensions: Record<string, unknown>` namespaced by pluginId
- Character creation is context-aware: init-wizard LLM reads opening narrative to generate contextual creation form
- Relationships tracked via `Record` objects (`record.upsert`), future Graph RAG integration planned
- Characters exportable as JSON, importable with world schema validation

### Content Assets

Three content asset types with stable local-first formats (not tied to any platform):
- **World Package** — Markdown + YAML frontmatter, declares character schema, required/recommended plugins
- **Character Pack** — Dynamic character cards with initial definition, growth, and retrospection
- **Plugin Package** — As described above

### State & Persistence Model

Core runtime objects (never collapse into a single JSON blob):
- **Run** — Long-lived gameplay session root, has explicit phase: `init` → `character_creation` → `playing` → `ended`
- **Branch** — World-line branch
- **Snapshot** — Restorable state point
- **State** — Current structured facts
- **Event** — Append-only business events
- **Record** — Searchable long-term knowledge

Supports `fork restore` (branch from snapshot, default) and `hard restore` (overwrite current branch).

**Session export/import**: Full session exportable as JSON (run + branches + snapshots + state + events + records + messages + plugin set). No API keys included. Import creates new Run, checks world/plugin compatibility. Supports branch-level export and read-only replay sharing.

### Opening Flow

Turn 1 sequence when player clicks "Start Game":
1. `pre_story`: core-persona (no-op, injects persona via context provider)
2. `story`: core-narrator (LLM generates opening narrative)
3. `post_story`: core-init-wizard (LLM reads narrative + world schema, generates contextual character creation form)
4. SSE streams: narrative text → character creation block → flow complete
5. Phase transitions: `init` → `character_creation` → (after char submit) → `playing`

### Server Route Layout

The server exposes two route sets:
- `/api/*` — internal programmatic API (AI generate/stream, kernel turn, plugin listing, command execution)
- Root-level routes (`/worlds`, `/sessions`, `/actions`, `/commands`, `/packages`, `/presets`) — frontend-facing, proxied by Vite dev server

### Frontend

- Three-panel workbench layout (left rail for navigation, main content area, side panel for settings)
- `@` path alias resolves to `apps/web/src/`
- i18n via i18next with `zh-CN` (default) and `en-US` locales

## Conventions

- All packages use direct TypeScript source exports (no build step needed for dev — `"import": "./src/index.ts"`)
- Use `.js` extensions in TypeScript imports (NodeNext module resolution)
- Validation uses Zod schemas throughout
- Database access via Drizzle ORM (PostgreSQL); in-memory store available for dev/testing

### i18n Rules

Locale is an **explicit system capability**, not just UI chrome:
- Default language: `zh-CN`. Minimum supported set: `zh-CN` + `en-US`
- Locale enters the execution chain explicitly via `KernelInput.locale` -> `RuntimeContextView.locale`
- Resolution order: request locale -> run locale -> world default locale -> app default (`zh-CN`)
- Resource fallback: frontend language -> settings default -> asset's own default language
- Plugin manifests use `I18nText` (`string | Record<string, string>`) for `displayName`/`description`
- Frontend UI, core plugin metadata, and kernel-visible user text must provide both `zh-CN` and `en-US`
- PLUGIN.md and world content may maintain only default locale in v1, but must declare locale coverage

### Plugin Authoring Rules

- Plugins depend ONLY on Public Plugin API (manifest/runtime/tool/hook/UI slot/provider binding/proposal contracts)
- Plugins must NOT depend on: database table names, ORM models, kernel internal scheduling, frontend component tree, internal helpers
- All tool writes go through proposals, never direct DB access
- Tools must have schemas; high-risk tools must declare permissions
- Hooks guard/rewrite/audit — they do NOT carry main gameplay logic
- UI extensions inject only through standard slots: `settings_panel`, `message_block`, `world_panel`, `action_panel`
- Provider access is through binding declarations, never direct SDK usage

### Observability

Full chain tracing with: `traceId` -> `runId` -> `branchId` -> `turnId` -> `runtimeId` -> `pluginId`. Track runtime scheduling, tool calls, hook decisions, provider requests, DB commits, locale resolution.

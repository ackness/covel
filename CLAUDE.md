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
  web/              @covel/web              — React 19 + Vite 8 + TailwindCSS v4 + TanStack Router
  server/           @covel/server           — Hono API server + Drizzle ORM

packages/
  shared/           @covel/shared           — Shared types and contracts (pure types, zero runtime deps)
  context/          @covel/context          — Context assembly (template interpolation, inject blocks, prompt building)
  ai-provider/      @covel/ai-provider      — Multi-provider LLM abstraction (preset routing, model capability auto-detection, 2597-model LiteLLM database)
  plugin-loader/    @covel/plugin-loader    — Plugin discovery, PLUGIN.md parsing, progressive loading, registry, session scope
  runtime/          @covel/runtime          — Turn execution engine (trigger → schedule → context → LLM → tool loop → result)
  store/            @covel/store            — Data abstraction with 4 backends: MemoryStore, SqliteStore, IdbStore (IndexedDB), PgStore (PostgreSQL)
  state/            @covel/state            — State management (dynamic tables, change history, write conflict collection)
  events/           @covel/events           — Event bus (pub/sub, event persistence)
  tools/            @covel/tools            — Tool system (tool() wrapper, registry, builtin UI tools, short ID generator, output validation)
  approval/         @covel/approval         — Approval pipeline (permission rules, approval gates)
  plugin-test-utils/ @covel/plugin-test-utils — Testing utilities for plugin authors (MockLLM, TestHarness, factories)

plugins/                    — Core gameplay plugins (PLUGIN.md-centric, see Plugin Inventory below)
  core-pregame/             — Game initialization (priority 0, first turn only)
  core-world-init/          — World dimension initialization (guard + agent runtime)
  core-narrator/            — Main narrative generation
  core-char-creator/        — Character creation onboarding
  core-codex/               — Knowledge codex with local tools

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
2. **Priority Scheduler** — sort by `priority` (0-1000, default 500). 0 = highest = first. Same priority = parallel group. Priority bands: 0-99 Pre-Game (first turn only), 100-499 Pre-Turn, 500 Narrator, 501-999 After-Turn, 1000 Audit. Normal game loop runs 100-1000; Pre-Game (0-99) runs only on session first turn.
3. **Context Assembly** — `TurnContextStore` accumulates turn context across 10 slices (chat, world, characters, state, record, events, runtime, runtimeSettings, narrative, archive); `PromptAssembler` builds per-runtime prompts (instructions + sections + previous outputs); `Compactor` handles long-session history compaction
4. **Runtime Runner** — two modes: `runtimeType: 'agent'` (default) loads PLUGIN.md, binds provider/tools/hooks/budget, drives LLM tool-calling loop; `runtimeType: 'function'` directly calls a JS handler function without LLM. `maxSteps`/`timeoutMs` = hard limits, `maxTokens` = best-effort
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

Current plugins (PLUGIN.md-centric format):

| Priority | Plugin | Role | Trigger |
|----------|--------|------|---------|
| 10 | core-pregame | Game initialization (function runtime, no LLM) | scheduled (first turn only, maxTriggerCount=1) |
| 85 | core-world-init/schema-gen | World dimension schema + entries via LLM (guard skips if data exists) | scheduled (first turn only) |
| 500 | core-narrator | Main narrative generation | auto (every turn) |
| 650 | core-codex | Knowledge/lore codex with local tools | auto |
| 700 | core-char-creator | Character creation onboarding | scheduled (first turn only, maxTriggerCount=1) |

Additional plugins planned: core-persona, core-combat, core-guide, core-inventory, core-quest, core-image, core-memory, etc.

### Plugin Data Storage

Plugins have session-scoped persistent KV storage via the `plugin_data` table. Data is isolated by `(sessionId, pluginId, namespace, key)`.

**Builtin tools** (available to all agent runtimes):
- `plugin-data-set` — write plugin data
- `plugin-data-get` — read own plugin's data (cross-plugin read removed for security)
- `plugin-data-list` — list own plugin's entries in a namespace

**REST API**: `GET/PUT/DELETE /api/session/:id/plugin-data/:pluginId/:namespace/:key`

**Context injection**: Plugin data from `core-world-init` is pre-loaded at turn start and injected via `getConfig` → `{{ config.worldSchema }}`, `{{ config.worldEntries }}`, `{{ config.worldDimensions }}`.

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
- **Run** — session root, phase: `init` → `character_creation` → `playing` → `ended`
- **Branch** — world-line branch
- **Snapshot** — restorable state point
- **State** — current structured facts (key-value with scope)
- **Event** — append-only business events
- **Record** — searchable long-term knowledge (characters, quests, etc.)
- **Character** — dynamic character cards (evolved through gameplay, not static templates)
- **PluginData** — plugin-scoped persistent KV storage, isolated by `(sessionId, pluginId, namespace, key)`

Store backends (`@covel/store`): MemoryStore (dev/test), IdbStore (browser IndexedDB), PgStore (production PostgreSQL via Drizzle ORM).

**Store selection** (server startup): `STORE_BACKEND=pg` + `DATABASE_URL` → PgStore, otherwise MemoryStore. World seeds loaded from `COVEL_WORLDS_DIR` (default: `worlds/`).

### Server Route Layout

All endpoints under `/api/` prefix (Vite dev server proxies `/api` → backend). RESTful convention: resources use plural nouns.

- Sessions (CRUD): `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/:id`
- Session Turn: `POST /api/sessions/:id/turn`, `GET /api/sessions/:id/turns`, `GET /api/sessions/:id/results`
- Session Messages: `GET /api/sessions/:id/messages`, `POST /api/sessions/:id/messages/sync`
- Session Plugins: `GET /api/sessions/:id/plugins`, `POST /api/sessions/:id/plugins/enable`, `POST /api/sessions/:id/plugins/disable`
- Session State: `GET /api/sessions/:id/state`, `GET /api/sessions/:id/state/:table`, `GET /api/sessions/:id/state/:table/:field/history`
- Session State Persistence: `GET/PUT /api/sessions/:id/state-snapshot`, `GET /api/sessions/:id/state-patches`
- Session Plugin Data: `GET/PUT/DELETE /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`
- Session Characters: `GET/POST /api/sessions/:id/characters`
- Session Submit: `POST /api/sessions/:id/submit-inputs`
- Worlds: `GET/POST /api/worlds`, `GET/PATCH /api/worlds/:id`
- Plugins (global): `GET /api/plugins`, `GET /api/plugins/:id`
- Actions: `POST /api/actions` (SSE action bridge)
- Events: `GET /api/events/stream` (SSE), `POST /api/events/emit`
- AI: `POST /api/ai/ping`, `POST /api/ai/generate-world`
- Model DB: `GET /api/model-db`, `GET /api/model-db/search`, `GET /api/model-db/lookup`, `POST /api/model-db/refresh`
- Config: `GET /api/presets`, `GET /api/packages`, `GET /api/commands`, `GET /api/block-schemas`, `GET /api/llm-config`, `GET /api/provider-keys`
- Health: `GET /api/health`

### Frontend

- Three-panel workbench: left rail (navigation/config), main content (chat), right panel (7 tabs: Game/Character/Events/Codex/State/World/Records — see `docs/reference/ui-panels.md`)
- Routes: `/` (landing), `/session` (game workbench, `?sid=<id>` for resume), `/debug` (debugger)
- `@` path alias → `apps/web/src/`
- i18n via i18next: `zh-CN` (default) + `en-US`
- Vite plugins: `@tailwindcss/vite` + `@tanstack/router-plugin/vite` + `@vitejs/plugin-react`
- Game messages support markdown rendering (react-markdown + remark-gfm)
- Session messages/state persist to IndexedDB for refresh survival

**Frontend DataService layer** (`apps/web/src/services/data-service.ts`):

Two implementations selected at runtime:
- `LocalDataService` — all game data (worlds, sessions, messages) stored in browser IndexedDB; used for T1/T2 self-deploy. Before each action, `syncToServer()` pushes local state to server's MemoryStore so the stateless server can process the turn.
- `RemoteDataService` — delegates all CRUD to the server API; used when `STORE_BACKEND=pg`.

Storage mode is auto-detected on startup: `main.tsx` calls `GET /api/health`, reads `storeBackend` from the response, and sets `storageMode = "remote"` when it equals `"pg"`. LLM execution, plugin, and config APIs always go through the server regardless of storage mode.

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
- **E2E scripts**: `scripts/test-full-3plugins.ts` (real LLM, 3-plugin integration via HTTP API), `scripts/test-real-llm.ts` (single-plugin real LLM test).

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
- Database access via Drizzle ORM (PostgreSQL/SQLite); 17 tables: worlds, sessions, turn_results, runtime_results, tool_calls, state_schemas, state_entries, state_changes, events, approvals, messages, characters, plugin_data, plugin_configs, trace_events, turn_messages, player_inputs
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
| 修改包结构或依赖关系 | `CLAUDE.md` Workspace Layout + Dependency Flow |

不同步文档的 PR 应被视为未完成。

### Observability

**Trace chain**: `traceId` → `runId` → `branchId` → `turnId` → `runtimeId` → `pluginId`.

**Dual-channel design**:
- **Runtime trace** (DB `trace_events` table): structured turn/runtime hierarchy. Captures LLM calls (delta messages + response), tool calls (input/output), proposals, hooks, provider binding, context fragments. Uses delta recording to avoid storing duplicate prompt history.
- **Infrastructure logging** (pino): server startup, plugin loading, DB operations, SSE connections.

**Trace consumption**: REST API (`/api/traces`), Langfuse export (`TraceExporter` interface), JSON export for player download.

**Frontend debug page** (`/debug`): Session Timeline, Runtime Inspector (LLM call chain + tool calls), Prompt Viewer (full prompt reconstruction with diff), Data Explorer.

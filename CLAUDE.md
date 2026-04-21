# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Covel is an AI RPG plugin-based framework (modular monolith). Core philosophy: **plugins carry gameplay logic, the kernel provides primitives and orchestration**. Each plugin is a self-contained Agent Runtime that declares its own trigger rules, context injection, tool whitelist, and write proxies; the kernel routes turns, assembles context, drives LLM tool-calls, and commits proposals.

Deployable as Web, Electron, or Tauri (the two desktop shells share the same Node sidecar).

## Documentation Index

Before changing anything non-trivial, consult the matching reference doc — they are the source of truth, CLAUDE.md only points at them.

| Topic | Authoritative doc |
|-------|-------------------|
| Project intro, quick start, roadmap | [README.md](./README.md) · [docs/README.md](./docs/README.md) |
| End-to-end turn pipeline, full architecture | [docs/architecture/flow.md](./docs/architecture/flow.md) |
| Plugin registry (all plugins, priorities, triggers) | [docs/reference/plugins.md](./docs/reference/plugins.md) |
| Tool registry (builtin + local, approval policy) | [docs/reference/tools.md](./docs/reference/tools.md) |
| HTTP API (all endpoints, request/response, curl) | [docs/reference/api.md](./docs/reference/api.md) |
| Protocol (SSE events, envelope, Transport layer) | [docs/reference/protocol.md](./docs/reference/protocol.md) |
| Right-panel tabs, json-render declarative UI | [docs/reference/ui-panels.md](./docs/reference/ui-panels.md) |
| Prompt assembly (10-slice, cache_control, V1→V2) | [docs/reference/prompt-structure.md](./docs/reference/prompt-structure.md) |
| DataStore transactions (begin/commit/rollback) | [docs/reference/transactions.md](./docs/reference/transactions.md) |
| Writing a plugin (tutorial + frontmatter fields) | [docs/guide/plugin-authoring.md](./docs/guide/plugin-authoring.md) |
| Plugin UI + runtime guidelines | [docs/guide/plugin-ui-runtime-guidelines.md](./docs/guide/plugin-ui-runtime-guidelines.md) |
| Plugin testing (harness + examples) | [docs/guide/plugin-testing.md](./docs/guide/plugin-testing.md) |
| UI component catalogue (json-render primitives) | [docs/reference/ui-components.md](./docs/reference/ui-components.md) |
| Terminology glossary (session / runtime / slot / …) | [docs/glossary.md](./docs/glossary.md) |
| E2E plugin verify harness | [docs/guide/e2e-plugin-verify.md](./docs/guide/e2e-plugin-verify.md) |
| Desktop config (paths, sidecar, safeStorage) | [docs/guide/desktop-config.md](./docs/guide/desktop-config.md) |
| Desktop packaging (Electron), signing, notarisation | [apps/desktop/PACKAGING.md](./apps/desktop/PACKAGING.md) |
| Desktop packaging (Tauri), signing, notarisation | [apps/desktop-tauri/PACKAGING.md](./apps/desktop-tauri/PACKAGING.md) |
| Prompt externalisation spec | [devs/docs/prompt-externalization-spec.md](./devs/docs/prompt-externalization-spec.md) |
| World package spec (world.yaml + WORLD.md) | [devs/docs/world-package-spec.md](./devs/docs/world-package-spec.md) |
| Plugin system requirements, refactor plans | [devs/docs/plugin-system-req.md](./devs/docs/plugin-system-req.md) · [devs/docs/refactor-plan/](./devs/docs/refactor-plan/) |
| Contributing & release workflow | [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) |

## Commands

```bash
# Install & dev
pnpm install
pnpm dev              # web (5173) + server (3001), MemoryStore
pnpm dev:web          # web only
pnpm dev:server       # server only (MemoryStore)
pnpm dev:pg           # server only, STORE_BACKEND=pg (needs pnpm db:up first)

# Build & check
pnpm build            # build all
pnpm lint             # tsc --noEmit across workspace
pnpm test             # vitest via turbo (cached)
pnpm test:coverage    # + @vitest/coverage-v8
pnpm clean

# Single package tests — add --watch for watch, --run for single run
pnpm --filter @covel/runtime test
pnpm --filter @covel/<pkg> test

# Database (Docker)
pnpm db:up / db:down / db:generate / db:migrate / db:studio

# E2E
pnpm e2e              # Playwright headless
pnpm e2e:ui
pnpm e2e:docker       # full Docker stack + E2E + teardown

# Real-LLM E2E scripts (need .env.llm)
npx tsx --env-file=.env --env-file=.env.llm scripts/test-full-3plugins.ts
npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts --slot e2e_local --turns 3

# Docker (full stack)
pnpm docker:build / docker:up / docker:down / docker:logs

# Desktop
pnpm dev:electron / dev:tauri            # dev shells (real sidecar)
pnpm build:electron / build:tauri        # platform installers → release/
pnpm build:desktop                       # both shells
```

## Config Files

Dev-time files (copied from `*.example`):

- `.env` — infrastructure (`STORE_BACKEND`, `DATABASE_URL`, `SERVER_PORT`, `COVEL_WORLDS_DIR`, etc.)
- `llm.toml` — slot routing (`[covel.<slot>]` sections). If missing, server falls back to built-in DeepSeek `story` slot and boots anyway.
- `.env.llm` — provider API keys. Dev server (`tsx watch`) loads `.env` + `.env.llm` from repo root.

Desktop-shell files under `<covelHome>/` (typically `~/.covel/`):

- `config.toml` — desktop shell config (paths, log rotation)
- `llm.toml` — hand-editable slot / provider definitions (same schema as dev-time)
- `keys.env` — provider API keys, mode 600
- `settings.json` — front-end user preferences (locale, appearance, slot overrides, custom presets, parameter overrides, per-plugin settings). Managed via the unified **SettingsStore** in `packages/shared/src/settings/` — see [devs/docs/unified-settings-spec.md](./devs/docs/unified-settings-spec.md). Auto-saved on every change; mirrored to `localStorage` (`covel:settings`) on pure-web tiers.

Provider API keys flow through the `SettingsStore` too: writes end up in `keys.env` on desktop, `localStorage` (`covel:keys`) on web. They are never persisted server-side by the REST API — each AI request passes them via the `X-Provider-Keys` header (base64).

## Monorepo Structure

- pnpm workspaces + Turborepo. `pnpm@10.7.0`, Node ≥ 22.
- ESM-only (`"type": "module"`), TypeScript strict, ES2022, NodeNext module resolution — **use `.js` extensions in TS imports**.
- Packages export TS source directly (`"import": "./src/index.ts"`) — no build step for dev.

```
apps/
  web/              Web UI (React 19 + Vite + TanStack Router, json-render + plugin-driven panels)
  server/           Hono API + Drizzle ORM
  desktop/          Electron shell (sidecar)
  desktop-tauri/    Tauri shell (same sidecar contract)

packages/           13 internal packages: shared, context, ai-provider,
                    plugin-loader, runtime, store, state, events, tools,
                    approval, memory, create, plugin-test-utils

plugins/            8 core plugins (see docs/reference/plugins.md)
prompts/            Externalised prompt templates (locale-aware markdown)
worlds/             File-based world packages (cloudmere / mistport / neonridge)
```

Dependency flow (rough):

```
shared ← context ← runtime ← server (composes all)
shared ← web
```

All feature packages (`ai-provider`, `plugin-loader`, `store`, `state`, `events`, `tools`, `approval`, `memory`, `create`) are composed by `@covel/server`. See any package's own `package.json` for exact edges.

## Architecture Essentials

First-class execution primitives are **Runtime, Tool, Hook, Context, Proposal** — a plugin package is just the distribution unit. Full architecture, diagrams, and turn-pipeline walkthrough live in [docs/architecture/flow.md](./docs/architecture/flow.md).

### Turn pipeline (packages/runtime)

```
Input/Event → Trigger Router → Priority Scheduler → [per priority group:]
  → TurnContextStore.init → PromptAssembler.build → Runtime Runner
  → Tool/Hook Loop → Proposal Collector → TurnContextStore.ingest
→ Validation/Policy → Commit Service → Render/Side Effects
→ Follow-up Events (may re-enter Router)
```

- **Trigger modes**: `always`, `interval`, `manual`, `event`.
- **Runtime types**: `agent` (default, loads PLUGIN.md and drives LLM tool-calls) or `function` (pure JS handler, no LLM).
- **Proposal envelopes**: `narrative.append`, `state.patch`, `event.emit`, `record.upsert`, `ui.render`, `asset.generate`. **All writes flow through validate → commit — plugins never touch the DB directly.**
- **Hook lifecycle**: `TurnStart`, `PreToolUse`, `PostToolUse`, `PreStateCommit`, `PostStateCommit`, `TurnStop`.

### Priority bands (kernel-enforced)

| Turn  | Scheduled priority | Phase |
|-------|-------------------|-------|
| 0     | 0–99              | Pre-Game (Pre-Game runtimes report `preGameDone: true`) |
| ≥ 1   | 100–1000          | Pre-Turn 100–499 · Narrator 500 · After-Turn 501–999 · Audit 1000 |

Session lifecycle tracked by three fields on `SessionRecord`:
- `status: 'active' | 'paused' | 'ended'` — `paused`/`ended` halts scheduling.
- `turnCount: number` — band selector. Kernel auto-advances 0 → 1 once all Pre-Game runtimes report done.
- `preGameCompleted: string[]` — runtimeIds that reported done.

### Plugin system

- **Layout**: `PLUGIN.md` (frontmatter + agent skill prompt) + `package.json` is the minimum. Optional: `prompts/`, `schemas/`, `server/`, `client/`, `ui/`.
- **Session scope**: Global plugin pool loaded at startup; each `KernelSession` has a `SessionPluginScope` (active set). Scoped registry views filter runtimes / tools / hooks. World manifest seeds initial set; enable/disable mid-session applies next turn.
- **Trust tiers**: `builtin` (auto-load) · `official` (whitelist) · `community` (deferred `import()` until user approves).
- **Plugin data**: session-scoped KV storage keyed by `(sessionId, pluginId, namespace, key)` in `plugin_data` table. Builtin tools: `plugin-data-{set,get,list,set-batch}`, `create-character` / `update-character` / `list-characters` / `get-character`.
- **Plugin-data inject** (agent runtimes): `input.inject` with `kind: plugin-data` reads the runtime's own namespace and inlines a summary into the system prompt (avoids tool-call round-trips). Switches that runtime to the async context path.

Detailed field reference, per-plugin table, and trigger semantics: [docs/reference/plugins.md](./docs/reference/plugins.md) · [docs/guide/plugin-authoring.md](./docs/guide/plugin-authoring.md).

### Plugin UI (declarative, json-render)

All panels/blocks render through [json-render](https://github.com/vercel-labs/json-render) with a framework-defined ~25-component catalog. Plugins declare `ui: { right, message, left }` in PLUGIN.md, pointing at JSON specs under `ui/`. `GET /api/ui-specs` aggregates them; frontend discovers panels at boot. `plugin-data.changed` SSE events drive re-renders. Three-tier resolution: custom React (`.tsx`) → json-render spec (`.json`) → raw JSON fallback. Details in [docs/reference/ui-panels.md](./docs/reference/ui-panels.md).

### Model slot system

- Named slots: `default` (main narrative — auto-aliased to the first slot defined), `fast`, `balance`, `image`.
- Configured via `llm.toml` `[covel.<slot>]` sections. If missing, single `story` → DeepSeek fallback boots the app.
- **Tag-aware fallback**: an unconfigured slot falls back to the first slot with the same tag (`text`/`image`/`embedding`/`speech`/`transcription`). Cross-tag fallback is forbidden (an image request never silently routes to text).
- Supports OpenAI, Anthropic, DeepSeek, Qwen (Aliyun DashScope).
- **Model capabilities** (multimodal, features, token limits, pricing) auto-detected via: frontend localStorage override → `llm.toml` manual → `known-models.ts` (~60 common) → LiteLLM DB (2597 models, `pnpm --filter @covel/ai-provider update-model-db`) → protocol defaults. Directional modality: `input: InputModality[]` = accepts, `output: OutputModality[]` = produces.

## Critical Conventions (Read These)

### Framework ↔ Plugin Isolation Rule (CRITICAL)

**框架代码（`packages/`、`apps/server/src/`、`apps/web*/src/`）禁止硬编码任何具体插件 ID 或名称。**

Violations:
- `pluginId === 'core-narrator'` · `store.listPluginData(sessionId, 'core-world-init', ...)` · `p.id === 'core-image'`.

Correct approach:
- Dispatch on `RuntimeManifest.outputKind` (`story` / `plugin` / `system`).
- Discover via `RuntimeManifest.capabilities` (e.g. `narrative`, `world-data-provider`, `image-generation`).
- Use `pluginType` to gate on core vs third-party.
- Test files may use real plugin IDs as fixtures; production code must not.

**Block submission convention**: plugin blocks trigger kernel events via a `_eventType` field — the framework does not hardcode block types.
```json
{ "_eventType": "image.settings.updated", "settings": { ... } }
```

**Character creation convention**: forms marked with `_createCharacter: true` cause the framework to auto-create a `CharacterRecord`.

### Identity model: pluginId vs runtimeId

`RuntimeManifest` carries two IDs:
- `pluginId` — package ID (e.g. `core-world-init`), derived from `name` before `/`. Used for data isolation, tool scoping, trust.
- `name` (= runtimeId) — full runtime name (e.g. `core-world-init/schema-gen`). Used for LLM traces and logs.

All store writes key on `pluginId`; all trace logs key on `runtimeId`.

### Tool scoping

`bootstrap.ts` builds `pluginToolAccess: Map<pluginId, Set<toolName>>`. `findTool(name, context)` enforces:
- Builtin tools — all plugins.
- Local tools — only the declaring plugin.

### Documentation sync rules

**Any code change that touches framework-visible surface area MUST update the matching doc in the same PR.** Missing sync = incomplete PR.

| Change | Doc to update |
|--------|---------------|
| Add/modify/remove plugin | `docs/reference/plugins.md` |
| Add/modify/remove tool (builtin or local) | `docs/reference/tools.md` |
| Change approval policy / tool trust tier | `docs/reference/tools.md` |
| Add/change model slot | `docs/reference/slots.md` (create if missing) |
| Change SSE event type / protocol | `docs/reference/protocol.md` |
| Change right-panel tab / data source | `docs/reference/ui-panels.md` |
| Add/change API endpoint | `docs/reference/api.md` |
| Change package structure / deps | `CLAUDE.md` (Workspace + Dependency Flow) |
| Add/change PLUGIN.md frontmatter field | `docs/reference/plugins.md` + `docs/guide/plugin-authoring.md` |
| Add/change RPC action / framework default | `docs/reference/api.md` (plugin-rpc) + `docs/reference/protocol.md` |
| Add/change approval flow / trust level | `docs/reference/api.md` + `docs/reference/protocol.md` |

### Plugin authoring contract

- Depend only on the Public Plugin API (manifest, runtime, tool, hook, UI slot, provider binding, proposal).
- Never depend on DB table names, ORM models, kernel internals, or frontend components.
- All writes go through proposals; tools must have Zod schemas; high-risk tools declare `permissions`.
- Hooks guard / rewrite / audit — they do **not** carry gameplay logic.
- Provider access only through binding declarations (no direct SDK usage).
- Declare `outputKind` (`story` / `plugin` / `system`) and `capabilities` for framework discovery.
- Optional retry/timeout fields: `timeoutMs`, `maxRetries` (default 1), `callTimeoutMs`, `firstTokenTimeoutMs` (default 30s), `loopDetectionThreshold` (default 3). See [docs/reference/plugins.md](./docs/reference/plugins.md#超时与智能重试).

### Locale as a capability

Locale enters the execution chain via `KernelInput.locale` → `RuntimeContextView.locale`. Resolution order: request → run → world default → app default (`zh-CN`). Plugin manifests use `I18nText = string | Record<string, string>` for display fields.

## State & Persistence

Core objects (never collapse into a single JSON blob): **Run, Branch, Snapshot, State, Event, Record, Character, PluginData**.

Store backends (`@covel/store`): `MemoryStore` (dev/test), `SqliteStore` (desktop), `IdbStore` (browser IDB), `PgStore` (production PG via Drizzle). Selection at server startup: `STORE_BACKEND=pg` + `DATABASE_URL` → PG, else Memory. World seeds load from `COVEL_WORLDS_DIR` (default `worlds/`).

Each SQL backend splits into two files by convention:
- `*-store-mappers.ts` — DDL + Row→Record conversion.
- `*-store.ts` — Factory + DataStore method implementations.

23 tables via Drizzle; full list and transactions contract in [docs/reference/transactions.md](./docs/reference/transactions.md).

- **`sessions.runtime_model_overrides`** — JSONB map of `runtimeId → slot name`, snapshotted into `TurnInput` each turn and consulted by `runtime-slot-resolver` before `manifest.model` / gateway default. Keys still flow via `X-Provider-Keys` + localStorage.
- **JSONB writes**: use `sql.json(value as JSONValue)` — **never** `JSON.stringify()` (double-serialisation bug).

## Server Bootstrap

`bootstrapApi()` in `apps/server/src/routes/api/bootstrap.ts` wires a fully composed Hono app (plugin discovery + registries + middleware injection); `app.ts` is a thin composition root (~80 lines). All endpoints under `/api/` prefix. Full endpoint reference: [docs/reference/api.md](./docs/reference/api.md).

## Testing Conventions

- **vitest** is the single runner (`vitest run` for CI, `vitest` for watch). No Node `node:test`.
- **Contract tests** (`store-contract.ts`): every `DataStore` backend must pass the shared suite. Required for any new backend.
- **Plugin tests**: use `@covel/plugin-test-utils` — `MockLLM`, `createTestHarness`, `makeTurnInput`, `makeTriggerContext`, `makeRuntimeResult`.
- **IDB tests**: `fake-indexeddb` polyfill. **PG tests**: real local DB (`pnpm db:up`).
- **E2E harness**: `scripts/e2e-plugin-verify.ts` is the API-driven, plugin-level, 7-phase harness (artefacts under `debugs/e2e-logs/`) — see [docs/guide/e2e-plugin-verify.md](./docs/guide/e2e-plugin-verify.md).
- Coverage via `@vitest/coverage-v8` on all packages (`--coverage` flag).

## Security & Operations

- **SSRF guard**: `validateBaseUrl()` in `ai-provider/adapters/http.ts` whitelists known providers + localhost + `COVEL_ALLOWED_LLM_HOSTS`, blocks RFC1918 / metadata IPs.
- **Session IDs**: `{worldId}-{uuid8}` via `crypto.randomUUID()` — enumeration-resistant.
- **worldId**: `/^[a-z0-9_-]{1,64}$/i` regex whitelist.
- **Rate limiting**: `middleware/rate-limit.ts` (`rateLimiter()`, `singleFlight()`).
- **Error sanitising**: `middleware/sanitize-error.ts` strips stacks and paths in prod.
- **Debug artefacts**: always write under `debugs/` (never repo root) — gitignored.

### Dev-mode LLM replay cache

Only active when `COVEL_LLM_REPLAY` is set. Zero overhead / zero behaviour change when unset.

| Mode | Behaviour |
|------|-----------|
| `auto` | Hit = replay, miss = call provider + record (dev default) |
| `record` | Always call provider, overwrite cache |
| `replay` | Read-only; miss throws (for breakpoint reproduction) |

Cache dir: `COVEL_LLM_REPLAY_DIR` (default `debugs/llm-cache/`). Key = `sha256(method + url + canonicalJson(body))`. `authorization` / `api_key` are redacted in hash input and on disk. Streaming is T-eed via `TransformStream` (10 MB buffer cap, skip over).

## Observability

Trace chain: `traceId → runId → branchId → turnId → runtimeId → pluginId`.

- **Runtime trace** (DB `trace_events`): structured turn hierarchy — LLM delta messages, tool calls, proposals, hooks, provider binding, context fragments. Delta recording avoids duplicating prompt history.
- **Infrastructure log** (pino): startup, plugin loading, DB, SSE connections.
- **Consumption**: `/api/traces/*`, `TraceExporter` interface (e.g. Langfuse), JSON export for players.
- **Frontend `/debug`**: Session Timeline · Runtime Inspector · Prompt Viewer (full reconstruction + diff) · Data Explorer.

## Deployment Tiers

| Tier | Storage | API keys | Notes |
|------|---------|----------|-------|
| T1 Self-Deploy | Browser IDB | User-managed | No auth |
| T2 Demo Host | Browser IDB | User-managed | HTTPS required |
| T3 Commercial | PostgreSQL | Platform + user | Auth required |

Key env vars: `DEPLOYMENT_TIER`, `CORS_ORIGIN`, `ENABLE_DEBUG_PAGE`, `RATE_LIMIT_RPM`, `STORE_BACKEND`.

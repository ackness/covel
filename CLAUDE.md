# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Covel is an AI RPG plugin-based framework (modular monolith). Core philosophy: **plugins carry gameplay logic, the kernel provides primitives and orchestration**. Each plugin is a self-contained Agent Runtime that declares its own trigger rules, context injection, tool whitelist, and write proxies; the kernel routes turns, assembles context, drives LLM tool-calls, and commits proposals.

Deployable as Web or Electron (desktop). Production desktop builds should use `pnpm build:electron`.

## Documentation Index

Before changing anything non-trivial, consult the matching reference doc — they are the source of truth, CLAUDE.md only points at them.

| Topic                                                | Authoritative doc                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Project intro, quick start, roadmap                  | [README.md](./README.md) · [docs/README.md](./docs/README.md)                                                           |
| End-to-end turn pipeline, full architecture          | [docs/architecture/flow.md](./docs/architecture/flow.md)                                                                |
| Plugin registry (all plugins, priorities, triggers)  | [docs/reference/plugins.md](./docs/reference/plugins.md)                                                                |
| World Data (`worldData`, source import, overrides)   | [docs/reference/world-data.md](./docs/reference/world-data.md)                                                          |
| Tool registry (builtin + local, approval policy)     | [docs/reference/tools.md](./docs/reference/tools.md)                                                                    |
| HTTP API (all endpoints, request/response, curl)     | [docs/reference/api.md](./docs/reference/api.md)                                                                        |
| Protocol (SSE events, envelope, Transport layer)     | [docs/reference/protocol.md](./docs/reference/protocol.md)                                                              |
| Right-panel tabs, json-render declarative UI         | [docs/reference/ui-panels.md](./docs/reference/ui-panels.md)                                                            |
| Prompt assembly (segments, cache_control)            | [docs/reference/prompt-structure.md](./docs/reference/prompt-structure.md)                                              |
| DataStore transactions (begin/commit/rollback)       | [docs/reference/transactions.md](./docs/reference/transactions.md)                                                      |
| Writing a plugin (tutorial + frontmatter fields)     | [docs/guide/plugin-authoring.md](./docs/guide/plugin-authoring.md)                                                      |
| Plugin UI + runtime guidelines                       | [docs/guide/plugin-ui-runtime-guidelines.md](./docs/guide/plugin-ui-runtime-guidelines.md)                              |
| Plugin testing (harness + examples)                  | [docs/guide/plugin-testing.md](./docs/guide/plugin-testing.md)                                                          |
| UI component catalogue (json-render primitives)      | [docs/reference/ui-components.md](./docs/reference/ui-components.md)                                                    |
| Theme packages (player CSS / JSON theme packs)       | [docs/guide/themes.md](./docs/guide/themes.md) · [docs/reference/theme-packages.md](./docs/reference/theme-packages.md) |
| Media store (generated images / portraits, MediaRef) | [docs/reference/media-store.md](./docs/reference/media-store.md)                                                        |
| Terminology glossary (session / runtime / slot / …)  | [docs/glossary.md](./docs/glossary.md)                                                                                  |
| E2E plugin verify harness                            | [docs/guide/e2e-plugin-verify.md](./docs/guide/e2e-plugin-verify.md)                                                    |
| Environment variable registry                        | [docs/guide/env-registry.md](./docs/guide/env-registry.md)                                                              |
| Desktop config (paths, sidecar, safeStorage)         | [docs/guide/desktop-config.md](./docs/guide/desktop-config.md)                                                          |
| Desktop packaging (Electron), signing, notarisation  | [apps/desktop/PACKAGING.md](./apps/desktop/PACKAGING.md)                                                                |
| Contributing & release workflow                      | [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)                                                                          |

## Commands

```bash
# Install & dev
pnpm install
pnpm dev              # web (5173) + server (3001), SqliteStore (default, ./data/covel.db)
pnpm dev:web          # web only
pnpm dev:server       # server only (SqliteStore default; STORE_BACKEND=memory for ephemeral)
pnpm dev:pg           # server only, STORE_BACKEND=pg (auto-runs db preflight; needs pnpm db:up)
pnpm stop             # kill stray dev/turbo processes (dev-supervisor)

# Build & check — the git pre-commit hook runs prettier + oxlint + full `pnpm lint`
pnpm build            # build all
pnpm lint             # tsc --noEmit across workspace (turbo lint; run the FULL workspace, not one pkg)
pnpm format           # prettier --write .   (format:check = verify-only, for CI)
pnpm deps:check       # knip — flag unused / undeclared workspace deps
pnpm check:i18n       # web + plugin i18n coverage + plugin READMEs (check:plugins is a subset)
pnpm test             # vitest via turbo (cached)
pnpm test:coverage    # + @vitest/coverage-v8
pnpm clean

# Single package tests — add --watch for watch, --run for single run
pnpm --filter @covel/runtime test
pnpm --filter @covel/<pkg> test

# Database (Docker)
pnpm db:up / db:down / db:generate / db:migrate / db:studio

# E2E
pnpm e2e              # Playwright headless (e2e:ui for the runner UI)
pnpm e2e:verify       # API-driven, real-LLM plugin harness (needs .env.llm); pass --slot e2e_local --turns 3
pnpm test:runtime     # standalone runtime harness CLI (packages/test-runtime)

# Docker (full stack)
pnpm docker:build / docker:up / docker:down / docker:logs

# Desktop
pnpm dev:electron     # Electron dev shell (real sidecar)
pnpm build:electron   # platform installer → release/ (build:desktop is an alias)

# Release
pnpm release:preflight  # static pre-tag gate: lockfile sync, import resolution, plugin/world/prompt structure
```

## Config Files

Dev-time files (copied from `*.example`):

- `.env` — infrastructure (`STORE_BACKEND`, `DATABASE_URL`, `SERVER_PORT`, `COVEL_WORLDS_DIR`, etc.)
- `llm.toml` — slot routing (`[covel.<slot>]` sections). If missing, server falls back to built-in DeepSeek `story` slot and boots anyway.
- `.env.llm` — provider API keys. Dev server (`tsx watch`) loads `.env` + `.env.llm` from repo root.

Desktop-shell files under `<covelHome>/` (typically `~/.covel/`):

- `config.toml` — desktop shell config (paths, log rotation)
- `llm.toml` — hand-editable slot / provider definitions (same schema as dev-time). Hot-reloaded from Settings without a server restart.
- `keys.env` — provider API keys, mode 600
- `settings.json` — front-end user preferences (locale, appearance, slot overrides, custom presets, parameter overrides, per-plugin settings). Managed via the unified **SettingsStore** (`@covel/settings`, `packages/settings/src/`). Auto-saved on every change; mirrored to `localStorage` (`covel:settings`) on pure-web tiers.

Provider API keys flow through the `SettingsStore` too: writes end up in `keys.env` on desktop, `localStorage` (`covel:keys`) on web. They are never persisted server-side by the REST API — each AI request passes them via the `X-Provider-Keys` header (base64).

## Monorepo Structure

- pnpm workspaces + Turborepo. `pnpm@10.33.2`, Node ≥ 22.9 (dev scripts use `--env-file-if-exists`).
- ESM-only (`"type": "module"`), TypeScript strict, ES2022, NodeNext module resolution — **use `.js` extensions in TS imports**.
- Packages export TS source directly (`"import": "./src/index.ts"`) — no build step for dev.

```
apps/
  web/              Web UI (React 19 + Vite + TanStack Router, json-render + plugin-driven panels)
  server/           Hono API + Drizzle ORM
  desktop/          Electron shell (sidecar)

packages/           16 internal packages: shared, settings, context, ai-provider,
                    plugin-loader, runtime, store, state, events, tools,
                    approval, memory, create, plugin-test-utils, test-runtime,
                    plugin-handlers-utils (pure helper utils for plugin
                    function-runtime handlers). `settings` carries the unified
                    SettingsStore + localStorage/json-file backends, split out of
                    `shared` so pure-type consumers avoid browser/Electron code.

plugins/            20 bundled plugin packages (see docs/reference/plugins.md)
prompts/            Externalised prompt templates (locale-aware markdown)
worlds/             2 curated sample world packages (mistport / haruka-academy);
                    archived worlds in worlds/_archive/ are not loaded
```

Dependency flow (rough):

```
shared ← context ← runtime ← server (composes all)
shared ← ai-provider ← runtime   (runtime re-exports the Public Plugin API types)
shared ← settings ← web
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

- **Trigger modes**: production-active are `auto`, `manual`, `scheduled`, `event` (see `TriggerType` in `packages/shared/src/types/plugin.ts`). `scheduled` carries `interval` / `maxTriggerCount` / `cooldownTurns` / `startTurn`. `conditional` and `error-retry` are **reserved — they never fire in production** (no condition engine; the scheduler never surfaces upstream failures); `shouldTrigger` skips them and warns once. The single authority for `auto` / `scheduled` / `event` trigger decisions is `shouldTrigger` (`packages/runtime/src/trigger/trigger.ts`) — the in-turn event fan-out in `turn-event-chain.ts` re-uses it too. **`manual` is the exception**: a `manual` runtime is selected by name match in `scheduling.ts` (`selectTriggeredRuntimes`) and runs **without** calling `shouldTrigger` — an explicit plugin-rpc call _is_ the trigger decision, so it bypasses the `preGameCompleted` / `startTurn` / `maxTriggerCount` / `cooldownTurns` gates (the `case "manual"` branch in `shouldTrigger` is consequently dead in the production selection path).
- **Runtime types**: `agent` (default, loads PLUGIN.md and drives LLM tool-calls) or `function` (pure JS handler, no LLM).
- **Proposal envelopes** (registered `ProposalType`s, derived from the single source of truth `ProposalPayloadMap` in `packages/shared/src/types/proposal.ts`; commit-handler registry and discovery advert are compile-time aligned to it): `narrative.append`, `state.patch`, `event.emit`, `interaction.request`, `ui.render`, `asset.generate`, `plugin.data`, `plugin.data.batch`, `character.upsert`, `working_memory.set`, `lorebook.upsert`. Full reference in [docs/reference/tools.md](./docs/reference/tools.md#proposal-类型). **All writes flow through validate → commit — plugins never touch the DB directly.**
- **Hook lifecycle** (16 events; full table in [docs/reference/plugins.md](./docs/reference/plugins.md)): `SessionStart` · `TurnStart` · `PreCompaction` / `PostCompaction` · `PreSchedule` · `PreRuntime` / `PostRuntime` · `PostContextAssembly` · `PreLLMCall` / `PostLLMResponse` · `PreToolUse` / `PostToolUse` · `PreStateCommit` / `PostStateCommit` · `TurnStop` · `SessionEnd`. Registered hooks are session-scoped (a plugin's hooks fire only for sessions where it is active, via `AsyncLocalStorage`); `HookContext.getOwnSettings()` exposes the plugin's own per-session `userSettings`.

### Priority bands (kernel-enforced)

| Turn | Scheduled priority | Phase                                                             |
| ---- | ------------------ | ----------------------------------------------------------------- |
| 0    | 0–99               | Pre-Game (Pre-Game runtimes report `preGameDone: true`)           |
| ≥ 1  | 100–1000           | Pre-Turn 100–499 · Narrator 500 · After-Turn 501–999 · Audit 1000 |

Session lifecycle tracked by three fields on `SessionRecord`:

- `status: 'active' | 'paused' | 'ended'` — `paused`/`ended` halts scheduling.
- `turnCount: number` — band selector. Kernel auto-advances 0 → 1 once all Pre-Game runtimes report done.
- `preGameCompleted: string[]` — runtimeIds that reported done.

### Plugin system

- **Layout**: `PLUGIN.md` (frontmatter + agent skill prompt) + `package.json` is the minimum. Optional: `prompts/`, `schemas/`, `server/`, `client/`, `ui/`.
- **Session scope**: Global plugin pool loaded at startup; each session's `SessionRecord.activePlugins` (string[]) is the active set. Runtime selection, tool lookup, and hooks all filter against it (hooks see it as `activePluginIds` via `AsyncLocalStorage`, see `packages/runtime/src/hooks/hook-scope.ts`). World manifest seeds initial set; enable/disable mid-session applies next turn.
- **Trust tiers**: `builtin` (auto-load) · `official` (whitelist) · `community` (deferred `import()` until user approves).
- **Plugin data**: session-scoped KV storage keyed by `(sessionId, pluginId, namespace, key)` in `plugin_data` table. Builtin tools: `plugin-data-{set,get,list,set-batch}`, `create-character` / `update-character` / `list-characters` / `get-character`, `emit-event`.
- **Plugin-data inject** (agent runtimes): `input.inject` with `kind: plugin-data` reads the runtime's own namespace and inlines a summary into the system prompt (avoids tool-call round-trips). Switches that runtime to the async context path.

Detailed field reference, per-plugin table, and trigger semantics: [docs/reference/plugins.md](./docs/reference/plugins.md) · [docs/guide/plugin-authoring.md](./docs/guide/plugin-authoring.md).

### Plugin UI (declarative, json-render)

All panels/blocks render through [json-render](https://github.com/vercel-labs/json-render) with a framework-defined ~48-component catalog ([docs/reference/ui-components.md](./docs/reference/ui-components.md)). Plugins declare `ui: { right, message, left }` in PLUGIN.md, pointing at JSON specs under `ui/`. `GET /api/ui-specs` aggregates them; frontend discovers panels at boot. `plugin-data.changed` SSE events drive re-renders. Three-tier resolution: custom React (`.tsx`) → json-render spec (`.json`) → raw JSON fallback. Details in [docs/reference/ui-panels.md](./docs/reference/ui-panels.md).

### Model slot system

- Named slots: `default` (main narrative — auto-aliased to the first slot defined), `fast`, `balance`, `image`.
- Configured via `llm.toml` `[covel.<slot>]` sections. If missing, single `story` → DeepSeek fallback boots the app.
- **Tag-aware fallback**: an unconfigured slot falls back to the first slot with the same tag (`text`/`image`/`embedding`/`speech`/`transcription`). Cross-tag fallback is forbidden (an image request never silently routes to text).
- Supports OpenAI, Anthropic, DeepSeek, Qwen (Aliyun DashScope).
- **Model capabilities** (multimodal, features, token limits, pricing) auto-detected via: frontend localStorage override → `llm.toml` manual → `known-models.ts` (~60 common) → LiteLLM DB (2967 models, `pnpm --filter @covel/ai-provider update-model-db`) → protocol defaults. Directional modality: `input: InputModality[]` = accepts, `output: OutputModality[]` = produces.
- **Media generation (image / TTS / STT)**: `ctx.images.generate()` and `ctx.speech.generate()`/`.transcribe()` (function-runtime plugins, preferred) route through pluggable per-modality wire registries — builtin `openai-images` (default) + `dashscope-wan` for image, `openai-speech` / `openai-transcription` for speech — selectable per-slot via `llm.toml` `providerRequestMetadata.imageWire|speechWire|transcriptionWire`. Both `generate` paths dedupe on promptHash and persist to MediaStore. Plugins register vendor wires via the PLUGIN.md `wires` frontmatter field (ids namespaced `<pluginId>/<wireId>`, trust-gated loading in `bootstrap/plugin-wires.ts`); bundled code may call `register{Image,Speech,Transcription}Wire()` directly. See [docs/reference/slots.md](./docs/reference/slots.md), [docs/reference/media-store.md](./docs/reference/media-store.md) and [docs/guide/plugin-authoring-advanced.md](./docs/guide/plugin-authoring-advanced.md#6-函数-runtime手动触发与后台执行).

## Critical Conventions (Read These)

### Framework ↔ Plugin Isolation Rule (CRITICAL)

**框架代码（`packages/`、`apps/server/src/`、`apps/web*/src/`）禁止硬编码任何具体插件 ID 或名称。**

Violations:

- `pluginId === 'narrator'` · `store.listPluginData(sessionId, 'world-init', ...)` · `p.id === 'image'`.

Correct approach:

- Dispatch on `RuntimeManifest.outputKind` (`story` / `plugin` / `system`).
- Discover via `RuntimeManifest.capabilities` (e.g. `narrative`, `world-data-provider`, `image-generation`).
- Use `pluginType` to gate on core vs third-party.
- Test files may use real plugin IDs as fixtures; production code must not.
- **UI curation/preset data may list concrete plugin IDs as _data_** (e.g. the front-end plugin packs in `apps/web/src/lib/session-plugin-selection.ts`, which a player picks from). The rule bans hardcoded IDs in **dispatch/control flow** — `if`/`switch` on a plugin ID to change behavior — not curated, user-overridable selection lists. The runtime still discovers and dispatches by `outputKind`/`capabilities`.

**Character creation convention**: forms marked with `_createCharacter: true` cause the framework to auto-create a `CharacterRecord`.

### Identity model: pluginId vs runtimeId

`RuntimeManifest` carries two IDs:

- `pluginId` — package ID (e.g. `world-init`), derived from `name` before `/`. Used for data isolation, tool scoping, trust.
- `name` (= runtimeId) — full runtime name (e.g. `world-init/schema-gen`). Used for LLM traces and logs.

All store writes key on `pluginId`; all trace logs key on `runtimeId`.

### Tool scoping

`bootstrap.ts` builds `pluginToolAccess: Map<pluginId, Set<toolName>>`. `findTool(name, context)` enforces:

- Builtin tools — all plugins.
- Local tools — only the declaring plugin.

### Documentation sync rules

**Any code change that touches framework-visible surface area MUST update the matching doc in the same PR.** Missing sync = incomplete PR.

| Change                                    | Doc to update                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Add/modify/remove plugin                  | `docs/reference/plugins.md`                                                                      |
| Add/modify/remove tool (builtin or local) | `docs/reference/tools.md`                                                                        |
| Change approval policy / tool trust tier  | `docs/reference/tools.md`                                                                        |
| Add/change model slot                     | `docs/reference/slots.md` (create if missing)                                                    |
| Change SSE event type / protocol          | `docs/reference/protocol.md`                                                                     |
| Change right-panel tab / data source      | `docs/reference/ui-panels.md`                                                                    |
| Add/change API endpoint                   | `docs/reference/api.md`                                                                          |
| Change package structure / deps           | `CLAUDE.md` (Workspace + Dependency Flow)                                                        |
| Add/change PLUGIN.md frontmatter field    | `docs/reference/plugins.md` + `docs/guide/plugin-authoring.md`                                   |
| Add/change `PLUGIN.md dataSchemas`        | `docs/reference/plugins.md` + `docs/guide/plugin-authoring*.md` + `docs/reference/world-data.md` |
| Add/change world package `worldData`      | `docs/reference/world-data.md` + relevant guide docs                                             |
| Add/change world-data import/sync rules   | `docs/reference/world-data.md` + `docs/reference/api.md` + `docs/reference/transactions.md`      |
| Add/change RPC action / framework default | `docs/reference/api.md` (plugin-rpc) + `docs/reference/protocol.md`                              |
| Add/change approval flow / trust level    | `docs/reference/api.md` + `docs/reference/protocol.md`                                           |
| Modify `README.md` (English, primary)     | `README.zh-CN.md` (must sync in same PR)                                                         |
| Modify `README.zh-CN.md`                  | `README.md` (must sync in same PR)                                                               |

### Plugin authoring contract

- Depend only on the Public Plugin API (manifest, runtime, tool, hook, UI slot, provider binding, proposal).
- Never depend on DB table names, ORM models, kernel internals, or frontend components.
- All writes go through proposals; tools must have Zod schemas; high-risk tools declare `permissions`.
- Hooks guard / rewrite / audit — they do **not** carry gameplay logic.
- Provider access only through binding declarations (no direct SDK usage) — image generation goes through `ctx.images` / `ctx.gateway.generateImage`, never a hand-rolled provider fetch.
- Declare `outputKind` (`story` / `plugin` / `system`) and `capabilities` for framework discovery.
- Optional retry/timeout fields: `timeoutMs`, `maxRetries` (default 1), `callTimeoutMs`, `firstTokenTimeoutMs` (default 30s), `loopDetectionThreshold` (default 3). See [docs/reference/plugins.md](./docs/reference/plugins.md#超时与智能重试).

### Locale as a capability

Locale enters the execution chain via `KernelInput.locale` → `RuntimeContextView.locale`. Resolution order: request → run → world default → app default (`zh-CN`). Plugin manifests use `I18nText = string | Record<string, string>` for display fields.

## State & Persistence

Core objects (never collapse into a single JSON blob): **Run, Branch, Snapshot, State, Event, Record, Character, PluginData**.

Store backends (`@covel/store`): `MemoryStore` (dev/test), `SqliteStore` (desktop/default), `IdbStore` (browser IDB), `PgStore` (production PG via Drizzle). Selection at server startup uses `STORE_BACKEND=memory|sqlite|pg` with default `sqlite`; `STORE_BACKEND=pg` requires `DATABASE_URL`. Browser `local` mode uses IDB through `createStore({ backend: "idb" })`; browser `remote` mode uses the server API and the server's configured backend. `MEDIA_BACKEND=mirror` follows the server data backend by default. `VECTOR_BACKEND=embedded` uses the active DataStore vector capability. World seeds load from `COVEL_WORLDS_DIR` (default `worlds/`). Desktop shells additionally pass `COVEL_USER_WORLDS_DIR=<data_root>/worlds` so user-authored worlds move together with SQLite and logs when `data_root` is redirected.

Each SQL backend keeps a thin public factory plus focused method modules:

- `*-store.ts` — factory and `DataStore` composition.
- `schema.ts` plus `*-schema-ddl.ts` — table shapes and backend DDL.
- `*-store-mappers.ts` / `*-store-values.ts` — row conversion and JSON helpers.
- `*-data-crud.ts`, `*-runtime-records.ts`, `*-session-*`, `*-snapshot*`, `*-state*`, `*-world*` — focused persistence surfaces.

27 tables via Drizzle; authoritative list in `packages/store/src/{sqlite,postgres}/schema.ts`, transactions contract in [docs/reference/transactions.md](./docs/reference/transactions.md).

- **`sessions.runtime_model_overrides`** — JSONB map of `runtimeId → slot name`, snapshotted into `TurnInput` each turn and consulted by `runtime-slot-resolver` before `manifest.model` / gateway default. Keys still flow via `X-Provider-Keys` + localStorage.
- **JSONB writes**: use `sql.json(value as JSONValue)` — **never** `JSON.stringify()` (double-serialisation bug).

## Server Bootstrap

`bootstrapApi()` in `apps/server/src/routes/api/bootstrap.ts` wires a fully composed Hono app (plugin discovery + registries + middleware injection); `app.ts` is the composition root (~420 lines: env/key loading, store + AI stack setup, middleware, then delegates to `bootstrapApi()`). All endpoints under `/api/` prefix. Full endpoint reference: [docs/reference/api.md](./docs/reference/api.md).

## Testing Conventions

- **vitest** is the single runner (`vitest run` for CI, `vitest` for watch). No Node `node:test`.
- **Contract tests** (`store-contract.ts` + `contract/suites/`): every `DataStore` backend must pass the shared suite. Required for any new backend.
- **Plugin tests**: use `@covel/plugin-test-utils` — `MockLLM`, `makeManualFunctionContext`, `expectAssetGenerated`, `makeTurnInput`, `makeTriggerContext`, `makeRuntimeResult`.
- **IDB tests**: `fake-indexeddb` polyfill. **PG tests**: real local DB (`pnpm db:up`).
- **E2E harness**: `scripts/e2e-plugin-verify.ts` is the API-driven, plugin-level, 7-phase harness (artefacts under `debugs/e2e-logs/`) — see [docs/guide/e2e-plugin-verify.md](./docs/guide/e2e-plugin-verify.md).
- Coverage via `@vitest/coverage-v8` on all packages (`--coverage` flag).

## Security & Operations

- **SSRF guard**: `validateBaseUrl()` in `ai-provider/adapters/http.ts` is **open by default** — any public https host is allowed. Blocks: RFC1918 / link-local IPs (`10.x` / `172.16-31.x` / `192.168.x` / `169.254.x` / `fc00::` / `fe80::`), cloud metadata hostnames (`metadata.google.internal`, `metadata.internal`), non-https on remote hosts, non-http(s) protocols. Loopback (`localhost` / `127.0.0.1` / `::1`) bypasses the https requirement for Ollama-style local dev. Additionally, core provider requests (`postJson` / `getJson` / `postFormData`) and the plugin `ctx.http` helper resolve DNS through a pinning dispatcher (`adapters/http/dns-safety.ts`): every A/AAAA answer must be publicly routable (loopback hostnames must resolve to loopback), closing the string-check-to-connect DNS-rebinding gap. **Self-tier exemption (core provider path only)**: on the `self` tier (desktop/self-deploy default — already loopback-bound with owner/operator tokens as no-ops), the core provider path (the user's own configured LLM `baseUrl`) accepts any resolver answer for a hostname (the socket is still pinned to it). Single-user local machines run TUN proxies (Clash/mihomo/sing-box/Surge map every domain into a private/benchmark range and route by SNI) and LAN endpoints (Ollama at `192.168.x.x`) that the public-only rule wrongly rejected. The exemption is NOT granted to the plugin `ctx.http` path (third-party plugin code stays strict — no probing the local network even on a desktop install), to IP-literal URLs (url-safety's string check still blocks private literals), or to hosted tiers (`demo`/`commercial` may run inside a cloud network where private answers reach real internal services). There is **no host allowlist env** — the guard is open by design; third-party plugin authors targeting custom provider hosts do not need any env shim (the never-read `COVEL_ALLOWED_LLM_HOSTS` registry entry was removed).
- **Env-key origin binding (S-01)**: server-env / platform API keys flow to the gateway as `envApiKeys`, separate from request-supplied `X-Provider-Keys` (`apiKeys`). The provider registry only attaches an env key when the resolved target's baseUrl origin matches trusted config (llm.toml / registered provider defaults) — a request-scoped custom preset (`X-Slot-Config` overlay) that redirects a provider to another origin gets no env key and no trusted default headers; it must supply its own key.
- **Hosted auth (S-02/C-01/C-02)**: `demo` / `commercial` tiers enforce a per-session **owner token** (minted at session create, hash-persisted in `SessionRecord.metadata`, returned once) on every session-scoped route, and an **operator token** (`COVEL_DESKTOP_REST_TOKEN`, also a master key that passes any owner check) on global/admin routes (session create/list, world writes, AI/model, community server-code activation). `validateSecurityPosture` fails boot on a hosted tier missing the operator token / media secret / CORS origin. The server binds `127.0.0.1` by default (`COVEL_BIND_HOST` opts into `0.0.0.0`). `self` / desktop / dev are a strict no-op (single-user local play unchanged). Community server code (`entry` / handler / hook / wire / runtime JS) is import-gated behind two-phase approval (a `covel:plugin-server-code` grant, then the action grant). Full model: [docs/reference/api.md](./docs/reference/api.md) 鉴权 section.
- **Signed media URLs**: `middleware/media-token.ts` signs `MediaRef` URLs with `COVEL_MEDIA_TOKEN_SECRET`. Desktop shells must provision it or generated images/portraits fail to load; web uses an ephemeral per-boot secret.
- **Session IDs**: `{worldId}-{uuid8}` via `crypto.randomUUID()` — enumeration-resistant.
- **worldId**: `/^[a-z0-9_-]{1,64}$/i` regex whitelist.
- **Rate limiting**: `middleware/rate-limit.ts` (`rateLimiter()`, `singleFlight()`).
- **Error sanitising**: the `app.onError` handler (`routes/api/bootstrap.ts` + `app.ts`) returns `"Internal server error"` in prod (stacks/paths only to `console.error`); dev returns `err.message`.
- **Debug artefacts**: always write under `debugs/` (never repo root) — gitignored.

## Observability

Trace chain: `traceId → runId → branchId → turnId → runtimeId → pluginId`.

- **Runtime trace** (DB `trace_events`): structured turn hierarchy — LLM delta messages, tool calls, proposals, hooks, provider binding, context fragments. Delta recording avoids duplicating prompt history.
- **Infrastructure log** (console, `[component]`-prefixed): startup, plugin loading, DB, SSE connections.
- **Consumption**: `/api/traces/*` endpoints, JSON export for players.
- **Frontend `/debug`**: Session Timeline · Runtime Inspector · Prompt Viewer (full reconstruction + diff) · Data Explorer · Cost (token-usage aggregation from `llm.responded` / `gateway.responded` trace usage, with per-model USD estimation via model-db pricing — model recovered by pairing each `llm.responded` with the preceding `llm.calling`).

## Deployment Tiers

| Tier           | Storage              | API keys        | Notes                       |
| -------------- | -------------------- | --------------- | --------------------------- |
| T1 Self-Deploy | SQLite / Browser IDB | User-managed    | No auth; binds loopback     |
| T2 Demo Host   | SQLite / Browser IDB | User-managed    | HTTPS + owner/operator auth |
| T3 Commercial  | PostgreSQL           | Platform + user | Owner + operator auth       |

`demo` / `commercial` hard-enforce per-session owner tokens on session-scoped routes and gate global/admin routes on the operator token (`COVEL_DESKTOP_REST_TOKEN`); `validateSecurityPosture` fails boot without it. `self` / desktop binds `127.0.0.1` by default and treats the tokens as no-ops. See the Hosted-auth bullet under Security & Operations and [docs/reference/api.md](./docs/reference/api.md).

Key env vars: `DEPLOYMENT_TIER`, `COVEL_BIND_HOST`, `COVEL_DESKTOP_REST_TOKEN`, `CORS_ORIGIN`, `ENABLE_DEBUG_PAGE`, `RATE_LIMIT_RPM`, `STORE_BACKEND`.

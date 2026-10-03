# AGENTS.md

Shared instructions for every coding agent in this repository. Codex reads this
file directly; Claude Code loads it through `CLAUDE.md`. Keep agent rules here
so the two never drift.

## Project Overview

Covel is a plugin-based AI RPG framework (pnpm/Turborepo TypeScript modular
monolith). **Plugins carry gameplay logic; the kernel provides primitives and
orchestration.** Each plugin is a self-contained Agent Runtime that declares its
own trigger rules, context injection, tool whitelist, and write proxies; the
kernel routes turns, assembles context, drives LLM tool calls, and commits
proposals. It ships as Web or Electron desktop (`pnpm build:electron`).

## Documentation

`docs/` is the source of truth; this file only points at it. Consult the matching
page before any non-trivial change.

- Intro, quick start, roadmap: `README.md`, `docs/README.md`
- Turn pipeline and full architecture: `docs/architecture/flow.md`
- Kernel vs plugin rulings: `docs/architecture/design-principles.md`
- Storage contracts (DataStore, MediaStore, caches): `docs/architecture/storage.md`
- Security boundaries (SSRF/DNS pinning, key binding, hosted auth): `docs/architecture/security.md`
- Plugin registry (plugins, stages, triggers, hooks): `docs/reference/plugins.md`
- World data, dynamic dimensions: `docs/reference/world-data.md`, `docs/reference/dynamic-dimensions.md`
- Tools and approval policy: `docs/reference/tools.md`
- HTTP API: `docs/reference/api.md`; SSE protocol and transport: `docs/reference/protocol.md`
- Right-panel tabs and json-render UI: `docs/reference/ui-panels.md`, `docs/reference/ui-components.md`
- Prompt assembly: `docs/reference/prompt-structure.md`
- DataStore transactions: `docs/reference/transactions.md`
- Model slots: `docs/reference/slots.md`; media store: `docs/reference/media-store.md`
- Plugin authoring, UI/runtime guidelines, testing: `docs/guide/plugin-authoring.md`, `docs/guide/plugin-ui-runtime-guidelines.md`, `docs/guide/plugin-testing.md`
- How to write a prompt body (contract zone, voice zone, vocabulary): `docs/guide/prompt-style.md`
- Theme packages: `docs/guide/themes.md`, `docs/reference/theme-packages.md`
- Terminology: `docs/glossary.md`
- E2E plugin harness: `docs/guide/e2e-plugin-verify.md`
- Environment variables: `docs/guide/env-registry.md`
- Desktop config and packaging: `docs/guide/desktop-config.md`, `docs/guide/desktop-packaging.md`
- Contributing, CI, and release workflow: `docs/CONTRIBUTING.md`

Keep durable user/developer documentation (guides, contracts, architecture) in
`docs/`. Put task plans, audits, implementation logs, temporary analysis, and
handoff notes under `devs/docs/`. Do not create top-level `audits/`, `plans/`,
`context.md`, or `progress.md` artifacts. Debug artefacts (screenshots, logs,
dumps) go under the gitignored `debugs/`, never the repo root.

## Commands

Toolchain versions come from `mise.toml` (Node 26, pnpm 12.6.0, actionlint).

```bash
pnpm install --frozen-lockfile
pnpm dev              # web (5173) + server (3001), SqliteStore (./data/covel.db)
                      # server watches plugins/**/*.{md,js,json,yaml}; editing a PLUGIN.md, handler or locale file restarts it
pnpm dev:server       # server only (STORE_BACKEND=memory for ephemeral)
pnpm dev:pg           # STORE_BACKEND=pg with db preflight; run `pnpm db:up` first
pnpm stop             # kill stray dev/turbo processes
pnpm check            # the CI static gate: peers, lint, package boundaries, deps:check,
                      # plugin manifests, schema reference, prompt variants, i18n, script regressions, actionlint
pnpm lint             # tsc --noEmit for the FULL workspace (not one package)
pnpm test             # all Vitest suites; one package: pnpm --filter @covel/runtime test
pnpm test:pg          # required PostgreSQL integration tests (DATABASE_URL from env or .env)
pnpm e2e:smoke        # deterministic Chromium smoke suite run by CI; pnpm e2e for all Playwright
pnpm e2e:verify       # API-driven real-LLM plugin harness (needs .env.llm); uses the configured models, --slot overrides the story slot
pnpm schemas:generate # regenerate packages/shared/schemas/*.json and docs/reference/schema/*.md
                      # from the Zod schemas; run after changing an author-facing schema field
pnpm describe:authoring  # what a world may contain for the scanned plugins: files, data contracts
                      # with a ready descriptor entry and example, plugin IDs and settings
                      # (--json, --check validates plugin examples, --plugins <dir>)
pnpm validate:plugin  # validate PLUGIN.md manifests; a plugin DIR also gets cross-runtime checks
pnpm validate:world   # validate world packages (manifest, lore, plugin IDs, every seed record):
                      # pnpm validate:world [--strict] [--plugins <dir>] worlds/<id>
pnpm validate:collection  # static check of a covel-collection.yaml directory (docs/guide/collections.md)
pnpm create-collection    # scaffold a collection: pnpm create-collection <id> [dir]
pnpm pack:collection      # zip a collection for offline import: pnpm pack:collection <dir> [out.zip]
pnpm check:i18n       # web + plugin i18n coverage + plugin READMEs; tool definitions are English;
                      # Chinese text in framework source only in recorded files; every label and
                      # text of a bundled plugin has a current Chinese translation
pnpm i18n             # translation tooling for a plugin or world directory: status, extract,
                      # translate (configured model), lock (docs/reference/i18n.md)
pnpm check:prompts    # plugin and template prompts are English; each *.zh.md variant matches its English prompt
                      # (pnpm prompts:lock records a pair after both languages changed); it also prints
                      # style and structure warnings, which do not fail it (docs/guide/prompt-style.md)
pnpm deps:check       # Fallow: unused/unlisted deps and unresolved imports (.fallowrc.jsonc)
pnpm analyze          # Fallow report: dead code, duplication, complexity
pnpm format           # Prettier
pnpm build            # all Turbo build targets
pnpm build:electron   # production desktop installer → release/
pnpm release:preflight  # static pre-tag gate: lockfile, imports, plugin/world/prompt structure
pnpm test:runtime     # standalone runtime harness CLI (packages/test-runtime)
```

Before pushing, run `pnpm check` and `pnpm test` — `pnpm lint` alone misses the
dependency, manifest, i18n, and workflow gates. Add `pnpm test:pg` for store or
database changes and `pnpm e2e:smoke` / `pnpm e2e` for UI flows.

Git hooks: pre-commit (`.pre-commit-config.yaml`) runs Prettier, Oxlint, and the
full `pnpm lint`. `pnpm hooks:install` adds a pre-push hook that runs install,
`pnpm check`, `pnpm test`, and `pnpm e2e --list` in a clean checkout of each pushed
tip (`pnpm check:push` runs the same check on HEAD). CI (`.github/workflows/ci.yml`)
runs check/test/build, Web unit tests, PostgreSQL integration, and browser smoke in
parallel jobs; see `docs/CONTRIBUTING.md`.

Run Tailwind diagnostics through `apps/web/scripts/check-tailwind-canonical.mjs`.
Keep `tailwind-lint` read-only: v0.12.1 can treat ordinary TypeScript identifiers
as classes and corrupt them through `--fix`. Canonical numeric Tailwind utilities
depend on the default `--spacing` scale; audit fixed-layout geometry before
overriding that token globally.

## Config Files

Dev-time files, copied from `*.example` — never commit them:

- `.env` — infrastructure (`STORE_BACKEND`, `DATABASE_URL`, `SERVER_PORT`, `COVEL_WORLDS_DIR`, …)
- `llm.toml` — slot routing (`[covel.<slot>]`). Missing → built-in DeepSeek `story` slot.
- `.env.llm` — provider API keys. The dev server loads `.env` + `.env.llm` from the repo root.

Desktop files live under `<covelHome>/` (typically `~/.covel/`): `config.toml`
(paths, logs, proxy), `llm.toml` (hot-reloaded from Settings), `keys.env` (mode
600), and `settings.json` (front-end preferences through the `@covel/settings`
SettingsStore, mirrored to `localStorage` `covel:settings` on web). Provider keys
also flow through the SettingsStore (`keys.env` on desktop, `localStorage`
`covel:keys` on web); the server never persists them — each AI request passes
them in the `X-Provider-Keys` header (base64).

## Monorepo Structure

- `apps/` (`web` React/Vite client · `server` Hono API · `desktop` Electron shell),
  `packages/` (framework libraries), `plugins/` (see `docs/reference/plugins.md`),
  `prompts/` (locale-aware prompt templates), `worlds/` (`worlds/_archive/` is not
  loaded), `templates/` (plugin scaffolds for `pnpm create-plugin`).
- Each `plugins/<name>/` needs `PLUGIN.md` + `package.json`; optional `prompts/`,
  `schemas/`, `server/`, `client/`, `ui/`, `tests/`, and `locales/<locale>.yaml`
  (translations of labels, UI text and text in code; the main files are English;
  `locales/lock.json` records the English text each label translation is for).
- ESM-only, TypeScript strict, ES2022, NodeNext — **use `.js` extensions in TS
  relative imports**. Packages export TS source directly (`"import": "./src/index.ts"`);
  there is no build step for dev.
- `shared` is the root of every dependency edge; `@covel/server` composes every
  feature package. `@covel/settings` holds the SettingsStore and its backends, split
  from `shared` so pure-type consumers avoid browser/Electron code. Exact edges live
  in each `package.json`.

## Coding Style

Follow Prettier (two spaces, double quotes, semicolons). `camelCase` values and
functions, `PascalCase` types and React components, kebab-case module names. Avoid
bare `any`; validate external input with Zod. 400 and 800 lines are file-size
review guidelines, not hard limits — split a file only when its responsibilities or
maintenance cost justify it.

## Architecture Essentials

First-class execution primitives are **Runtime, Tool, Hook, Context, Proposal**; a
plugin package is only the distribution unit. Full walkthrough:
`docs/architecture/flow.md`.

```
Input/Event → Trigger Router → Stage Scheduler → [per stage:]
  → TurnContextStore.init → PromptAssembler.build → Runtime Runner
  → Tool/Hook Loop → Proposal Collector → TurnContextStore.ingest
→ Validation/Policy → Commit Service → Render/Side Effects
→ Follow-up Events (may re-enter Router)
```

- **Trigger modes** are the closed enum `auto` / `manual` / `scheduled` / `event`
  (`TriggerType` in `packages/shared/src/types/plugin.ts`); other values are rejected
  at load. `shouldTrigger` (`packages/runtime/src/trigger/trigger.ts`) is the single
  authority for `auto` / `scheduled` / `event`, including the in-turn event fan-out.
  **`manual` is the exception**: `selectTriggeredRuntimes` selects it by name match
  without calling `shouldTrigger` — an explicit plugin-rpc call is the trigger
  decision, so it bypasses `phase` / `startTurn` / `maxTriggerCount` / `cooldownTurns`
  (the `manual` branch in `shouldTrigger` serves only direct callers).
- **Scheduling** is declared, never numeric: a named `stage` plus typed edges —
  `needs` (turn-scoped upstream gate + same-pass DAG edge), `after` (ordering only),
  and `inputs` bindings / `input.inject`. Function runtimes also get `ctx.inputs`,
  `ctx.exports`, `ctx.activation`, `ctx.execution`, `ctx.progress.report`. Every
  bundled plugin declares `stage` + `needs`/`after`; intra-stage order comes only
  from declared edges, independent runtimes run in parallel, and `name` breaks ties.
- **Stage bands**: `setup` runs while `phase === "setup"` (setup runtimes report
  `preGameDone: true`); the main loop runs
  `pre-turn → narrative → post-turn → audit` with a barrier between stages (each
  stage fully settles before the next).
- **Session clock** (`SessionRecord`): `status` (`active` / `paused` / `ended`),
  `phase` (`setup` / `playing`), `completedPlayerTurns` (only committed player
  executions count — setup and the opening continuation do not, so the opening
  shares `logicalTurn = 1` with the first message; manual, background, and
  recursive executions persist their own
  `turn_results` row with `origin` and are excluded), and `setupRuntimes` (per-runtime
  `pending` / `done{completed|waived}` / `blocked`). These are current-only: builds do
  not accept or reconstruct deprecated clock fields.
- **Runtime types**: `agent` (default; PLUGIN.md drives LLM tool calls) or
  `function` (pure JS handler).
- **Proposals**: `ProposalPayloadMap` in `packages/shared/src/types/proposal.ts` is
  the single source of truth for proposal types (list in `docs/reference/tools.md`).
  **All writes flow through validate → commit; plugins never touch the DB directly.**
- **Hooks**: lifecycle events are enumerated once in `HOOK_EVENTS`
  (`packages/shared/src/types/hooks.ts`). Hooks are session-scoped through
  `AsyncLocalStorage`; `HookContext.getOwnSettings()` exposes the plugin's own
  `userSettings`.
- **Plugins**: a global pool loads at startup; `SessionRecord.activePlugins` is each
  session's active set (seeded by the world manifest, changes apply next turn).
  Sources are `builtin` (auto-load) and `community` (deferred `import()` after
  approval). Plugin data is session-scoped KV keyed by
  `(sessionId, pluginId, namespace, key)`; `input.inject` with `kind: plugin-data`
  inlines a runtime's own namespace into its prompt.
- **Plugin UI** is declarative json-render: plugins declare
  `ui: { right, message, left }` specs, `GET /api/ui-specs` aggregates them, and
  `plugin-data.changed` SSE events drive re-renders.
- **Model slots**: named `[covel.<slot>]` routes (`default`, `fast`, `balance`,
  `image`, …) with same-tag fallback only — an image request never routes to text.
  Media generation goes through `ctx.images` / `ctx.speech` and per-modality wire
  registries. Details: `docs/reference/slots.md`, `docs/reference/media-store.md`.

## Critical Conventions

### Framework ↔ Plugin Isolation Rule

**Framework code (`packages/`, `apps/server/src/`, `apps/web*/src/`) must never
hardcode a concrete plugin ID or name.** Violations: `pluginId === 'narrator'`,
`store.listPluginData(sessionId, 'world-init', ...)`, `p.id === 'image'`.

- Dispatch on `RuntimeManifest.outputKind` (`story` / `plugin` / `system`); discover
  through `RuntimeManifest.capabilities` (e.g. `narrative`, `world-data-provider`,
  `image-generation`); gate core vs third-party on `pluginType`.
- Test files may use real plugin IDs as fixtures.
- UI curation data may list plugin IDs as _data_ (e.g. the plugin packs in
  `apps/web/src/lib/session-plugin-selection.ts`). The rule bans branching on a
  plugin ID in dispatch or control flow, not user-overridable selection lists.

The framework never auto-creates `CharacterRecord`s from forms. Player creation is
plugin-owned: the character plugin's setup guard reads the submitted opening form
and synthesises the player deterministically through the character proposal/tool
surface.

### Identity model: pluginId vs runtimeId

`RuntimeManifest.pluginId` is the package ID (e.g. `world-init`, the `name` prefix
before `/`) and keys data isolation, tool scoping, trust, and every store write.
`RuntimeManifest.name` is the runtimeId (e.g. `world-init/schema-gen`) and keys LLM
traces and logs.

### Tool scoping

`bootstrap/plugin-tool-access.ts` builds `Map<pluginId, Set<toolName>>`, and
`findTool(name, context)` in `bootstrap/tools.ts` fails closed (no `context` → no
local tool). Builtin tools are available to all plugins; local tools only to the
declaring plugin.

### Current contract only

During early development, target the current contract only. Update producers,
consumers, schemas, fixtures, and documentation together; do not add old-version
migrations, dual reads/writes, aliases, or fallback branches solely to preserve
development data. Document when affected development data must be recreated. Keep
required runtime concurrency, failure handling, and supported backend differences —
those are not version compatibility.

### Plugin authoring contract

- Depend only on the public plugin API (manifest, runtime, tool, hook, UI slot,
  provider binding, proposal) — never on DB tables, ORM models, kernel internals,
  or frontend components.
- All writes go through proposals; tools have Zod schemas; high-risk tools declare
  `permissions`. Hooks guard, rewrite, or audit — they carry no gameplay logic.
- Providers only through bindings: image generation uses `ctx.images` /
  `ctx.gateway.generateImage`, never a hand-rolled provider fetch.
- Declare `outputKind` and `capabilities`. Optional limits: `timeoutMs`,
  `maxRetries` (default 1), `callTimeoutMs`, `firstTokenTimeoutMs` (default 30s),
  `loopDetectionThreshold` (default 3).

### Locale

A session's content locale is fixed when the session is created
(`SessionRecord.locale`, default `zh-CN`). Every turn, manual runtime, and
background job passes it as `KernelInput.locale` → `RuntimeContextView.locale`; an
action request carries no locale and cannot change it. The UI language only
selects labels. Manifest display fields use
`I18nText = string | Record<string, string>`.

Prompt bodies are instructions, not content. The canonical `PLUGIN.md` /
`RUNTIME.md` body is English; `*.zh.md` is the only variant and is read when the
session locale is Simplified Chinese. Every other locale reads the English body.
The framework's own instruction lines follow the same rule
(`instructionLocaleFor` in `@covel/shared`).
`COVEL_INSTRUCTION_LOCALE` (`en` / `zh`) fixes the instruction language for all
sessions. Rules: `docs/reference/i18n.md`.

### Documentation sync

A change to framework-visible surface area must update the matching doc in the same
PR; a missing sync means an incomplete PR.

- Add/modify/remove a plugin → `docs/reference/plugins.md`
- Add/modify/remove a tool; approval/source gate → `docs/reference/tools.md`
- Add/change a model slot → `docs/reference/slots.md`
- Change SSE events / protocol → `docs/reference/protocol.md`
- Change right-panel tabs / data sources → `docs/reference/ui-panels.md`
- Add/change an API endpoint → `docs/reference/api.md`
- Change package structure, deps, root scripts → `AGENTS.md` (Commands, Monorepo Structure)
- Change CI workflows or git hooks → `docs/CONTRIBUTING.md` + `docs/CONTRIBUTING.en.md`
- Add/change PLUGIN.md frontmatter → `docs/reference/plugins.md` + `docs/guide/plugin-authoring.md`
- Add/change `PLUGIN.md dataSchemas` → `docs/reference/plugins.md` + `docs/guide/plugin-authoring*.md` + `docs/reference/world-data.md`
- Add/change world package `worldData` → `docs/reference/world-data.md` + relevant guides
- Add/change world-data import/sync rules → `docs/reference/world-data.md` + `docs/reference/api.md` + `docs/reference/transactions.md`
- Add/change an RPC action / framework default → `docs/reference/api.md` (plugin-rpc) + `docs/reference/protocol.md`
- Add/change approval flow / trust level → `docs/reference/api.md` + `docs/reference/protocol.md`
- Change a security boundary → `docs/architecture/security.md`
- Modify `README.md` or `README.zh-CN.md` → the other README, in the same PR

## State & Persistence

Core objects stay separate — never collapse them into one JSON blob: **Run,
Branch, Snapshot, State, Event, Record, Character, PluginData**.

- `STORE_BACKEND=memory|sqlite|pg` (default `sqlite`; `pg` requires `DATABASE_URL`)
  selects `MemoryStore`, `SqliteStore`, or `PgStore`. Browser `local` mode persists
  checkpoints in the Dexie `BrowserVault` and hydrates an ephemeral MemoryStore; it
  is not a DataStore backend. Contract: `docs/architecture/storage.md`.
- Each SQL backend keeps a thin `*-store.ts` factory plus focused modules: schema
  and DDL, mappers/values, and per-surface CRUD/runtime/session/snapshot/state/world
  files. Tables are defined in `packages/store/src/{sqlite,postgres}/schema.ts`.
- `sessions.runtime_model_overrides` maps `runtimeId → slot`; a request-scoped
  `modelOverride` wins for `story` runtimes, then `manifest.model`, then the gateway
  default.
- `turn_results.commit_status` stays `pending` until the commit owner settles it to
  `committed` / `failed`; a lingering `pending` row is a crash signature.
- **JSONB writes**: use `sql.json(value as JSONValue)`, never `JSON.stringify()`
  (double serialisation).

## Security

Summary only; the boundaries and their reasons are in `docs/architecture/security.md`.

- The outbound SSRF guard is open by default (any public `https` host, no allowlist
  env) and pins DNS. Plugin `fetchWithRetry` always stays on the strict direct path.
- Server/platform keys attach only when the target origin matches trusted config;
  request keys arrive in `X-Provider-Keys` and are never persisted.
- `demo` / `commercial` tiers enforce per-session owner tokens and the operator
  token (`COVEL_DESKTOP_REST_TOKEN`); `self` / desktop binds `127.0.0.1` and treats
  tokens as no-ops. Deployment tiers: T1 self-deploy, T2 demo host, T3 commercial.

## Observability

Trace chain: `traceId → runId → branchId → turnId → runtimeId → pluginId`. Runtime
traces live in the DB `trace_events` table (served by `/api/traces/*` and the
frontend `/debug` page); infrastructure logs go to the console with `[component]`
prefixes.

## Testing

- Vitest is the only runner (`*.test.ts` / `*.test.tsx`); Playwright specs are
  `*.spec.ts` under `tests/e2e/`. Add focused regression tests for features and
  fixes. The ≥80% coverage goal (`pnpm test:coverage`) is not enforced in CI.
- Every `DataStore` backend must pass the shared contract suite
  (`store-contract.ts` + `contract/suites/`).
- Plugin tests use `@covel/plugin-test-utils` (`MockLLM`,
  `makeManualFunctionContext`, `makeTurnInput`, …); see `docs/guide/plugin-testing.md`.
- Web tests default to jsdom. A test file that needs no DOM may opt into
  `// @vitest-environment node`, which is noticeably faster.
- IndexedDB tests use `fake-indexeddb`; PostgreSQL tests need a real database
  (`pnpm db:up`, then `pnpm test:pg`).

## Commits & Pull Requests

Use Conventional Commits (`fix(web): stabilize session restore`; types `feat`,
`fix`, `refactor`, `docs`, `test`, `chore`, `ci`). Branch from and target `main`;
never commit directly on `main`. Complete the PR template (rationale, verification,
related context, documentation updates). Mark breaking changes with a
`BREAKING CHANGE:` footer.

## Agent Skills

Project skills live in `.claude/skills/` (`create-plugin`, `create-world`,
`covel-static-turn-audit`); see `docs/guide/skills.md`. Directory-specific rules
live in nested `AGENTS.md` files (e.g. `docs/v2/AGENTS.md`).

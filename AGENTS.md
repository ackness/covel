# AGENTS.md

Shared instructions for every coding agent in this repository. Codex reads this
file directly; Claude Code loads it through `CLAUDE.md`. Keep agent rules here
so the two never drift.

## Project Overview

Covel is a plugin-based AI RPG framework and playable studio (pnpm/Turborepo
TypeScript modular monolith, early access — the version lives in the root
`package.json`). **The kernel provides primitives and orchestration; plugins
carry gameplay logic; world packs carry setting content.** A plugin package
declares versioned contracts and contributions in its root `PLUGIN.md` and runs
zero or more runtimes; the kernel resolves each session's plugin set, routes
turns, assembles context, drives LLM tool calls, and commits proposals. It ships
as Web or Electron desktop (`pnpm build:electron`).

## Documentation

`docs/` is the source of truth; this file only points at it. Consult the matching
page before any non-trivial change. When a page disagrees with code or tests, the
code is the current fact — fix the page in the same change. `docs/README.md` has a
Search Map from common questions to code paths, and `docs/glossary.md` arbitrates
terminology.

Architecture (`docs/architecture/`) — why, and how modules connect:

- Turn pipeline, background jobs, end-to-end data flow: `flow.md`
- Kernel vs plugin rulings: `design-principles.md`
- Package responsibilities and host composition: `packages.md`
- Storage profiles and contracts: `storage.md`
- Security boundaries (SSRF/DNS pinning, key binding, hosted auth): `security.md`
- Deliberate limits and their upgrade triggers: `technical-debt.md`

Reference (`docs/reference/`) — authoritative contracts:

- Plugin manifest, runtime fields, session plugin selection: `plugins.md`
- Extension points and plugin-to-plugin communication: `extension-points.md`, `plugin-extensions.md`
- Tools and approval policy: `tools.md`
- HTTP API: `api.md`; SSE protocol and transport: `protocol.md`
- World Model, world data, dimensions, world time: `world-model.md`, `world-data.md`, `dynamic-dimensions.md`, `world-time.md`
- Plugin and world catalogues, install, update: `plugin-installation.md`, `world-installation.md`
- Prompt assembly: `prompt-structure.md`; DataStore transactions: `transactions.md`
- Model slots, evaluation models, image generation, media store: `slots.md`, `evaluation.md`, `image-generation.md`, `media-store.md`
- Right-panel tabs and json-render UI: `ui-panels.md`, `ui-components.md`
- i18n, settings store, theme packages: `i18n.md`, `settings-store.md`, `theme-packages.md`

Guides (`docs/guide/`) — task walkthroughs:

- Plugin authoring: `plugin-authoring.md` (start here; `-zero-code`, `-agent`, `-advanced` variants), `plugin-ui-runtime-guidelines.md`, `plugin-testing.md`
- Shipping worlds with their plugins: `collections.md`
- World art: `world-art-direction.md`, `world-portraits.md`, `world-scenes.md`
- Testing: `e2e-testing.md` (Playwright and the pre-release playthrough), `e2e-plugin-verify.md` (real-LLM harness)
- How to write a prompt body (contract zone, voice zone, vocabulary): `prompt-style.md`
- Environment variables: `env-registry.md`
- Desktop config and packaging: `desktop-config.md`, `desktop-packaging.md`
- Themes: `themes.md`; agent skills: `skills.md`

Also: `README.md` / `docs/README.md` (intro, quick start), `docs/CONTRIBUTING.md`
(contributing, CI, release), `docs/CHANGELOG.md`, `docs/DOCS_STRATEGY.md`
(information architecture), and `docs/v2/` (the reading-path rewrite in progress;
it has its own `AGENTS.md`).

Keep durable user/developer documentation (guides, contracts, architecture) in
`docs/`. Put task plans, audits, implementation logs, temporary analysis, and
handoff notes under the gitignored `devs/docs/`. Do not create top-level `audits/`,
`plans/`, `context.md`, or `progress.md` artifacts. Debug artefacts (screenshots,
logs, dumps) go under the gitignored `debugs/`, never the repo root.

`docs/` holds no plans: once a plan is implemented, move its stable conclusions
into the matching page and delete the plan. A new page must be reachable from
`docs/README.md` or its directory's `README.md`, and a renamed heading must keep
its inbound `#anchor` links working. `docs/architecture/technical-debt.md` mirrors
the `ponytail:` markers in source — update it when adding or removing one.

## Commands

Toolchain versions come from `mise.toml` (Node 26, pnpm 12.6.0, actionlint).

```bash
pnpm install --frozen-lockfile  # also builds @covel/plugin-handlers-utils (prepare)
pnpm dev              # web (5173) + server (3001), SqliteStore (./data/covel.db)
                      # server watches plugins/**/*.{md,js,json,yaml}; editing a PLUGIN.md, handler or locale file restarts it
                      # at every start the server builds @covel/plugin-handlers-utils when its build is older than its source
pnpm dev:web          # web only
pnpm dev:server       # server only (STORE_BACKEND=memory for ephemeral)
pnpm dev:pg           # STORE_BACKEND=pg with db preflight; run `pnpm db:up` first
pnpm dev:electron     # desktop shell in development
pnpm stop             # kill stray dev/turbo processes
pnpm check            # the CI static gate: peers, lint, package boundaries, deps:check,
                      # plugin manifests, schema reference, prompt variants, i18n, script regressions, actionlint
pnpm lint             # tsc --noEmit for the FULL workspace (not one package)
pnpm test             # all Vitest suites; one package: pnpm --filter @covel/runtime test
pnpm test:pg          # required PostgreSQL integration tests (DATABASE_URL from env or .env)
pnpm e2e:smoke        # deterministic Chromium smoke suite run by CI; pnpm e2e for all Playwright
pnpm e2e:extensions   # Playwright acceptance for a community plugin in an isolated home
pnpm e2e:verify       # API-driven real-LLM plugin harness against a running server (its keys come from .env.llm
                      # or the environment); uses the configured models, --slot overrides the story slot
pnpm llm:replay       # record-and-replay proxy in front of a model endpoint, for repeating a scripted
                      # session without model calls: pnpm llm:replay --mode record --upstream <origin>
                      # --fixtures <dir>, then --mode replay --fixtures <dir>; pnpm llm:replay:diff
                      # <a.requests> <b.requests> shows where two runs differ (docs/guide/e2e-plugin-verify.md)
pnpm test:runtime     # standalone runtime harness CLI (packages/test-runtime)
pnpm create-plugin    # scaffold from templates/: pnpm create-plugin <name> [-t dir] [-r a:function,b:agent]
                      # default target is the user plugin dir; --with-tools scaffolds into plugins/
pnpm schemas:generate # regenerate packages/shared/schemas/*.json and docs/reference/schema/*.md
                      # from the Zod schemas; run after changing an author-facing schema field
pnpm describe:authoring  # what a world may contain for the scanned plugins: files, data contracts
                      # with the path each file goes to and an example, plugin IDs and settings
                      # (--json, --check validates plugin examples, --plugins <dir>)
pnpm validate:plugin  # validate PLUGIN.md / RUNTIME.md and locale files; a plugin DIR also gets
                      # cross-runtime checks, a check that PLUGIN.md and package.json state one
                      # version, and a line with the languages it has text in
pnpm validate:world   # validate world packages (manifest, lore, plugin IDs, every seed record):
                      # pnpm validate:world [--strict] [--plugins <dir>] worlds/<id>
pnpm validate:collection  # static check of a covel-collection.yaml directory (docs/guide/collections.md)
pnpm create-collection    # scaffold a collection: pnpm create-collection <id> [dir]
pnpm pack:collection      # zip a collection for offline import: pnpm pack:collection <dir> [out.zip]
pnpm test:plugin-lifecycle  # install, authorize, run, and remove a community ZIP through the real API
pnpm test:tabletop-plugin   # the same for tabletop-rules packed under a different plugin ID
pnpm pack:test-plugin       # write the ZIPs those tests use to test-results/ (also pack:tabletop-plugin)
pnpm check:i18n       # web + plugin i18n coverage + plugin READMEs; tool definitions are English;
                      # Chinese text in framework source only in recorded files; every label and
                      # text of a bundled plugin has a current Chinese translation
pnpm i18n             # translation tooling for a plugin or world directory: status, extract,
                      # translate (configured model; --to <dir> keeps a plugin's translation
                      # outside its package), lock (docs/reference/i18n.md)
pnpm check:prompts    # plugin and template prompts are English; each *.zh.md variant matches its English prompt
                      # (pnpm prompts:lock records a pair after both languages changed); it also prints
                      # style and structure warnings, which do not fail it (docs/guide/prompt-style.md)
pnpm check:boundaries # workspace public entry points, declared deps, package direction
pnpm deps:check       # Fallow: unused/unlisted deps and unresolved imports (.fallowrc.jsonc)
pnpm analyze          # Fallow report: dead code, duplication, complexity; exits non-zero
                      # while findings remain, so it is a report, not a gate
pnpm format           # Prettier
pnpm build            # all Turbo build targets
pnpm build:electron   # production desktop installer → release/
pnpm release:preflight  # static pre-tag gate: lockfile, imports, plugin/world/prompt structure
```

Before pushing, run `pnpm check` and `pnpm test` — `pnpm lint` alone misses the
dependency, manifest, i18n, and workflow gates. Add `pnpm test:pg` for store or
database changes and `pnpm e2e:smoke` / `pnpm e2e` for UI flows.

Every command in the block above is expected to run as written. A command shown
in `docs/`, a template, or a skill must be one that actually runs: when a root
script, its arguments, or a scaffold's output changes, re-run the documented
sequence and fix every page that shows it.

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

Every variable is declared in `packages/shared/src/env/registry.ts` and documented
in `docs/guide/env-registry.md`.

Desktop files live under `<covelHome>/` (typically `~/.covel/`): `config.toml`
(paths, logs, proxy), `llm.toml` (hot-reloaded from Settings), `keys.env` (mode
600), and `settings.json` (front-end preferences through the `@covel/settings`
SettingsStore, mirrored to `localStorage` `covel:settings` on web). Provider keys
also flow through the SettingsStore (`keys.env` on desktop, `localStorage`
`covel:keys` on web); the server never persists them — each AI request passes
them in the `X-Provider-Keys` header (base64).

Installed and AI-generated worlds and plugins land outside the repo, in
`COVEL_USER_WORLDS_DIR` / `COVEL_USER_PLUGINS_DIR` (default `$COVEL_HOME/worlds`
and `$COVEL_HOME/plugins`). `COVEL_WORLDS_DIR` / `COVEL_PLUGINS_DIR` point at the
bundled `worlds/` and `plugins/`.

## Monorepo Structure

- `apps/web` (React/Vite client), `apps/server` (Hono API; composes every feature
  package), `apps/desktop` (Electron shell).
  The desktop shell validates persisted window geometry with its direct Zod dependency.
- `packages/` — framework libraries; responsibilities and consumers are in
  `docs/architecture/packages.md`:
  - `plugin-handlers-utils` — the public plugin-author SDK (`PluginAPI`, handler,
    proposal, and tool-result contracts; `/dimensions` serves dimension
    providers and `/prompts` loads plugin-owned templates in Node)
  - `shared` — domain types, Zod schemas, extension-point contracts, env registry
  - `plugin-loader` — discovers, validates, and compiles plugin packages
  - `runtime` — the kernel: scheduling, execution, suspend/resume, commit, hooks
  - `tools` — host-side tool registry, executor, and builtin tools
  - `approval` — static tool-source policy and the interactive plugin-RPC gate
  - `context` — prompt, history, and token-budget assembly; prompt loader
  - `events` — event bus, replay, transports
  - `store` — `DataStore` contract and backends, `MediaStore`, browser sync
  - `memory` — recall, archival, keyword and vector retrieval
  - `ai-provider` — model resolution, provider protocols, media wires, model table
  - `create` — LLM world generation; `settings` — SettingsStore and its backends
  - `plugin-test-utils`, `test-runtime` — plugin test helpers and the runtime harness CLI
- `plugins/` — bundled plugin packages (registry: `docs/reference/plugins.md`).
  `worlds/` — bundled world packs (`world.yaml`, `WORLD.md`, optional `data/`,
  `characters/`, `media/`). `_archive/` under either holds retired packages and is
  not loaded.
- `packs/builtin.yaml` — plugin packs (named `requested` / `recommended` sets a
  player picks on the session-prep screen).
- `prompts/server/` — framework prompt templates; `docker/` — Compose stack and
  image.
- `templates/` — scaffolds for `pnpm create-plugin`: `plugin-multi-runtime` (the
  default; a standalone package with no dependencies and no install step) and
  `plugin-with-tools` (`--with-tools`; a workspace member under `plugins/` named
  `@covel/plugin-<name>` with `pnpm lint` / `pnpm test`).
  `packages/test-runtime/src/scaffold.test.ts` generates and runs every mode.
- `tests/e2e/` — Playwright specs; `tests/third-party/` — installable probe
  plugins used as community-package fixtures.
- `scripts/` — dev, check, and release tooling. `scripts/tests/*.test.mjs` run
  under `node --test` through `pnpm check`.

Each `plugins/<id>/` needs a root `PLUGIN.md` (plain YAML frontmatter; `id` equals
the directory name), `package.json`, and `README.md`. Optional: `server/` (the
`entry` module), `runtimes/<id>/RUNTIME.md` with its handler and guard, `schemas/`,
`tools/`, `hooks/`, `ui/`, `lib/`, `tests/`, `PLUGIN.zh.md` / `RUNTIME.zh.md` (the
Simplified Chinese prompt body), and `locales/<locale>.yaml` (translations of
labels, UI text and text in code; the main files are English; `locales/lock.json`
records the English text each label translation is for).

ESM-only, TypeScript strict, ES2022, NodeNext — **use `.js` extensions in TS
relative imports**. Workspace packages export TS source directly
(`"import": "./src/index.ts"`) with no build step for dev. The one exception is
`@covel/plugin-handlers-utils`, which is consumed from `dist/` because it is built
as the standalone author SDK: `pnpm install` and Turbo's `^build` edge rebuild it,
and so does the dev server at every start of its process when the build is older
than the source (`scripts/ensure-plugin-sdk.mjs`, preloaded by the server's `dev`
scripts; a change to the SDK source restarts the server). After editing its
source a direct `pnpm --filter <pkg> test` still needs
`pnpm --filter @covel/plugin-handlers-utils build` first. It is not on npm, so
nothing outside this workspace can depend on it by version — a standalone plugin
ships self-contained and bundles the helpers it uses.

`plugin-handlers-utils` is the root of the dependency graph and depends on no
workspace package; `shared` sits directly above it, and `@covel/server` composes
every feature package. `@covel/settings` is split from `shared` so pure-type
consumers avoid browser/Electron code. Exact edges live in each `package.json`;
`pnpm check:boundaries` enforces public entry points and package direction.

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
Input/Event → settle barrier → freeze registry generation → Trigger Router
→ Stage Scheduler → [per stage, per DAG level:]
  gate (needs / inputs / permissions) → guard → buildContext → Runtime Runner
  → Tool/Hook Loop → RuntimeResult { output, effects, completion }
→ Proposals → Validation/Policy → commitExecution → SSE / Side Effects
→ Follow-up Events (may re-enter Router) and detached background jobs
```

- **Plugin package**: the root `PLUGIN.md` declares `id`, `kind` (`core` /
  `plugin`), versioned contracts (`provides` / `requires` / `optional` /
  `conflicts`, IDs such as `narrative-engine@1`), an optional `entry` module, and
  package-level `contributes` (tools, actions, services, extensions, hooks,
  settings, data, ui, prompt, …). `entry` registrations and `contributes` must match
  in both directions or the load fails. The loader compiles this authored format
  into the internal `RuntimeManifest`; the two are not interchangeable.
- **Runtimes**: one inline `runtime` in the root file, or `runtimes/<id>/RUNTIME.md`
  files — never both, and a package with only entry/UI/extensions may have none.
  `type` is `agent` (the file body is the system prompt; the LLM drives tool calls)
  or `function` (a pure JS handler); the other fields are grouped under `schedule`,
  `io`, `agent`, `function`, `guard`, `effects`, `permissions`.
- **Trigger modes** are the closed enum `auto` / `manual` / `scheduled` / `event`
  (`TriggerType` in `packages/shared/src/types/plugin.ts`); other values are rejected
  at load. `shouldTrigger` (`packages/runtime/src/trigger/trigger.ts`) is the single
  authority for `auto` / `scheduled` / `event`, including the in-turn event fan-out.
  **`manual` is the exception**: `selectTriggeredRuntimes` selects it by name match
  without calling `shouldTrigger` — an explicit plugin-rpc call is the trigger
  decision, so it bypasses `phase` / `startTurn` / `maxTriggerCount` / `cooldownTurns`
  (the `manual` branch in `shouldTrigger` serves only direct callers).
- **Scheduling** is declared, never numeric: `schedule.stage` plus typed edges —
  `schedule.needs` (success gate + same-pass DAG edge), `schedule.after` (ordering
  only), and `io.inputs` bindings (`required: true` implies `needs`). `auto` /
  `scheduled` runtimes declare a stage; `event` / `manual` runtimes declare none.
  Runtime-ID references stay inside one package; cross-package edges use a
  versioned contract (`from: { contract }`) listed in the root `requires` /
  `optional`. Intra-stage order comes only from declared edges, independent
  runtimes run in parallel, and `name` breaks ties.
- **Stage bands**: `setup` runs while `phase === "setup"`; the main loop runs
  `pre-turn → narrative → post-turn → audit` with a barrier between stages (each
  stage fully settles before the next).
- **Results**: `RuntimeResult` keeps `output`, `effects`, and `completion` apart; a
  function handler returns them as `HandlerResult`, and an effect-shaped field
  inside `value` does nothing. Setup runtimes finish with `completion: "done"`
  (agents report `preGameDone: true`). Setup completion is recorded per plugin
  `version`, so a version bump re-runs setup — setup guards must return
  `{ skip: true }` for work already done.
- **Background execution**: `schedule.completion.mode: detached` moves a safe
  post-turn / audit function leaf to the durable `_runtime_jobs` queue;
  `schedule.completion.settle: before-next-execution` makes the next execution wait
  for it; `schedule.manual.execution: background` backgrounds a manual run.
- **Session clock** (`Session` in `packages/shared/src/types/session.ts`): `status`
  (`active` / `paused` / `ended`), `phase` (`setup` / `playing`),
  `completedPlayerTurns` (only committed player executions count — setup and the
  opening continuation do not, so the opening shares `logicalTurn = 1` with the
  first message; manual, background, and recursive executions persist their own
  `turn_results` row with `origin` and are excluded), and `setupRuntimes`
  (per-runtime `pending` / `done{completed|waived}` / `blocked`). These are
  current-only: builds do not accept or reconstruct deprecated clock fields.
- **Proposals**: `ProposalPayloadMap` in `packages/shared/src/types/proposal.ts` is
  the single source of truth for proposal types (list in `docs/reference/tools.md`).
  **All writes flow through validate → commit; plugins never touch the DB directly.**
  A successful tool call does not mean its proposals are persisted.
- **Hooks**: lifecycle events are enumerated once in `HOOK_EVENTS`
  (`packages/shared/src/types/hooks.ts`). A package declares them in
  `contributes.hooks` and registers handlers with `covel.on()` in `entry`. Hooks are
  session-scoped through `AsyncLocalStorage`; `ctx.getOwnSettings()` exposes the
  plugin's own resolved settings.
- **Session plugin set**: a global pool loads at startup; `resolveSessionPlugins`
  (`packages/shared/src/plugin-selection.ts`) computes each session's active set from
  the explicit `requested` / `excluded` lists, authorization, and contract
  declarations (`Session.activePlugins`; changes apply next turn). A world's
  `pluginPolicy` and the packs seed the request. Source comes from the discovery
  directory: `builtin` auto-loads; `community` — any installed package, official
  ones included — runs server code only after the player approves it.
- **Plugin communication** (`docs/reference/plugin-extensions.md`): same-execution
  results through `io.inputs`; committed results through `io.output.recordAs` +
  `scope: committed`; events through `effects` or the `emit-event` tool plus an
  `event` trigger; request/response through `covel.registerService` +
  `ctx.services`; kernel extension points (`single` / `collect` / `pipeline`)
  through `covel.provideExtension`.
- **Data ownership**: plugin data is session-scoped KV keyed by
  `(sessionId, pluginId, namespace, key)`; `io.selfData` inlines a runtime's own
  namespace into its prompt, and the `_` namespace prefix is reserved for the
  kernel. Characters, character schema, lorebook, dimensions, and the world record
  form the kernel-owned World Model: read-only through `ctx.world`, written through
  proposals.
- **Plugin UI** is declarative: `contributes.ui` lists json-render specs for
  `right` / `message` / `left`, `ui.slot@1` extensions fill kernel slots, and custom
  HTML runs in a sandboxed webview. `GET /api/ui-specs` aggregates the specs and
  `plugin-data.changed` SSE events drive re-renders.
- **Model slots**: named `[covel.<slot>]` routes (`story`, `utility`, `plugin`,
  `fast`, `memory`, `image`, …) with same-tag fallback only — an image request
  never routes to text. Media generation goes through `ctx.images` / `ctx.speech`
  / `ctx.music` and per-modality wire registries (music has no built-in wire). Details: `docs/reference/slots.md`,
  `docs/reference/media-store.md`.

## Critical Conventions

### Framework ↔ Plugin Isolation Rule

**Framework code (`packages/`, `apps/server/src/`, `apps/web/src/`) must never
hardcode a concrete plugin ID or name.** Violations: `pluginId === 'narrator'`,
`store.listPluginData(sessionId, 'world-init', ...)`, `p.id === 'image'`. Deleting
any plugin must not break the framework.

- Discover providers through versioned contracts (`provides` / `requires`, the
  compiled `outputContract`), kernel extension points, and registered services —
  never by scanning for an ID or another plugin's namespace. World data follows the
  same route: a source targets `contract:<id>` and the kernel delivers it to active
  namespaces that declare `contributes.data.*.accepts`.
- Dispatch on `RuntimeManifest.outputKind` (`story` / `plugin` / `system`, authored
  as `io.visibility`); gate core vs optional on `kind` / `pluginType` and trust on
  source (`builtin` / `community`).
- When a legitimate scenario cannot be expressed, add a generic primitive (a
  proposal type, hook event, extension point, or trigger), not a special case.
- Test files may use real plugin IDs as fixtures.
- Curation data may list plugin IDs as _data_ (`packs/builtin.yaml`, a world's
  `pluginPolicy`). The rule bans branching on a plugin ID in dispatch or control
  flow, not user-overridable selection lists.

The framework never auto-creates `CharacterRecord`s from forms. Player creation is
plugin-owned: the character plugin's setup guard reads the submitted opening form
and synthesises the player deterministically through the character proposal/tool
surface.

### Identity model: pluginId vs runtimeId

`RuntimeManifest.pluginId` is the package ID (e.g. `world-init`, the root
`PLUGIN.md` `id`) and keys data isolation, tool scoping, trust, and every store
write. `RuntimeManifest.name` is the runtimeId — the package ID for an inline
runtime, `<pluginId>/<id>` for `runtimes/<id>/` (e.g. `world-init/schema-gen`) —
and keys scheduling edges, LLM traces, and logs.

### Tool scoping

Plugin tools are registered in `entry` with `covel.registerTool()` and listed in
`contributes.tools`; names are unique per plugin, so two plugins may reuse a name.
`ToolRegistry.find(name, pluginId)` (`packages/tools/src/registry.ts`) resolves
builtin tools first, then only the calling plugin's own tools — there is no
cross-plugin tool lookup (use a service). An agent sees only the tools whitelisted
in `agent.tools`; a function runtime calls only `function.tools` through
`ctx.tools.call`.

### Current contract only

During early development, target the current contract only. Update producers,
consumers, schemas, fixtures, and documentation together; do not add old-version
migrations, dual reads/writes, aliases, or fallback branches solely to preserve
development data. A breaking contract change takes a new contract ID (`@2`) with
providers and consumers upgraded in the same change. Document when affected
development data must be recreated. Keep required runtime concurrency, failure
handling, and supported backend differences — those are not version compatibility.

### Plugin authoring contract

- Depend only on the public plugin API from `@covel/plugin-handlers-utils`
  (manifest, runtime, tool, hook, UI slot, service, extension, proposal) — never on
  `@covel/runtime` / `shared` / `store` internals, DB tables, ORM models, or
  frontend components.
- All writes go through proposals (tool results, handler `effects`,
  `ctx.pluginData`); tools have Zod schemas; high-risk runtimes declare
  `permissions` and `effects`. Hooks guard, rewrite, or audit — they carry no
  gameplay logic.
- Providers only through bindings: image generation uses `ctx.images` /
  `ctx.gateway.generateImage`, never a hand-rolled provider fetch.
- Dice and other game randomness come from `ctx.random` (and `shortId`'s fourth
  argument), never from `node:crypto` or `Math.random`: a test server started
  with `COVEL_RANDOM_SEED` then repeats them.
- A model reads no bookkeeping: no session ID, no UUID of a row, turn or result,
  no timestamp. The kernel leaves them out of what it renders (`io.selfData`
  lines, `<runtime-inputs>`, JSON tool results); text a plugin builds itself goes
  through `modelFacingJson`. Name a turn by its number.
- Declare `io.visibility` and the contracts a runtime provides or consumes. Agent
  limits live in `agent.loop`: `timeoutMs`, `callTimeoutMs` (a call that is not
  streamed), `maxRetries` (default 1), `firstTokenTimeoutMs` and `idleTimeoutMs`
  (a streamed call; default 120s each), `loopDetection` (default 3); a function's
  limit is `function.timeoutMs`.
- `pnpm validate:plugin plugins/<id>` is static and never executes `entry`; real
  registration of bundled plugins is asserted by
  `apps/server/tests/bootstrap/builtin-plugin-entries.test.ts`.

### Locale

A session's content locale is fixed when the session is created
(`SessionRecord.locale`, default `zh-CN`), and it is always an edition the world
has (`sessionContentLocale` in `@covel/shared`). Every turn, manual runtime, and
background job passes it as `KernelInput.locale` → `RuntimeContextView.locale`; an
action request carries no locale and cannot change it. The UI language only
selects labels. Display fields use `I18nText = string | Record<string, string>`
and must be resolved with `resolveI18nText(value, locale)` from `@covel/shared` —
never with ad-hoc `startsWith("en")` checks. Authored files hold one language:
a main file is written in its language, and `<name>.<locale>.<ext>` (worlds) or
`locales/<locale>.yaml` (plugins) holds only the translated text.

All framework LLM prompts are externalized as locale-aware markdown files under
`prompts/`, resolved as exact locale → language → registry fallback (English) →
locale-less default, otherwise an error.

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

- Add/modify/remove a bundled plugin; change `PLUGIN.md` / `RUNTIME.md` fields → `docs/reference/plugins.md` + `docs/guide/plugin-authoring*.md`
- Add/change an extension point, service contract, or plugin API method → `docs/reference/extension-points.md` + `docs/reference/plugin-extensions.md`
- Add/modify/remove a tool; approval/source gate → `docs/reference/tools.md`
- Add/change a model slot → `docs/reference/slots.md`
- Change SSE events / protocol → `docs/reference/protocol.md`
- Change right-panel tabs / data sources / UI slots → `docs/reference/ui-panels.md`
- Add/change an API endpoint → `docs/reference/api.md`
- Add/change `contributes.data` or a data contract → `docs/reference/plugins.md` + `docs/reference/world-data.md`
- Add/change world package `worldData`, import/sync rules → `docs/reference/world-data.md` + `docs/reference/api.md` + `docs/reference/transactions.md`
- Change the World Model (characters, dimensions, lorebook) → `docs/reference/world-model.md`
- Change plugin/world install, update, or collections → `docs/reference/plugin-installation.md` / `world-installation.md` + `docs/guide/collections.md`
- Add/change an RPC action / framework default → `docs/reference/api.md` (plugin-rpc) + `docs/reference/protocol.md`
- Add/change approval flow / trust level → `docs/reference/api.md` + `docs/reference/protocol.md`
- Add/change an environment variable → `packages/shared/src/env/registry.ts` + `docs/guide/env-registry.md`
- Change a security boundary → `docs/architecture/security.md`
- Change package structure, deps, root scripts → `AGENTS.md` (Commands, Monorepo Structure) + `docs/architecture/packages.md` + every page that shows the command
- Change the plugin scaffold (`scripts/create-plugin.js`, `templates/`) → the template READMEs + `docs/guide/plugin-authoring.md` + `docs/guide/plugin-testing.md` + `.claude/skills/create-plugin/`
- Change CI workflows, git hooks, or the pre-push verification steps → `docs/CONTRIBUTING.md` + `docs/CONTRIBUTING.en.md` + `.github/PULL_REQUEST_TEMPLATE.md`
- Introduce or rename a term → `docs/glossary.md`
- Any user-visible change → an entry under `[Unreleased]` in `docs/CHANGELOG.md`
- Edit a page that has an `.en.md` sibling, or `README.md` / `README.zh-CN.md` → update both in the same PR

## State & Persistence

Core objects stay separate — never collapse them into one JSON blob: **Run,
Branch, Snapshot, State, Event, Record, Character, PluginData**.

- `STORE_BACKEND=memory|sqlite|pg` (default `sqlite`; `pg` requires `DATABASE_URL`)
  selects the server `DataStore`: `MemoryStore`, `SqliteStore`, or `PgStore`. The
  browser-private profile persists checkpoints in the Dexie `BrowserVault` and
  hydrates an ephemeral `MemoryStore`; it is not a `DataStore` backend. Contract:
  `docs/architecture/storage.md`.
- Each SQL backend keeps a thin `*-store.ts` factory plus focused modules: schema
  and DDL, mappers/values, and per-surface CRUD/runtime/session/snapshot/state/world
  files. Tables are defined in `packages/store/src/{sqlite,postgres}/schema.ts`.
- `sessions.runtime_model_overrides` stores only `runtimeId → slot` names. An
  explicit runtime selection (this map included) wins, then the request's UI slot
  binding, then the plugin's own preference, then the `llm.toml` default; a
  request-scoped `modelOverride` applies to `story` runtimes only. Full chain:
  `docs/reference/slots.md`.
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
- `DEPLOYMENT_TIER` `demo` / `commercial` enforce per-session owner tokens and the
  operator token (`COVEL_DESKTOP_REST_TOKEN`); `self` / desktop binds `127.0.0.1`
  and treats tokens as no-ops.
- Plugin server JavaScript is not sandboxed. Community code runs only after player
  approval, with its declared `permissions.http` origins enforced fail-closed.
  Manifests are plain YAML — frontmatter engine directives such as `---js` are
  rejected before parsing.

## Observability

Trace chain: `traceId → runId → branchId → turnId → runtimeId → pluginId`. Runtime
traces live in the DB `trace_events` table (served by `/api/traces/*` and the
frontend `/debug` page); infrastructure logs go to the console with `[component]`
prefixes. A runtime declaring `io.concealed: true` has its prompts, replies, tool
arguments, and outputs stripped from traces and the live stream.

## Testing

- Vitest runs every package, the server, and web (`*.test.ts` / `*.test.tsx`);
  `apps/desktop` and `scripts/tests/` use `node --test`; Playwright specs are
  `*.spec.ts` under `tests/e2e/`. Add focused regression tests for features and
  fixes. The ≥80% coverage goal (`pnpm test:coverage`) is not enforced in CI.
- Every `DataStore` backend must pass the shared contract suite
  (`packages/store/src/contract/store-contract.ts` + `contract/suites/`).
- Plugin tests use `@covel/plugin-test-utils` (`MockLLM`,
  `makeManualFunctionContext`, `makeTurnInput`, …); see `docs/guide/plugin-testing.md`.
  New plugin behaviour should cover normal output, invalid input, data ownership,
  and that a failed execution commits no partial proposals.
- Web tests default to jsdom. A test file that needs no DOM may opt into
  `// @vitest-environment node`, which is noticeably faster.
- IndexedDB tests use `fake-indexeddb`; PostgreSQL tests need a real database
  (`pnpm db:up`, then `pnpm test:pg`). Store and server suites bypass the Turbo
  cache because database state is external to source inputs.

## Commits & Pull Requests

Use Conventional Commits (`fix(web): stabilize session restore`; types `feat`,
`fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). Branch from and target
`main`; never commit directly on `main`. Complete `.github/PULL_REQUEST_TEMPLATE.md`:
the rationale, breaking changes and the development data they invalidate, the
checks that actually ran plus what was not verified, related context, and the
documentation sync. Mark breaking changes with a `BREAKING CHANGE:` footer.

Releases follow the checklist in `docs/guide/desktop-packaging.md`: the root,
`apps/*`, and `packages/*` versions must match the `v*` tag, while plugins and
worlds version independently; pushing the tag triggers
`.github/workflows/release.yml`.

## Agent Skills

Project skills live in `.claude/skills/` (`create-plugin`, `create-world`,
`covel-static-turn-audit`, `covel-readonly-audit` — the two audit skills only on
explicit request); see `docs/guide/skills.md`. Skill references link to
`docs/reference/` instead of copying contract tables.

Directory-specific rules live in nested `AGENTS.md` files (e.g.
`docs/v2/AGENTS.md`). Claude Code does not read `AGENTS.md` on its own, so every
nested `AGENTS.md` gets a sibling `CLAUDE.md` that imports it.

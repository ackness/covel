# AGENTS.md

Shared instructions for every coding agent. Claude Code imports this through
`CLAUDE.md`; edit this file, not the import wrapper. Nested `AGENTS.md` files
hold directory-specific rules and have sibling `CLAUDE.md` imports.

## Project Overview

Covel is a plugin-based AI RPG framework and playable studio: a pnpm/Turborepo
TypeScript modular monolith, shipped as Web or Electron. **The kernel provides
primitives and orchestration; plugins carry gameplay; world packs carry settings.**

Follow [design principles](docs/internals/design-principles.md) when making
trade-offs; change code that contradicts them:

- Players come first. One narrative plugin is enough to play; removing all
  plugins must leave the framework functional. Bundled plugins and worlds are
  demos, with no privileged interfaces.
- Missing plugins or fields remove only their features, never stop the game.
  Validation reports problems to authors; the UI tells players what is missing.
- Desktop and self-hosted Web are the focus. Keep storage, auth and model access
  generic for a future browser-private official Web app (not yet supported).
  SQLite is the default; PostgreSQL must behave identically. No commercial
  edition is developed here.
- Plugins mix function and agent runtimes and use declarative json-render UI.
  Derive or default manifest fields wherever possible.

## Commands

Toolchain versions live in `mise.toml` and package manifests; do not duplicate
version pins here. Keep the Zod minimum aligned across consumers, the author SDK
peer dependency and the tools scaffold.

```bash
pnpm install --frozen-lockfile  # also builds the author SDK
pnpm dev                       # web :5173 + server :3001, SQLite by default
pnpm dev:web                   # web only
pnpm dev:server                # server only; STORE_BACKEND=memory for ephemeral
pnpm db:up                     # start PostgreSQL before pnpm dev:pg
pnpm dev:pg                     # PostgreSQL dev mode with preflight
pnpm stop                      # stop stray dev/turbo processes
pnpm check                     # full CI static gate, including lint and script tests
pnpm lint                      # type-check the FULL workspace, including tests
pnpm test                      # all Vitest suites
pnpm --filter @covel/runtime test  # example: one package's tests
pnpm test:docs                 # documentation package tests + script checks
pnpm test:docs:packages        # documentation package tests only, after pnpm check
pnpm test:pg                   # live-PG store contracts + server integration
pnpm e2e:smoke                 # deterministic Chromium smoke suite
pnpm e2e                       # all Playwright suites
pnpm schemas:generate          # after author-facing Zod schema changes
pnpm check:push                # verify committed HEAD in a clean checkout
pnpm changelog:preview         # preview pending release entries
```

Before pushing, run `pnpm check` and tests for changed packages; `pnpm lint`
alone is insufficient and git hooks omit source suites. Add `pnpm test:pg` for
store/database changes and `pnpm e2e:smoke` / `pnpm e2e` for UI flows. Docs-only:
`pnpm check` + `pnpm test:docs:packages`. `pnpm check:push` covers the static gate
and changed packages with dependents in a clean checkout.

In source development, changing bundled plugin manifests, handlers or locales
restarts the server.

See [commands](docs/internals/commands.md) for authoring, packaging, real-model
harnesses, individual checks, hooks and CI scope. When changing a documented
command or scaffold, re-run its documented sequence and fix every affected page.
Run Tailwind diagnostics through `apps/web/scripts/check-tailwind-canonical.mjs`;
keep `tailwind-lint` read-only (`--fix` can corrupt TypeScript identifiers).

## Monorepo Structure

- `apps/web`: React/Vite client; `apps/server`: Hono host composing feature packages;
  `apps/desktop`: Electron shell. `apps/site` and `apps/docs` are independent
  publishing targets, never bundled into Web or desktop.
- `packages/`: framework libraries. `plugin-handlers-utils` is the public author
  SDK and dependency root; `shared` sits above it. Package responsibilities and
  host composition: [packages](docs/internals/packages.md).
- `plugins/`: bundled packages; `worlds/`: bundled world packs; `packs/builtin.yaml`:
  player-selectable plugin sets. Installed/generated packages live outside the repo.
- `prompts/server/`: framework prompt templates; `templates/`: plugin scaffolds
  (`plugin-multi-runtime` standalone, `plugin-with-tools` workspace member).
- `tests/e2e/`: Playwright; `tests/third-party/`: community-package fixtures;
  `tests/llm-replay/`: scripted sessions, recordings kept local.
- `scripts/`: dev/check/release tooling; `scripts/tests/*.test.mjs`: Node tests
  included in `pnpm check`.

Workspace packages export TS source, except `@covel/plugin-handlers-utils`, which
exports `dist/`. Install, Turbo and server startup rebuild it. After editing SDK
source, run `pnpm --filter @covel/plugin-handlers-utils build` before a direct
package test. The host supplies this SDK and `zod` to installed plugins; plugins
bundle only other dependencies. Respect public package entry points and dependency
direction (`pnpm check:boundaries`).

Read [desktop packaging](docs/internals/desktop-packaging.md) before changing the
shell, sidecar or staging. The packaged backend always runs the app's own Electron
executable with RunAsNode in a separate child process; never bundle a separate Node,
use the player's PATH or fall back to another runtime. Verify target and actual
Electron/Node versions, the RunAsNode fuse, and main-bundle/ASAR resource binding.
Main/preload dependencies are bundled; the server payload retains its plugin
loader, SDK, native targets and licenses. Detach staging hardlinks before mutation.

## Coding Style

- ESM-only, strict TypeScript, ES2022, NodeNext. Use `.js` in relative TS imports;
  desktop helpers loaded by native Node use `.ts` with compiler rewriting.
- Prettier defaults: two spaces, double quotes, semicolons. `camelCase` values,
  `PascalCase` types/components, kebab-case modules. Avoid bare `any`; validate
  external input with Zod. Split large files by responsibility, not a line quota.
- `noImplicitOverride` and `noUncheckedIndexedAccess` are enabled. Prefer iteration
  or explicit existence checks; use `items[i]!` only with a visibly in-range index.
- Web appearance comes from SettingsStore helpers, with no separate theme provider.

## Critical Conventions

### Framework ↔ Plugin Isolation Rule

**Framework code (`packages/`, `apps/server/src/`, `apps/web/src/`) must never
hardcode a concrete plugin ID or name.** Discover providers through versioned
contracts, extension points and registered services, never another plugin's ID
or namespace. A missing primitive calls for a generic API, not a plugin special case.

- Dispatch on `RuntimeManifest.outputKind` (`story` / `system`), authored as
  `io.visibility`. `kind` only determines default selection. Trust follows source
  (`builtin` / `community`), never `kind`.
- Tests may use plugin IDs as fixtures; curation lists may contain them as data.
- Player creation belongs to plugins through proposals, never automatic framework
  conversion of forms into `CharacterRecord`s.

### Current contract only

Target the current contract during early development. Update producers, consumers,
schemas, fixtures and docs together. Do not add migrations, dual reads/writes,
aliases or fallback branches solely for old development data. Breaking contracts
get a new ID (`@2`) with providers and consumers upgraded together; document which
data must be recreated. Keep required concurrency, failure handling and supported
backend differences.

### Runtime and data boundaries

Read [turn flow](docs/internals/flow.md) before changing execution and
[plugin contracts](docs/reference/plugins.md) before changing manifests.

- `RuntimeManifest.pluginId` identifies the package and keys isolation, trust and
  writes; `.name` is the runtimeId and keys scheduling, traces and logs.
- Scheduling uses stages and declared dependencies, never numeric priority.
  `needs` gates success; `after` only orders; required inputs imply `needs`.
  Runtime-ID edges stay within a package; cross-package edges use versioned
  contracts. Independent runtimes run in parallel; preserve stage barriers.
- Trigger types are only `auto` / `manual` / `event`. `shouldTrigger` decides
  auto/event eligibility; explicit manual selection bypasses it and its cadence
  gates. Setup selection uses pending state and session dependency gates instead.
- Preserve the settle barrier before freezing an execution's registry and state.
  Detached post-turn/audit function leaves use the durable queue; `settle: true`
  makes the next execution wait within its limit. Manual/event background work
  runs as a separate execution; see [turn flow](docs/internals/flow.md).
- Keep `output`, `effects`, `completion` separate. Effect-shaped output does
  nothing; agents produce effects through tools. **All writes go through proposal
  validation and commit.** Tool success does not imply persistence.
- Setup completion is per plugin version; guards must skip work already done.
  Only committed player executions advance `completedPlayerTurns`: setup and the
  opening do not, so the opening and first player message share `logicalTurn = 1`.
- `ProposalPayloadMap` (`packages/shared/src/types/proposal.ts`) and `HOOK_EVENTS`
  (`packages/shared/src/types/hooks.ts`) are the single authorities for proposal
  types and hook names. Hooks are session-scoped; `ctx.pluginId` / `ctx.runtimeId`
  identify the subject runtime, while `ctx.getOwnSettings()` reads the handler
  owner's settings. See [hooks](docs/reference/hooks.md).
- Resolve session plugins through `resolveSessionPlugins` (requests, exclusions,
  authorization and contracts). Changes apply next turn. Discovery location
  determines trust: installed packages, including official ones, are community.
- Use declared inputs for current results, `recordAs` + committed inputs for
  history, events for follow-up work, and services for request/response. World
  data routes through accepted contracts, never a hardcoded destination namespace.
  See [plugin communication](docs/reference/plugin-extensions.md).
- Core objects stay separate: Run, Branch, Snapshot, State, Event, Record,
  Character, PluginData. Plugin KV is session/package scoped; `_` namespaces are
  kernel-reserved. World Model reads use `ctx.world`, writes use proposals.
- `turn_results.commit_status` stays `pending` until its commit owner settles it
  to `committed` / `failed`; lingering `pending` signals a crash.
- SQLite and PostgreSQL share the DataStore contract; BrowserVault hydrates an
  ephemeral MemoryStore and is not another DataStore backend. In PgStore's Drizzle
  `jsonb` custom type pass plain values (it stringifies once); bare postgres.js
  uses `sql.json(value)`, never pre-stringified JSON.

### Plugin authoring contract

- Use only the public `@covel/plugin-handlers-utils` API, never framework internals,
  DB tables or frontend components. Hooks guard/rewrite/audit, not gameplay.
- Root `PLUGIN.md` declarations and entry registrations must match both ways.
  Bundled packages also need a versionless ESM `package.json` and `README.md`;
  their version lives in `PLUGIN.md`. External packages need only `PLUGIN.md`.
  Use either one inline runtime or `runtimes/<id>/RUNTIME.md`, never both; a package
  may have none. A `function` block selects a function runtime; otherwise an agent.
  Authored manifests and compiled `RuntimeManifest` are different contracts.
- Tools have Zod schemas. `ToolRegistry.find(name, pluginId)` resolves builtin tools
  first, then the caller's own tools; never search other plugins. Declare agent
  and function tool allowlists; use services for cross-plugin calls. Declare
  permissions and effects for high-risk runtimes. Omit default-valued fields.
- Use `ctx.images` / `ctx.gateway.generateImage` for image generation, not provider
  fetches. Plugins name model slots, never providers, models or endpoints. Slot
  fallback never crosses tags. Session `runtimeModelOverrides` maps runtime IDs
  to slots and overrides agent defaults; functions ignore it. Request `modelOverride`
  applies only to story runtimes. See [slots](docs/reference/slots.md) and
  [media store](docs/reference/media-store.md) for routing and media bindings.
- UI uses declarative specs and `ui.slot@1`; custom HTML stays in a sandboxed
  webview. See [UI panels](docs/reference/ui-panels.md) and
  [UI components](docs/reference/ui-components.md) before changing rendering.
- Use `ctx.random` (including `shortId`'s fourth argument), never `Math.random` or
  `node:crypto`, for game randomness.
- Keep IDs, row UUIDs and timestamps out of model-facing text; name turns by number.
  Plugin-built JSON goes through `modelFacingJson`.
- `pnpm validate:plugin plugins/<id>` is static and never executes entry code.
  Bundled registration is covered by `apps/server/tests/bootstrap/builtin-plugin-entries.test.ts`.

### Locale

Session content locale is fixed at creation and must be a world-supported edition
(`sessionContentLocale`). Pass it through turns, manual runs, background jobs and
hooks; action requests cannot override it. UI language selects labels only. Use
`resolveI18nText` from `@covel/shared`, never ad-hoc language checks. Each authored
file holds one language.

Framework prompts live in locale-aware files under `prompts/`. Plugin instruction
bodies are English with only a `*.zh.md` variant for Simplified Chinese; other
locales use English. Use `instructionLocaleFor` and honor `COVEL_INSTRUCTION_LOCALE`.
Read [i18n](docs/reference/i18n.md) for resolution and translation rules.

### Security and configuration

Read [security](docs/internals/security.md) before changing trust boundaries.

- Preserve SSRF/DNS pinning and default access to public HTTPS hosts without a
  host allowlist. Plugin `fetchWithRetry` always uses the strict direct path.
  Server keys attach only to origins matching trusted configuration.
- Request provider keys arrive in `X-Provider-Keys`; the server never persists them.
  Community server code is unsandboxed and needs player approval; declared HTTP
  origins are enforced fail-closed. Reject executable YAML frontmatter directives.
- Route authorization through `apps/server/src/host-profile.ts`, never scattered
  deployment-env checks. Personal instances rely on loopback/Host checks, with
  desktop config/file tokens when configured; browser-private sessions still
  require owner tokens. Hosted `demo` / reserved `commercial` enforce owner and
  operator rules. Do not treat all `self` requests as token-free.
- Never commit `.env`, `.env.llm` or `llm.toml`. Every environment variable belongs
  in `packages/shared/src/env/registry.ts` and [its reference](docs/reference/env-registry.md).
  Desktop paths/config: [desktop config](docs/reference/desktop-config.md);
  preferences and keys: [settings store](docs/reference/settings-store.md).
- `io.concealed` strips prompts, replies, tool arguments and outputs from traces
  and live streams, and substitutes a fixed failure message; log real errors
  server-side only. Runtime traces go to DB; infrastructure logs to the console.

## Documentation

`docs/` is the reader-facing source of truth. **Before a non-trivial change, read
its matching page.** Code/tests establish current behavior; fix stale docs in the
same change. [docs/README.md](docs/README.md) is the full page index and code Search
Map; [glossary](docs/reference/glossary.md) defines terms. Keep contract details in
those pages instead of expanding this file.

- Follow `docs/AGENTS.md` for writing and site checks. Chinese pages are the source;
  mirror changes under `docs/en/`. `README.md` pairs with `README.zh-CN.md`;
  `docs/CONTRIBUTING.md` pairs with `docs/CONTRIBUTING.en.md`.
- Keep durable guides/contracts/architecture in `docs/`. Put plans, audits and
  handoffs in gitignored `devs/docs/`, debug artifacts in `debugs/`; never add root
  `audits/`, `plans/`, `context.md` or `progress.md`. Remove implemented plans after
  folding stable conclusions into the matching docs.
- New, moved or removed pages update `docs/README.md` and `apps/docs/.vitepress/config.ts`;
  run `pnpm --filter @covel/docs build`. Preserve inbound heading anchors.
- `docs/internals/technical-debt.md` must mirror source `ponytail:` markers.

### Documentation sync

Update the matching pages in the same PR whenever their surface changes. Paths
below are relative to `docs/`; also update English counterparts.

| Change                                               | Required pages                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Bundled plugin, player settings or panels            | `builtin/` theme page and `builtin/index.md`; plugin changes also `reference/plugins.md` + `plugins/` guides     |
| Manifest/runtime fields                              | `reference/plugins.md` + `plugins/` guides; regenerate schemas for author-facing schema changes                  |
| Extension point, service or plugin API               | `reference/extension-points.md` + `reference/plugin-extensions.md`                                               |
| Hook event, payload, result or context               | `reference/hooks.md`                                                                                             |
| Tool or approval/source policy                       | `reference/tools.md`                                                                                             |
| Model slot                                           | `reference/slots.md`                                                                                             |
| SSE or protocol                                      | `reference/protocol.md`                                                                                          |
| Panels, data sources or UI slots                     | `reference/ui-panels.md`                                                                                         |
| API endpoint                                         | `reference/api.md`                                                                                               |
| RPC action, framework default or approval/trust flow | `reference/api.md` + `reference/protocol.md`                                                                     |
| Plugin data contribution/contract                    | `reference/plugins.md` + `reference/world-data.md`                                                               |
| World data, import or sync                           | `reference/world-data.md` + `reference/api.md` + `reference/transactions.md`                                     |
| World Model                                          | `reference/world-model.md`                                                                                       |
| Plugin/world install, update or collections          | Matching `reference/plugin-installation.md` / `reference/world-installation.md` + `ship/collections.md`          |
| Environment variable                                 | Registry in code + `reference/env-registry.md`                                                                   |
| Security boundary                                    | `internals/security.md`                                                                                          |
| Packages, dependencies or root scripts               | This file's Commands / Monorepo Structure + `internals/packages.md` + affected command examples                  |
| Plugin scaffold                                      | Template READMEs + `plugins/essentials.md` + `plugins/testing.md` + `.claude/skills/create-plugin/` in repo root |
| CI, hooks or pre-push checks                         | `CONTRIBUTING.md` + `CONTRIBUTING.en.md` + `.github/PULL_REQUEST_TEMPLATE.md` in repo root                       |
| Terminology                                          | `reference/glossary.md`                                                                                          |

Any user-visible change needs `docs/changelog.d/<slug>.md`, using the section
headings in that directory's README. Never edit `docs/CHANGELOG.md` directly.

## Testing

- Add focused regressions for features/fixes. Run package tests from their package
  (`pnpm --filter <pkg> test`), not root Vitest, so `vitest.base.ts` applies its
  per-run temp directory. Every Vitest package imports that base config.
- Test code is type-checked by `pnpm lint`. Fix fixtures using real types; never
  enlarge tsconfig exclusions to hide errors. Runtime coverage has an enforced
  floor; see [commands](docs/internals/commands.md) for coverage tasks.
- Every DataStore backend passes `packages/store/src/contract/store-contract.ts`
  and `contract/suites/`. PostgreSQL needs a real database; IndexedDB uses
  `fake-indexeddb`.
- Plugin tests use `@covel/plugin-test-utils`; cover normal/invalid inputs,
  ownership and no partial commit on failure. See [plugin testing](docs/plugins/testing.md).
- Web Vitest defaults to jsdom; pure tests may use the Node environment.
  Desktop and script tests use `node --test`. Playwright uses production builds;
  specs importing `/src/` need the slower `chromium-dev` project. See
  [E2E testing](docs/internals/e2e-testing.md).

## Commits & Pull Requests

Use Conventional Commits (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`,
`ci`). Branch from and target `main`; never commit directly on it. Complete
`.github/PULL_REQUEST_TEMPLATE.md`: rationale, breaking changes and invalidated
dev data, checks actually run and gaps, context, documentation sync. Mark breaking
changes with a `BREAKING CHANGE:` footer.

Releases follow [desktop packaging](docs/internals/desktop-packaging.md): root,
`apps/*` and `packages/*` versions match the `v*` tag; plugins/worlds version
independently. Pushing the tag triggers the release workflow.

## Agent Skills

Project skills live in `.claude/skills/`: `create-plugin`, `create-world`,
`covel-static-turn-audit`, `covel-readonly-audit`. Use either audit **only on
explicit request**. Skill references link to contracts rather than copying them;
see [skills](docs/internals/skills.md).

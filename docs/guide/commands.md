# Command Reference

The commands used every day (`pnpm dev`, `pnpm check`, `pnpm test`, …) are in
[`AGENTS.md`](../../AGENTS.md). This page holds the rest: scripts used for one kind
of task, and the details of the git hooks and CI scope. Every command here is
expected to run as written; when a root script or its arguments change, re-run the
command and fix this page in the same change.

## Dev and build

```bash
pnpm dev:electron     # desktop shell in development
pnpm --filter @covel/site dev    # the showcase website (apps/site) on port 5174
pnpm --filter @covel/site build  # its static build → apps/site/dist/
pnpm build            # all Turbo build targets
pnpm build:electron   # production desktop installer → release/
pnpm format           # Prettier
pnpm db:up            # start the PostgreSQL container only (needed before dev:pg / test:pg)
pnpm docker:up        # Compose stack (postgres + app); docker:build / docker:down / docker:down-all / docker:logs
pnpm db:generate      # Drizzle migration generation for the server
pnpm db:studio        # Drizzle Studio
```

## Tests

```bash
pnpm test:coverage:runtime  # @covel/runtime tests with coverage; fails under the floor in its vitest.config.ts (CI runs it)
pnpm test:coverage          # Vitest workspaces plus the desktop Node tests, reports under each package's coverage/
pnpm e2e                    # all Playwright specs; pnpm e2e:ui opens the Playwright UI
pnpm e2e:extensions   # Playwright acceptance for a community plugin in an isolated home
pnpm e2e:verify       # API-driven real-LLM plugin harness against a running server (its keys come from .env.llm
                      # or the environment); uses the configured models, --slot overrides the story slot
pnpm e2e:replay       # replay the scripted sessions recorded under tests/llm-replay/ without a model, each on a
                      # test server of its own; --record [session] records them again after a world, plugin,
                      # prompt or model change, against DEFAULT_BASE_URL with DEFAULT_API_KEY (or
                      # --upstream <origin>) (docs/guide/e2e-plugin-verify.md)
pnpm llm:replay       # record-and-replay proxy in front of a model endpoint, for repeating a scripted
                      # session without model calls: pnpm llm:replay --mode record --upstream <origin>
                      # --fixtures <dir>, then --mode replay --fixtures <dir>; pnpm llm:replay:diff
                      # <a.requests> <b.requests> shows where two runs differ (docs/guide/e2e-plugin-verify.md)
pnpm prompt:prefix    # per runtime of a recorded session: the size of each turn's first model request, how
                      # much of it repeats the previous turn's from the start (the part a provider's prompt
                      # cache can serve), and where the two first differ: pnpm prompt:prefix <covel.db>
                      # [--session <id>] [--show <runtimeId>] [--json] (docs/reference/prompt-structure.md)
pnpm test:runtime     # standalone runtime harness CLI (packages/test-runtime)
pnpm test:plugin-lifecycle  # install, authorize, run, and remove a community ZIP through the real API
pnpm test:tabletop-plugin   # the same for tabletop-rules packed under a different plugin ID
pnpm pack:test-plugin       # write the ZIPs those tests use to test-results/ (also pack:tabletop-plugin)
```

## Authoring and packaging

```bash
pnpm describe:authoring  # what a world may contain for the scanned plugins: files, data contracts
                      # with the path each file goes to and an example, plugin IDs and settings
                      # (--json, --check validates plugin examples, --plugins <dir>)
pnpm validate:collection  # static check of a covel-collection.yaml directory (docs/guide/collections.md)
pnpm create-collection    # scaffold a collection: pnpm create-collection <id> [dir]
pnpm pack:collection      # zip a collection for offline import: pnpm pack:collection <dir> [out.zip]
pnpm i18n             # translation tooling for a plugin or world directory: status, extract,
                      # translate (configured model; --to <dir> keeps a plugin's translation
                      # outside its package), lock (docs/reference/i18n.md)
pnpm i18n:add         # add a UI locale to the web app (apps/web/src/i18n/locales/README.md)
```

`pnpm create-plugin <name> [-t dir] [-r a:function,b:agent]` scaffolds from
`templates/`; the default target is the user plugin dir and `--with-tools` scaffolds
into `plugins/`.

## Individual checks

`pnpm check` runs all of these; run one alone while iterating.

```bash
pnpm check:i18n       # web + plugin i18n coverage + plugin READMEs; tool definitions are English;
                      # Chinese text in framework source only in recorded files; every label and
                      # text of a bundled plugin has a current Chinese translation;
                      # every t() fallback in web code equals the en-US catalog text
pnpm check:prompts    # plugin and template prompts are English; each *.zh.md variant matches its English prompt
                      # (pnpm prompts:lock records a pair after both languages changed); it also prints
                      # style and structure warnings, which do not fail it (docs/guide/prompt-style.md)
pnpm check:boundaries # workspace public entry points, declared deps, package direction
pnpm deps:check       # Fallow: unused/unlisted deps and unresolved imports (.fallowrc.jsonc)
pnpm analyze          # Fallow report: dead code, duplication, complexity; exits non-zero
                      # while findings remain, so it is a report, not a gate
pnpm check:push --full  # every suite; --base <ref> measures from another branch
```

## Release

```bash
pnpm changelog:release  # at release: pnpm changelog:release <version> [--date YYYY-MM-DD] moves the
                      # fragments into docs/CHANGELOG.md and deletes them (docs/changelog.d/README.md)
pnpm release:prepare  # pnpm release:prepare <version> [--dry-run] [--date YYYY-MM-DD]: sets the version in
                      # the root, apps/* and packages/* manifests and both README badges, then runs the
                      # changelog assembly; refuses a lower version or a dirty tree; no commit or tag
pnpm release:preflight  # static pre-tag gate: lockfile, imports, plugin/world/prompt structure
```

The full release checklist is in [`desktop-packaging.md`](./desktop-packaging.md).

## Git hooks and CI scope

Pre-commit (`.pre-commit-config.yaml`) runs Prettier and Oxlint (rules in
`.oxlintrc.jsonc`, the same `--deny-warnings` as `pnpm check`) on the changed
files. It runs no type check: `pnpm check` does. `pnpm hooks:install` adds a
pre-push hook that runs the static gate in a clean checkout of each pushed tip:
install, then `pnpm check`. It runs no test suite, because CI runs every suite on
the pull request in parallel jobs and `main` takes changes through pull requests
only.

`pnpm check:push` checks HEAD the same way and adds what the change can break:
the tests of the packages changed since the remote's main branch with the
packages that depend on them, and `pnpm e2e --list`.
`COVEL_PUSH_CHECK=affected git push` makes the hook do the same.

A suite that reads files outside its package runs when its `$TURBO_ROOT$` inputs in
`turbo.json` name a changed file, so keep those inputs true. Every suite runs when
the change touches the lockfile, `turbo.json`, `vitest.base.ts`, the root
`package.json` / `tsconfig.json`, or a root file no rule accounts for
(`scripts/lib/push-scope.mjs`), on a push to `main` or of a tag, when the remote's
main branch is unknown, and on request (`COVEL_PUSH_CHECK=full git push`,
`pnpm check:push --full`). The checkout uses the Turbo cache the worktrees share,
so a task already run on the same tracked inputs replays. A commit that passed is
remembered for 12 hours and is not checked again when its push is repeated.

CI (`.github/workflows/ci.yml`) runs everything: check, every test suite and the
build, with Web unit tests, server tests with the runtime coverage floor,
PostgreSQL integration, and browser smoke in parallel jobs; see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

`main` accepts changes through pull requests only (the `Protect main` ruleset:
no direct push, force push or deletion). CI, Docs and Site each run only for the
paths they cover, so `.github/workflows/gate.yml` adds the one check every pull
request has, `All checks pass`: it waits for every other check of the head
commit and fails when one fails. After re-running a failed check, re-run that
job too.

### Documentation-only changes

A change that touches only documentation takes a short path in both places: the
hook and `.github/workflows/docs.yml` run `pnpm check` and `pnpm test:docs`, and
`ci.yml` does not run. Documentation is `docs/**`, a root-level `*.md`, any
`README.md` / `README.*.md`, a nested `AGENTS.md` / `CLAUDE.md`,
`.claude/skills/**`, `.assets/**`, `LICENSE`, and the issue and pull request
templates (`scripts/lib/change-scope.mjs`). Markdown that a loader reads
(`PLUGIN.md`, `RUNTIME.md`, `WORLD.md`, the files under `prompts/`) is source. A
changelog fragment is documentation. A test that reads documentation must be named
in the root `test:docs` script; `scripts/tests/change-scope.test.mjs` fails
otherwise.

## Tailwind diagnostics

Run Tailwind diagnostics through `apps/web/scripts/check-tailwind-canonical.mjs`.
Keep `tailwind-lint` read-only: v0.12.1 can treat ordinary TypeScript identifiers
as classes and corrupt them through `--fix`. Canonical numeric Tailwind utilities
depend on the default `--spacing` scale; audit fixed-layout geometry before
overriding that token globally.

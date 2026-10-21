# Commands

This page lists the less commonly used commands at the root of the repository, and says what the Git hooks and CI each check. It is written for contributors who change the Covel source code. The commands you use every day (`pnpm dev`, `pnpm check`, `pnpm test`, and so on) are in [`AGENTS.md`](../../../AGENTS.md) at the root.

Every command on this page should run exactly as it is written. If you change a root script or its arguments, run it again, and fix this page in the same change.

## Dev and build

```bash
pnpm dev:electron     # desktop shell in development
pnpm --filter @covel/site dev    # the showcase website (apps/site) on port 5174
pnpm --filter @covel/site build  # its static build → apps/site/dist/
pnpm --filter @covel/docs dev    # the documentation site (apps/docs, pages in docs) on port 5175
pnpm --filter @covel/docs build  # its static build → apps/docs/dist/; a dead link fails it
pnpm build            # all Turbo build targets
pnpm build:electron   # production desktop installer → release/
pnpm format           # Prettier
pnpm clean            # remove build output of every package (turbo clean)
pnpm db:up            # start the PostgreSQL container only (needed before dev:pg / test:pg)
pnpm docker:up        # SQLite Compose stack (app only; docker/docker-compose.sqlite.yml)
pnpm docker:build     # the same, rebuilding the image first
pnpm docker:down      # stop the stack, keep the volume
pnpm docker:down-all  # stop the stack and DELETE the volume
pnpm docker:logs      # follow the stack's logs
pnpm docker:pg:up     # PostgreSQL Compose stack (postgres + app; docker/docker-compose.yml)
pnpm docker:pg:build  # the same, rebuilding the image first
pnpm docker:pg:down   # stop the stack, keep the volumes
pnpm docker:pg:down-all  # stop the stack and DELETE the volumes
pnpm docker:pg:logs   # follow the stack's logs
pnpm db:generate      # Drizzle migration generation for the server
pnpm db:studio        # Drizzle Studio
```

> [!CAUTION]
> `pnpm docker:down-all` and `pnpm docker:pg:down-all` delete the data volumes, so the database and application data disappear with them. To stop only the containers, use `pnpm docker:down` / `pnpm docker:pg:down`.

## Tests

```bash
pnpm test:coverage:runtime  # @covel/runtime tests with coverage; fails under the floor in its vitest.config.ts (CI runs it)
pnpm test:coverage          # Vitest workspaces plus the desktop Node tests, reports under each package's coverage/
pnpm e2e                    # all Playwright specs
pnpm e2e:ui                 # the same in the Playwright UI
pnpm e2e:extensions   # Playwright acceptance for a community plugin in an isolated home
pnpm e2e:verify       # API-driven real-LLM plugin harness against a running server (its keys come from .env.llm
                      # or the environment); uses the configured models, --slot overrides the story slot
pnpm e2e:replay       # replay the scripted sessions under tests/llm-replay/ without a model, each on a test
                      # server of its own, from a recording made on this machine (not committed); --record
                      # [session] records them first, against DEFAULT_BASE_URL with DEFAULT_API_KEY (or
                      # --upstream <origin>)
pnpm llm:replay       # record-and-replay proxy in front of a model endpoint, for repeating a scripted
                      # session without model calls: pnpm llm:replay --mode record --upstream <origin>
                      # --fixtures <dir>, then --mode replay --fixtures <dir>
pnpm llm:replay:diff  # pnpm llm:replay:diff <a.requests> <b.requests> shows where two runs differ
pnpm prompt:prefix    # per runtime of a recorded session: the size of each turn's first model request, how
                      # much of it repeats the previous turn's from the start (the part a provider's prompt
                      # cache can serve), and where the two first differ: pnpm prompt:prefix <covel.db>
                      # [--session <id>] [--show <runtimeId>] [--json]
pnpm test:runtime     # standalone runtime harness CLI (packages/test-runtime)
pnpm test:plugin-lifecycle  # install, authorize, run, and remove a community ZIP through the real API
pnpm test:tabletop-plugin   # the same for tabletop-rules packed under a different plugin ID
pnpm pack:test-plugin       # write the ZIP test:plugin-lifecycle uses to test-results/
pnpm pack:tabletop-plugin   # write the ZIP test:tabletop-plugin uses to test-results/
```

Further reading:

- For how to write and run browser tests, see [`e2e-testing.md`](./e2e-testing.md).
- For the arguments and output of `e2e:verify`, `e2e:replay`, and `llm:replay`, see [Verify with a real model](../ship/real-model.md).
- For what the numbers in a `prompt:prefix` report mean, see [Prompt structure](../reference/prompt-structure.md).

## Authoring and packaging

```bash
pnpm describe:authoring  # what a world may contain for the scanned plugins: files, data contracts
                      # with the path each file goes to and an example, plugin IDs and settings
                      # (--json, --check validates plugin examples, --plugins <dir>)
pnpm validate:collection  # static check of a covel-collection.yaml directory
pnpm create-collection    # scaffold a collection: pnpm create-collection <id> [dir]
pnpm pack:collection      # zip a collection for offline import: pnpm pack:collection <dir> [out.zip]
pnpm i18n             # translation tooling for a plugin or world directory: status, extract,
                      # translate (configured model; --to <dir> keeps a plugin's translation
                      # outside its package), lock
pnpm i18n:add         # add a UI locale to the web app (apps/web/src/i18n/locales/README.md)
```

`pnpm create-plugin <name> [-t dir] [-r a:function,b:agent]` generates a plugin from `templates/`. By default it is generated into the user plugin directory. With `--with-tools`, it is generated under the repository's `plugins/` instead. This option cannot be used together with `-t` or `-r`.

Further reading: for collections, see [Collections](../ship/collections.md). For the translation tools, see [i18n](../reference/i18n.md).

## Individual checks

`pnpm check` runs all of the following. While you are making repeated changes, you can run just one of them.

```bash
pnpm check:i18n       # web + plugin i18n coverage + plugin READMEs; tool definitions are English;
                      # Chinese text in framework source only in recorded files; every label and
                      # text of a bundled plugin has a current Chinese translation;
                      # every t() fallback in web code equals the en-US catalog text
pnpm check:prompts    # plugin and template prompts are English; each *.zh.md variant matches its English prompt;
                      # it also prints style and structure warnings, which do not fail it
pnpm prompts:lock     # record an English / *.zh.md pair after both languages changed
pnpm check:boundaries # public entry points, declared deps, package direction, unused exports
pnpm deps:check       # Fallow: unused/unlisted deps and unresolved imports (.fallowrc.jsonc)
pnpm analyze          # Fallow report: dead code, duplication, complexity; exits non-zero
                      # while findings remain, so it is a report, not a gate
pnpm check:push --full  # every suite; --base <ref> measures from another branch
```

`pnpm analyze` is not part of `pnpm check`. It is only a report. For the rules on how to write prompts, see [Prompt style](../plugins/prompt-style.md).

`pnpm check` also includes the following checks, which you can run on their own too:

```bash
pnpm check:oxlint     # Oxlint; a warning fails it
pnpm check:manifests  # pnpm validate:plugin on every bundled plugin
pnpm check:schemas    # the generated schema reference matches the Zod schemas (fix with pnpm schemas:generate)
pnpm check:changelog  # the fragments in docs/changelog.d/ are well formed
pnpm check:scripts    # scripts/tests/*.test.mjs under node --test
pnpm check:workflows  # actionlint on .github/workflows/
```

The `check:scripts` test `ui-literal-baseline.test.mjs` counts JSX text and text props such as `title`, `placeholder`, `aria-label`, `alt`, and `label` per file in `apps/web/src`. It counts literals containing CJK characters or English words; skips `/debug`, tests, stories, and locale catalogs; and ignores classes, ids, URLs, and `t()` arguments. The detector's header lists its full rules. New files must have zero hits, and existing files cannot exceed `scripts/tests/ui-literal-baseline.json`. A decrease or deleted file also fails until the baseline is lowered.

```bash
node --test scripts/tests/ui-literal-baseline.test.mjs
node scripts/tests/ui-literal-baseline.test.mjs --update
```

The first command reports 5 passing tests. The second accepts only decreases, writes the baseline, and reports `Updated UI literal baseline (counts can only decrease).` It cannot accept new text.

The server's `instruction-language.test.ts` fixes `COVEL_INSTRUCTION_LOCALE=en`, loads an English Emberback session, selects every bundled runtime's body, and assembles its context without a model call. It checks the bodies, static prompt contributions, framework templates, and assembled instructions. World content is excluded before assembly, so framework notes around data blocks remain checked.

```bash
pnpm --filter @covel/server exec vitest run tests/bootstrap/instruction-language.test.ts --maxWorkers=2
```

It reports 3 passing tests. A CJK instruction failure lists the source and line number; fix the body or missing English template instead of adding an exception.

`check:scripts` also checks compatibility wording in `apps/*/src`, `packages/*/src`, and plugin code, excluding tests and archives. `legacy`, `compat`, `compatible`, `compatibility`, `backward(s)`, `old format`, and `old decoder` require `ponytail:` on the same or preceding line and a matching [limits ledger](./technical-debt.md) entry. A few current API or domain terms may use the file allowlist in `scripts/tests/compat-wording.test.mjs`, with a reason for each entry. Delete obsolete branches and reword comments that describe current behavior.

## Release

```bash
pnpm changelog:release  # at release: pnpm changelog:release <version> [--date YYYY-MM-DD] moves the
                      # fragments into docs/CHANGELOG.md and deletes them (docs/changelog.d/README.md)
pnpm release:prepare  # pnpm release:prepare <version> [--dry-run] [--date YYYY-MM-DD]: sets the version in
                      # the root, apps/* and packages/* manifests and both README badges, then runs the
                      # changelog assembly; refuses a lower version or a dirty tree; no commit or tag
pnpm release:preflight  # static pre-tag gate: lockfile, imports, plugin/world/prompt structure
```

The full release checklist is in [`desktop-packaging.md`](./desktop-packaging.md#release-checklist).

## Git hooks and CI scope

A change goes through three checks: when you commit, when you push, and on the pull request.

| When                      | What runs                                                                               | What does not run                   |
| ------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| Commit (pre-commit)       | Prettier and Oxlint on the changed files                                                | Type checking, tests                |
| Push (pre-push, optional) | Install in a clean checkout, then `pnpm check`; docs-only also runs documentation tests | Source test suites                  |
| `pnpm check:push`         | The same as the pre-push hook, plus affected package tests and `pnpm e2e --list`        | Unaffected packages                 |
| Pull request (CI)         | `pnpm check`; documentation tests for docs-only, all tests and the build otherwise      | Full suites and build for docs-only |

### When committing and pushing

- The pre-commit configuration is in `.pre-commit-config.yaml`. The Oxlint rules are in `.oxlintrc.jsonc`. As with `pnpm check`, it runs with `--deny-warnings`, so a single warning counts as a failure. It does not do type checking. `pnpm check` does that.
- `pnpm hooks:install` installs the pre-push hook. For each pushed commit, it makes a clean checkout, installs dependencies, and runs `pnpm check`. Source pushes run no test suite; docs-only pushes also run the documentation tests below. CI runs all tests in parallel for source pull requests, and `main` accepts only pull requests.
- `pnpm check:push` checks HEAD in the same way. It also adds the parts this change may affect: the packages changed since the remote main branch, the tests of the packages that depend on them, and `pnpm e2e --list`.
- `COVEL_PUSH_CHECK=affected git push` makes the hook do this too.

### When all tests run

Some tests read files outside their own package. If a file is written in the `$TURBO_ROOT$` input of `turbo.json` for a test, that test runs whenever the file changes. So these inputs must stay accurate.

All tests run in any of the following cases:

- The change touches the lockfile, `turbo.json`, `vitest.base.ts`, the root `package.json`, or `tsconfig.json`.
- The change touches a root file that no rule covers (the rules are in `scripts/lib/push-scope.mjs`).
- You push to `main`, or you push a tag.
- The remote main branch cannot be found.
- You ask for it: `COVEL_PUSH_CHECK=full git push` or `pnpm check:push --full`.

Checkouts use the Turbo cache shared by all worktrees, so a task that ran with the same inputs replays its result directly. A commit that has passed the check is remembered for 12 hours. During that time, pushing it again does not check it again.

### On pull requests

CI (`.github/workflows/ci.yml`) handles documentation, source, and mixed changes in one workflow and always runs the complete `pnpm check`. Docs-only changes then run documentation tests; source changes, unknown scope, and releases run every suite. Web unit tests, server tests with the runtime coverage floor, PostgreSQL integration, and browser smoke remain parallel jobs. Every non-release CI run calls Site to build the showcase and documentation once; the remaining full-path build excludes those targets, while standalone `pnpm build` is unchanged. Releases skip Site, run release preflight, and build through platform packaging jobs. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

`main` accepts only pull requests (the `Protect main` ruleset: no direct push, force push, or deletion). CI's `Verification` aggregates the selected jobs, including Site on non-release runs: missing, skipped, failed, or cancelled required jobs cannot pass. `.github/workflows/gate.yml` supplies `All checks pass` for every pull request. It requires successful `Verification` and preserves failures from other checks. Rerun this gate after rerunning a failed check.

### Documentation-only changes

Docs-only changes take a short path: the push hook and `ci.yml` run `pnpm check`, then `pnpm test:docs:packages`; CI also builds the showcase and documentation through Site. Documentation-reference and technical-debt-ledger script tests already ran in `check:scripts` and are not repeated. Standalone `pnpm test:docs` still includes the package tests and both script suites. When checking a historical commit, the push hook uses the commands that commit provides.

Files that count as documentation (the rules are in `scripts/lib/change-scope.mjs`):

- `docs/**`
- `*.md` at the root
- `README.md` / `README.*.md` anywhere
- `AGENTS.md` / `CLAUDE.md` in subdirectories
- `.claude/skills/**`
- `.assets/**`
- `LICENSE`
- Issue and pull request templates

Points to keep in mind:

- Markdown that a loader reads is source code, not documentation: `PLUGIN.md`, `RUNTIME.md`, `WORLD.md`, and the files under `prompts/`.
- Changelog fragments (the files under `docs/changelog.d/`) count as documentation.
- A package test that reads documentation must be named in the root `test:docs:packages` script. Otherwise `scripts/tests/change-scope.test.mjs` fails.

## Tailwind diagnostics

To check Tailwind class names, run them through `apps/web/scripts/check-tailwind-canonical.mjs`.

> [!WARNING]
> Do not add `--fix` to `tailwind-lint`. Earlier versions rewrote ordinary TypeScript identifiers as class names and broke the code. The script stays read-only and filters `cssConflict` diagnostics.

Standard Tailwind utility classes that have numbers depend on the default `--spacing` scale. Before you override this variable globally, check whether any layouts with hard-coded sizes will change with it.

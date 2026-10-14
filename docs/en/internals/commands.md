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
pnpm e2e:replay       # replay the scripted sessions recorded under tests/llm-replay/ without a model, each on a
                      # test server of its own; --record [session] records them again after a world, plugin,
                      # prompt or model change, against DEFAULT_BASE_URL with DEFAULT_API_KEY (or
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
pnpm check:boundaries # workspace public entry points, declared deps, package direction
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

| When                      | What runs                                                                                    | What does not run              |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| Commit (pre-commit)       | Prettier and Oxlint on the changed files                                                     | Type checking, tests           |
| Push (pre-push, optional) | In a clean checkout, install dependencies, then run `pnpm check`                             | Any tests                      |
| `pnpm check:push`         | The same as the pre-push hook, plus the tests of the affected packages and `pnpm e2e --list` | Packages that are not affected |
| Pull request (CI)         | `pnpm check`, all tests, the build                                                           | Nothing                        |

### When committing and pushing

- The pre-commit configuration is in `.pre-commit-config.yaml`. The Oxlint rules are in `.oxlintrc.jsonc`. As with `pnpm check`, it runs with `--deny-warnings`, so a single warning counts as a failure. It does not do type checking. `pnpm check` does that.
- `pnpm hooks:install` installs the pre-push hook. For each commit being pushed, it makes a clean checkout, installs dependencies, and runs `pnpm check`. It does not run tests. CI runs all the tests in parallel on the pull request, and `main` accepts only pull requests.
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

CI (`.github/workflows/ci.yml`) runs everything: `pnpm check`, every group of tests, and the build. The web unit tests, the server tests with the runtime coverage floor, the PostgreSQL integration tests, and the browser smoke tests are in parallel jobs. For details, see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

`main` accepts only pull requests (the `Protect main` rule set: no direct push, no force push, and no deletion). The CI, Docs, and Site workflows each run only when the paths they are responsible for change. So `.github/workflows/gate.yml` provides the check that every pull request has: `All checks pass`. It waits for the other checks on this commit to finish, and it fails if any one of them fails. After you rerun a failed check, rerun this one too.

### Documentation-only changes

A change that touches only documentation takes a short path. The push hook and `.github/workflows/docs.yml` run only `pnpm check` and `pnpm test:docs`, and `ci.yml` does not run.

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
- A test that reads documentation must be named in the root `test:docs` script. Otherwise `scripts/tests/change-scope.test.mjs` fails.

## Tailwind diagnostics

To check Tailwind class names, run them through `apps/web/scripts/check-tailwind-canonical.mjs`.

> [!WARNING]
> Do not add `--fix` to `tailwind-lint`. Earlier versions rewrote ordinary TypeScript identifiers as class names and broke the code. The script stays read-only and filters `cssConflict` diagnostics.

Standard Tailwind utility classes that have numbers depend on the default `--spacing` scale. Before you override this variable globally, check whether any layouts with hard-coded sizes will change with it.

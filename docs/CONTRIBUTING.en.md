# Contributing to Covel

Thanks for considering contributing! This document outlines the process for contributing code, issues, and documentation.

> 🇨🇳 [中文版本](./CONTRIBUTING.md)

> Root README: [`../README.md`](../README.md).

Everyone taking part in the project follows the [Code of Conduct](../CODE_OF_CONDUCT.md).

## Development environment

- Node.js 26.x
- pnpm 12.14.0 (see the root `package.json` `packageManager`)
- Optional: Docker (for PostgreSQL mode)

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # server and storage settings
cp llm.toml.example llm.toml   # configure LLM slots
cp .env.llm.example .env.llm   # fill in API keys
pnpm dev                       # start frontend + backend
```

After `pnpm install --frozen-lockfile`, run `pnpm hooks:install` once in each new clone to install the local Git pre-push hook. It preserves the existing pre-commit hook and refuses to overwrite an unrelated pre-push hook; resolve that conflict yourself before installing. The hook uses `mise exec` to select the Node 26.12.1, pnpm 12.14.0, and actionlint toolchain from `mise.toml`, so install mise and run `mise install` first.

The root `.pre-commit-config.yaml` defines commit checks. Install pre-commit and run `pre-commit install` to enable them, or run `pre-commit run --all-files` manually. Oxlint is pinned in the root `devDependencies` and `pnpm-lock.yaml`. Like Prettier, it uses the project toolchain through `mise exec` without creating a separate Node environment. `scripts/run-with-project-node.mjs` prepends the selected Node directory to the child PATH so CLI shims and subsequent commands use the same version. Existing hooks read the updated configuration automatically; no global cache cleanup is needed. Oxlint rules live in the root `.oxlintrc.jsonc`, with one line of reason for each rule that is off. The hook checks the changed files and `pnpm check` checks the whole repository, both with `--deny-warnings`, so a warning fails the check. The commit hook runs no type check; `pnpm check`, the pre-push hook and CI do.

New files are limited to 3 MiB by default. World gallery originals at `worlds/*/media/gallery/*.png` have a separate 4 MiB limit to preserve lossless 1536×1024 images; each needs a WebP of the same name beside it, and the installers and the Docker image carry only the WebP. World portraits and scenes are tracked as WebP only (see [`guide/world-art-direction.md`](./worlds/art-direction.md)).

### PostgreSQL 18 development environment

SQLite is the default backend, and running from source needs no database service. To use PostgreSQL, create the root `.env` as above, uncomment the "PostgreSQL (optional)" block of `.env.example`, and keep `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, and `DATABASE_URL` consistent. Starting only the database does not require the Docker app's operator token:

```bash
pnpm db:up
pnpm dev:pg                    # PostgreSQL-backed API server
```

On first initialization, wait for the database to become ready before running `dev:pg`; check for `healthy` with `docker compose -f docker/docker-compose.yml --env-file .env ps postgres`. For the frontend, run `pnpm dev:web` in another terminal. `dev:pg` loads the root `.env` before checking the host/port from `DATABASE_URL`; without a URL, it checks `127.0.0.1:POSTGRES_PORT`. Update the URL when changing the port. See the [environment loading rules](./reference/env-registry.md#加载路径与环境差异) for overrides.

Compose uses PostgreSQL 18 with pgvector 0.8.7 and stores the database in `pgdata18`. The previous PG17 `pgdata` volume is not mounted, automatically migrated, or deleted.

### Docker self-hosting

There are two Compose stacks for self-hosting. Both are personal instances bound to loopback (`DEPLOYMENT_TIER=self`). SQLite is the default and runs a single app container; use the `pg` commands for PostgreSQL. Each stack has its own Compose project and volumes, so they do not touch each other.

| Backend          | Build and start        | Start existing containers | Stop, keep data       | Stop and **delete volumes** | Logs                  |
| ---------------- | ---------------------- | ------------------------- | --------------------- | --------------------------- | --------------------- |
| SQLite (default) | `pnpm docker:build`    | `pnpm docker:up`          | `pnpm docker:down`    | `pnpm docker:down-all`      | `pnpm docker:logs`    |
| PostgreSQL       | `pnpm docker:pg:build` | `pnpm docker:pg:up`       | `pnpm docker:pg:down` | `pnpm docker:pg:down-all`   | `pnpm docker:pg:logs` |

Both need the root `.env` and the root `llm.toml` (the model configuration is a read-only host mount), and `COVEL_MEDIA_TOKEN_SECRET` in `.env` (generate it with `openssl rand -hex 32`; without it a production app cannot issue media URLs; the SQLite stack refuses to start without it, and the PostgreSQL stack does not check it, so set it yourself). The PostgreSQL stack also needs the PostgreSQL block of `.env.example` uncommented and `POSTGRES_PASSWORD` set.

In the SQLite stack the `appdata` volume is mounted at `/home/node/.covel`: the database file `data/covel.db`, the media files, and the installed or generated user worlds and plugins all live in it. In the PostgreSQL stack the database is in the `pgdata18` volume, and `appdata` holds only user worlds and plugins. See [Docker configuration](./reference/env-registry.md#docker-compose).

`docker:down` and `docker:pg:down` stop containers and preserve data. **`docker:down-all` deletes the SQLite stack's `appdata` volume, including the database, user worlds, and plugins; `docker:pg:down-all` deletes the PostgreSQL stack's `pgdata18` and `appdata`**; use them only after backing up and choosing to reset the entire environment.

`db:generate` / `db:studio` are PostgreSQL maintenance tools, not automatic database upgrades; see [database maintenance](./reference/env-registry.md#数据库维护命令).

### Showcase site demo media

Install FFmpeg first. Run these commands from the repository root to update the showcase site's video and poster:

```bash
pnpm --filter @covel/site build:media
# Replace recording.mp4 with an existing source file.
node apps/site/scripts/build-media.mjs ./recording.mp4 --speed 3
```

The default source search is `.assets/demo.dev1.mp4`, then `.assets/demo.dev0.mp4`. A missing explicit path fails immediately. Outputs are `apps/site/public/media/demo.mp4` and `demo-poster.jpg`. Existing assets are replaced only after all conversions finish; conversion failures preserve them and clean up temporary files. An existing output can also be the input. Relative paths passed through `pnpm --filter @covel/site build:media` are relative to `apps/site/`; direct Node invocation uses the current directory.

The README GIF (`.assets/images/demo.gif`) is made separately, from a short recording, and stays under 6 MiB: 800 pixels wide, 10 frames a second, a 128-colour palette without dithering.

```bash
# Replace recording.mp4 with the source file.
vf="fps=10,scale=800:-2:flags=lanczos"
ffmpeg -y -i recording.mp4 -vf "$vf,palettegen=stats_mode=diff:max_colors=128" palette.png
ffmpeg -y -i recording.mp4 -i palette.png -lavfi "$vf [v]; [v][1:v] paletteuse=dither=none:diff_mode=rectangle" .assets/images/demo.gif
rm palette.png
git add -f .assets/images/demo.gif   # .assets/ is ignored
```

## Development conventions

### Code style

- TypeScript strict mode, ESM-only
- All TS imports use the `.js` extension (NodeNext module resolution)
- 400 and 800 lines per file are review guidelines, not hard limits; split a file only when its responsibilities or maintenance cost justify it
- Immutable patterns; avoid bare `any`
- Use Zod for external input validation
- See domain-specific rules in [`reference/`](./reference/)

### Testing

New features and bug fixes should ship with tests. Each package uses vitest, and each run gets a temp directory of its own that is removed when the run ends (`useRunTempDir` in `vitest.base.ts`; a package's `vitest.config.ts` must import `vitest.base`):

```bash
pnpm check                                 # CI static checks and script regressions
pnpm deps:check                            # Fallow dependency and import checks
pnpm analyze                               # Fallow dead code, duplication, and complexity report
pnpm test                                  # everything
pnpm check:push                            # what the pre-push hook runs, on the committed HEAD
pnpm check:push --full                     # the same with every test suite
pnpm changelog:preview                     # the pending [Unreleased] section, from docs/changelog.d/
pnpm --filter @covel/runtime test          # single package
pnpm test:pg                               # required PostgreSQL integration checks
pnpm e2e:smoke                             # deterministic CI Chromium flows
pnpm e2e:extensions                        # CI community plugin acceptance (third-party packages in an isolated home)
pnpm e2e                                   # Playwright end-to-end
```

`pnpm check` runs peer dependency, type, Oxlint, package boundary, dependency declaration, plugin manifest, schema reference, prompt variant, i18n, changelog fragment, script regression, and workflow checks. After changing an author-facing schema field, run `pnpm schemas:generate` to regenerate `packages/shared/schemas/*.json` and `docs/reference/schema/*.md`; every field must carry a `.describe()` text, and a missing description or a stale generated file fails the checks. Workflow validation requires `actionlint`, pinned in `mise.toml` to the version CI uses; `mise install` provides it. `pnpm lint` and `pnpm test` no longer build Web assets implicitly; run `pnpm build` separately to validate packaging.

Once installed, the hook checks every distinct, non-deleted committed tip in each `git push`, including refs other than the current HEAD. For each tip it makes a disposable clean clone and runs `pnpm install --frozen-lockfile` and `pnpm check`; a failure blocks the push. For source pushes the hook runs no test suite: CI runs every suite on the pull request in parallel jobs, and `main` takes changes through pull requests only. `pnpm check:push` on the committed HEAD, or `COVEL_PUSH_CHECK=affected git push`, adds the tests the change can break and `pnpm e2e --list`. Those tests are those of the packages changed since the branch left the remote's main branch (`origin/main`, fetched once when the clone has never seen it), the packages that depend on them (`turbo test --filter=...<package>`), and the suites whose `$TURBO_ROOT$` inputs in `turbo.json` name a changed file: a bundled plugin's files select the plugin-loader, runtime and server suites, and `worlds/**` or `prompts/**` select the suites that read them. Every suite runs when the change touches what every package reads (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `vitest.base.ts`, the root `package.json` and `tsconfig.json`, `mise.toml`) or a root file that no rule accounts for (the rules are `scripts/lib/push-scope.mjs`), when the push goes to `main` or is a tag, and when the remote's main branch cannot be determined. `COVEL_PUSH_CHECK=full git push` and `pnpm check:push --full` ask for every suite; `pnpm check:push --base <branch>` measures a stacked branch from the branch under it. The last two lines of the output say what ran and what is left to CI. The clone does not copy the working tree's `.env`, `node_modules`, or `test-results`, and the check removes `DATABASE_URL` / `COVEL_REQUIRE_PG_TESTS` to avoid connecting to a developer database. Turbo reads and writes the cache that every worktree of the repository shares (the main worktree's `.turbo/cache`), so a task replays when the pushed commit has the same tracked inputs as a run that already passed; a result that depended on a file Git ignores is what a replay cannot show, and CI covers it. Measured with an empty Turbo cache on a busy development machine: a one-line change in `apps/web` took 2 min 52 s, against 4 min 43 s with every suite; install, `pnpm check` and the E2E listing are about 85 s of either. A change in `packages/shared`, which every package depends on, selects every suite (4 min 22 s). With a warm cache the unchanged tasks replay; the store and server suites are never cached and now run only when the change selects them. When everything a push adds is documentation, the hook runs `pnpm check` and `pnpm test:docs:packages`; documentation script tests already ran in the former and are not repeated. Standalone `pnpm test:docs` still includes package and script tests. Historical commits use the documentation commands they provide. A new branch is measured from the remote's main branch. Documentation is `docs/**`, a root-level `*.md`, any `README.md` / `README.*.md`, a nested `AGENTS.md` / `CLAUDE.md`, `.claude/skills/**`, `.assets/**`, `LICENSE`, the issue and pull request templates; the list is `scripts/lib/change-scope.mjs`. Markdown that a loader reads (`PLUGIN.md`, `RUNTIME.md`, `WORLD.md`, the files under `prompts/`) is source and takes the full path. Run `pnpm check:push` to check the committed HEAD before pushing.

Explicit full runs and pushes to `main` or tags run every suite and collect E2E tests even for docs-only changes. An affected result is reused only for the same commit and resolved comparison base; a narrower `--base` check cannot replace a check measured from `origin/main`. Affected results can cover the same affected scope or static checks, but cannot replace docs-only checks; full results cover every scope. Recording a new result uses the same coverage rule to remove old results: different bases and documentation checks that do not cover each other can coexist for one commit.

`git push` connects to the remote before it runs the hook, and nothing travels on that connection while the hook works. A remote, a proxy or a NAT that closes idle connections then fails the push after the checks passed (`git push` exits with status 141: it wrote to a closed connection). The hook cannot keep that connection busy, so it does two things: it runs less, and it records each commit that passed, per worktree and for 12 hours. When the recorded result covers the requested checks, pushing the same commit again sends at once, and so does a push that follows `pnpm check:push`; for a change that needs every suite, run `pnpm check:push --full` first and push afterwards. `ServerAliveInterval 30` for the host in `~/.ssh/config` also keeps an SSH connection from looking idle to a proxy.

This check collects E2E tests but does not run the test suites the push did not change, PostgreSQL integration, browser smoke, or release/build packaging checks. Run `pnpm test:pg`, `pnpm e2e:smoke`, `pnpm e2e`, `pnpm build`, and release checks explicitly when relevant, and rely on CI for the complete gate.

[Fallow](https://github.com/fallow-rs/fallow) is installed as a root dev dependency, replacing Knip. `deps:check` fails on unused dependencies, unlisted dependencies, and unresolved imports. `analyze` provides the full report for reviewed cleanup without gating on every finding. `.fallowrc.jsonc` declares file-based routes, dynamically loaded plugins, and manual scripts; update it when adding such entry points to avoid false positives. The tool version follows the workspace's seven-day minimum release age.

`pnpm test:pg` reads `DATABASE_URL` from the environment or root `.env` and requires the five live-PG Store files (`pg-store`, `pg-schema-version`, `vector-store`, `media-store`, `schema-ddl-codegen`) and all Server `tests/integration` to run, without repeating the other Store files. A missing or unreachable database, or missing pgvector extension, fails the command. Ordinary Store and Server tests also receive explicitly supplied database environment variables. These two suites bypass Turbo caching because database state is external to source inputs. Other cached tasks invalidate when shared TypeScript configuration changes, and tests that read framework prompts also track `prompts/**`.

`pnpm test:coverage` runs two coverage commands sequentially: `test:coverage:vitest` always reruns the Vitest workspaces and generates reports in each package's `coverage/` using its configured reporters; `test:coverage:desktop` runs all desktop Node tests and self-checks and writes per-process raw V8 coverage to `apps/desktop/coverage/` for separate analysis, outside the Vitest percentage. [`ci.yml`](../.github/workflows/ci.yml) enforces a coverage floor for `@covel/runtime` only: `pnpm test:coverage:runtime` runs its tests with coverage and fails under the `thresholds` in `packages/runtime/vitest.config.ts`. The floor sits a few points under the measured values, to catch a drop; raise it when coverage rises. For the other packages the ≥ 80% target remains aspirational.

PRs, main, and releases use [`ci.yml`](../.github/workflows/ci.yml), without a separate Docs verification workflow. Every scope runs the complete `pnpm check`. Docs-only then runs `pnpm test:docs:packages`; source, mixed, unknown-scope, and release requests run every suite. Classification reuses the pre-push `scripts/lib/change-scope.mjs`. Package tests that read documentation must be listed in `test:docs:packages`, enforced by `scripts/tests/change-scope.test.mjs`.

The full path preserves parallel jobs: `verify` runs every suite except Web, server, and runtime; Web runs independently; server has its own runner and runs runtime with coverage and its enforced floor, the only runtime run in CI; PostgreSQL and Chromium have separate jobs. The browser job collects all E2E tests to catch broken imports, then runs smoke and `pnpm e2e:extensions` with one install and Chromium. Chromium downloads are cached by Playwright version; system packages are installed each time.

Full non-release checks run `pnpm build --cache=local:r --filter=!@covel/docs --filter=!@covel/site`, reading Turbo cache without writing build outputs back. CI calls Site to build the showcase and documentation in parallel through Turbo; docs-only changes must pass this job too. Matching inputs restore existing outputs, and the Site job must still succeed. Standalone `pnpm build` still builds every target. Turbo evicts local cache entries through `turbo.json` `cacheMaxAge` (7 days) and `cacheMaxSize` (2GB). CI tightens these to 2 days and 500MB through `TURBO_CACHE_MAX_AGE` / `TURBO_CACHE_MAX_SIZE` because actions/cache restores and saves the whole directory.

Each main push has its own CI concurrency group, so a later source-only push cannot replace a pending documentation deployment. Non-PR build-only Site runs also use separate groups and cannot displace a pending deployment. Eligible deployments still share a group by branch, preserving Site's existing pending-run replacement behavior. New PR commits still cancel older runs.

Scope selection fetches full commit and tree history only when comparing a PR or main push; release and explicit-commit requests select full scope directly and use a shallow checkout. Scope selection, result aggregation, and the merge gate sparsely check out only their control scripts. Checkout filters blobs to avoid downloading unrelated historical file contents or materializing the entire working tree. Control scripts still come from the workflow's own revision.

Turbo, Electron, Chromium, and Site task caches each use one restore step. Normal PR/main runs save under the original key returned by restore only after the job succeeds and the exact key was not found. Failed or cancelled jobs do not save, and PR caches retain GitHub's ref isolation. Releases and explicit commits may execute arbitrary source, so they must not save files produced by that execution into the workflow ref's caches: these tasks only restore, and setup-node's pnpm cache is disabled. Explicit commits also reach non-release Site builds, whose task caches likewise only restore.

Desktop backends use bundled Electron with RunAsNode; standalone Node is no longer downloaded, packaged, or cached. Electron download caches are keyed by OS, architecture, and lockfile; releases can reuse existing caches, but a miss downloads again without saving. Build and release verification still check target and actual Electron/Node versions, the RunAsNode fuse, and the binding between the main-process bundle and ASAR resources.

Releases always run the full test path and `pnpm release:preflight`, without Site or workspace Build; platform packaging jobs build desktop themselves. Lockfile validation uses a temporary metadata directory without modifying workspace dependencies or running install scripts. The release caller declares the Pages/OIDC permission ceiling required by nested workflows, but CI limits executing release verification jobs to `contents: read` and skips the Pages-capable Site job.

The Windows release job runs desktop regression tests and verifies the Electron backend from a ZIP extracted into a path with spaces and Chinese characters, recording artifact and extracted ZIP sizes. It also launches the actual ZIP and self-extracting EXE, checking native preparation feedback, a visible app window, world selection and the session-start button, and process-tree exit. It needs an unlocked interactive Windows desktop; unavailable observation fails rather than falling back to API or renderer screenshots. Native screenshots and logs upload separately from release assets. Packaging PRs must name the platforms actually exercised; adding a workflow is not passing Windows verification.

`Verification` aggregates selected jobs, including Site on every non-release CI run: missing, skipped, failed, or cancelled required jobs cannot pass. `main` takes changes through pull requests only. Each PR's [`gate.yml`](../.github/workflows/gate.yml) supplies `All checks pass`, requiring successful `Verification` while preserving failures from other checks. Rerun this gate after rerunning a failed check.

### Framework / plugin isolation (important)

Framework code (`packages/`, `apps/server/src/`, `apps/web/src/`) **must not** reference any specific plugin ID or plugin name. Plugins are discovered through versioned contracts (`provides` / `requires`), extension points, and registered services, and output is dispatched on `outputKind`. See the [Framework–Plugin Isolation Rule in AGENTS.md](../AGENTS.md#framework--plugin-isolation-rule).

### Documentation sync

Any change that affects framework capabilities must update the corresponding doc in [`reference/`](./reference/). PRs that don't sync docs are considered incomplete.

## Commits and pull requests

### Commit messages

Follow Conventional Commits:

```
<type>(<scope>): <subject>

<body>
```

Common types: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`.

### Pull requests

1. Branch off `main` into a feature branch
2. Open a PR targeting `main` after pushing
3. Wait for the pre-push static gate, then make sure CI is green; run the relevant database or UI checks separately
4. Describe **why** the change exists and **how to verify** it
5. For a change a user, author or operator can notice, add a changelog fragment `docs/changelog.d/<slug>.md` ([format](./changelog.d/README.md)); do not edit `docs/CHANGELOG.md`, which the release script writes
6. For breaking changes, add a `BREAKING CHANGE:` footer and a `### Breaking` entry in the fragment

## Release process

Use the [desktop release checklist](./internals/desktop-packaging.md#release-checklist) as the single operational checklist:

1. Prepare versions, CHANGELOG and docs on a development branch. `pnpm release:prepare <version>` (`--dry-run` first) sets the version in the root, `apps/*` and `packages/*` manifests and in the README badges, and writes the version's section of `docs/CHANGELOG.md` from the fragments in `docs/changelog.d/`, deleting them; it needs a clean tree and makes no commit. Add the summary paragraph and the README upgrade sentence by hand. Root, `apps/*` and `packages/*` versions must match the target tag; plugin and world packages may version independently.
2. Complete local `pnpm check`, `pnpm test`, `pnpm test:pg`, UI/E2E checks and `pnpm release:preflight` sequentially, then exercise the [real-model player flow](./internals/e2e-testing.md#发版前的玩家流程验收) with isolated data.
3. Push the PR after local checks pass. Wait for CI / PostgreSQL integration and a `Build Desktop` dry run on the candidate branch (`publish_release=false`).
4. Merge the PR, verify checks and the exact commit on `main`, then create and push an annotated `v*` tag on that commit.
5. The [release workflow](../.github/workflows/release.yml) validates the immutable commit, framework versions and release notes, then builds and verifies macOS arm64 / Windows x64 artifacts before publishing. Download the assets to check versions, digests, startup and plugin lifecycle.

Record the platforms and flows actually exercised; a successful build is not an interactive playthrough. Release notes must disclose unsigned artifacts and the absence of macOS notarization.

Desktop runtime or packaging changes must also verify the installer's own Electron RunAsNode: check target and actual Electron/Node versions, architecture, fuses, and main/ASAR binding, then use it to boot the SQLite backend and confirm sqlite-vec and built-in plugins are available. Host Node or the memory backend is not a substitute. Check readiness, settings reads/writes, recovery, and shutdown; see the desktop packaging guide.

### Showcase site deployment

Every non-release CI run calls [`site.yml`](../.github/workflows/site.yml); it no longer responds independently to pushes or pull requests. It builds the showcase site in `apps/site` and the documentation site in `apps/docs` (pages in `docs/`), placing documentation under the showcase site's `docs/` path. PRs only build: they neither upload a deployment artifact nor deploy. A `main` push deploys to GitHub Pages only when it changes the site, documentation, or related root build/install configuration; unrelated source changes only build. Deployment selection and test scope share one git diff. Unknown changes conservatively select deployment, still restricted to a `main` push. The inputs are listed in `scripts/ci-scope.mjs`. Manual Site runs from the Actions tab deploy by default; disable `deploy` to validate the build without publishing.

The repository's Settings > Pages must have "GitHub Actions" as its source. The site is served at `https://ackness.github.io/covel/`; PRs use `/covel/`, while other builds read the path from Pages settings and pass it to Vite as `SITE_BASE`, so a custom domain switches it to `/`. The documentation build reads the same variable and is served at `<SITE_BASE>docs/`. A dead documentation link fails the build. Reference files in `public/` through `asset()` (`apps/site/src/links.ts`) so their URLs include the prefix. Site runs the two independent targets in parallel with the command below, then copies `apps/docs/dist` into `apps/site/dist/docs`, first removing the old docs subtree. Turbo stores each output separately, excluding the assembled docs subtree from the showcase cache.

```bash
pnpm exec turbo build --filter=@covel/site --filter=@covel/docs --concurrency=2
```

Site has its own Turbo cache and reuses outputs by content: inputs cover each app's source and configuration, `docs/**`, `SITE_BASE`, `VITE_*`, build environment files, root installation configuration, lockfile, and toolchain. `docs/**` affects only the documentation target; unrelated framework source affects neither target. GitHub PR caches remain scoped to the PR ref and cannot be restored by deployments. Deployment consumes only the artifact built or restored for current inputs, assembled, and uploaded by that Site job; it does not download a deployment artifact from another workflow.

### Model data snapshot

The bundled LiteLLM model table (`packages/ai-provider/data/model-db.json`, pinned to a commit by `model-db-source.json`) supplies context windows, output limits, and prices for models whose limits are not set in `llm.toml` or Settings. Every Monday, [`update-model-db.yml`](../.github/workflows/update-model-db.yml) pins it to the newest LiteLLM commit that changed the model table, regenerates the snapshot and the record of which reasoning levels each model name is offered (`tests/__snapshots__/reasoning-characterization.snap.txt`), runs the `@covel/ai-provider` tests, and opens or refreshes a pull request from `chore/update-model-db`; it never pushes to `main`, and it can also be run from the Actions tab. Pull requests opened with the default `GITHUB_TOKEN` do not trigger other workflows: add a `MODEL_DB_PR_TOKEN` secret that may open pull requests to get CI automatically, or close and reopen the PR. The default token also needs "Allow GitHub Actions to create and approve pull requests" in the repository settings. To update by hand, run `pnpm --filter @covel/ai-provider update-model-db`. The table only says whether a model reasons; which levels it takes is hand-maintained data the refresh does not touch, see [reasoning level data](./reference/slots.md#档位数据).

### Code signing

Official releases intentionally use unsigned artifacts and require no platform signing credentials. Release notes must disclose this and explain that macOS Gatekeeper or Windows SmartScreen may warn on first launch. Enabling signing later requires changing the electron-builder configuration and release workflow together; local signing setup is documented in [`guide/desktop-packaging.md`](./internals/desktop-packaging.md).

## Reporting issues

Use the bug report or feature request form in [Issues](https://github.com/ackness/covel/issues). Questions about using Covel, and ideas that are not yet a request, go to [Discussions](https://github.com/ackness/covel/discussions). Report a vulnerability privately as [`SECURITY.md`](../SECURITY.md) describes.

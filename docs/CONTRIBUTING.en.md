# Contributing to Covel

Thanks for considering contributing! This document outlines the process for contributing code, issues, and documentation.

> 🇨🇳 [中文版本](./CONTRIBUTING.md)

> Root README: [`../README.md`](../README.md).

## Development environment

- Node.js ≥ 26
- pnpm 11.22.0 (see the root `package.json` `packageManager`)
- Optional: Docker (for PostgreSQL mode)

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # server and storage settings
cp llm.toml.example llm.toml   # configure LLM slots
cp .env.llm.example .env.llm   # fill in API keys
pnpm dev                       # start frontend + backend
```

### PostgreSQL 18 development environment

Create the root `.env` as above and keep `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, and `DATABASE_URL` consistent. Starting only the database does not require the Docker app's operator token:

```bash
pnpm db:up
pnpm dev:pg                    # PostgreSQL-backed API server
```

On first initialization, wait for the database to become ready before running `dev:pg`; check for `healthy` with `docker compose -f docker/docker-compose.yml --env-file .env ps postgres`. For the frontend, run `pnpm dev:web` in another terminal. `dev:pg` loads the root `.env` before checking the host/port from `DATABASE_URL`; without a URL, it checks `127.0.0.1:POSTGRES_PORT`. Update the URL when changing the port. See the [environment loading rules](./guide/env-registry.md#加载路径与环境差异) for overrides.

Compose uses PostgreSQL 18 with pgvector 0.8.6 and stores the database in `pgdata18`. The previous PG17 `pgdata` volume is not mounted, automatically migrated, or deleted.

`pnpm docker:build` builds and starts **both the database and the app**. The app uses the `commercial` configuration and also requires `COVEL_DESKTOP_REST_TOKEN`, `COVEL_MEDIA_TOKEN_SECRET`, and `CORS_ORIGIN` in `.env`, plus the root `llm.toml`. The `appdata` volume persists installed/generated user worlds and plugins; model configuration remains a read-only host mount. See [Docker configuration](./guide/env-registry.md#docker-compose).

`pnpm docker:down` stops containers and preserves data. **`pnpm docker:down-all` deletes the current Compose project's `pgdata18` and `appdata`, including the database, user worlds, and plugins**; use it only after backing up and choosing to reset the entire environment. `db:generate` / `db:studio` are PostgreSQL maintenance tools, not automatic database upgrades; see [database maintenance](./guide/env-registry.md#数据库维护命令).

### Homepage demo media

Install FFmpeg first. Run these commands from the repository root to update the homepage video, poster, and README GIF:

```bash
pnpm --filter @covel/web build:media
# Replace recording.mp4 with an existing source file.
node apps/web/scripts/build-media.mjs ./recording.mp4 --speed 3
```

The default source search is `.assets/demo.dev1.mp4`, `.assets/demo.dev0.mp4`, then `.assets/images/demo.gif`. A missing explicit path fails immediately. Outputs are `apps/web/public/media/demo.mp4`, `demo-poster.jpg`, and `.assets/images/demo.gif`. Existing assets are replaced only after all conversions finish; conversion failures preserve them and clean up temporary files. An existing output can also be the input. Relative paths passed through `pnpm --filter @covel/web build:media` are relative to `apps/web/`; direct Node invocation uses the current directory.

## Development conventions

### Code style

- TypeScript strict mode, ESM-only
- All TS imports use the `.js` extension (NodeNext module resolution)
- Aim for ≤ 400 lines per file; hard cap at 800
- Immutable patterns; avoid bare `any`
- Use Zod for external input validation
- See domain-specific rules in [`reference/`](./reference/)

### Testing

New features and bug fixes should ship with tests. Each package uses vitest:

```bash
pnpm test                                  # everything
pnpm --filter @covel/runtime test          # single package
pnpm e2e                                   # Playwright end-to-end
```

Coverage target: ≥ 80% (`pnpm test:coverage`) — aspirational for now; [`ci.yml`](../.github/workflows/ci.yml) does not yet enforce a coverage threshold.

### Framework / plugin isolation (important)

Framework code (`packages/`, `apps/server/src/`, `apps/web/src/`) **must not** reference any specific plugin ID or plugin name. Plugin capabilities are discovered via `RuntimeManifest.capabilities` and `outputKind`. See the [Framework–Plugin Isolation Rule in CLAUDE.md](../CLAUDE.md).

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
3. Make sure CI is green; run `pnpm lint` and `pnpm test` locally first
4. Describe **why** the change exists and **how to verify** it
5. For breaking changes, add a `BREAKING CHANGE:` footer

## Release process

Use the [desktop release checklist](./guide/desktop-packaging.md#release-checklist) as the single operational checklist:

1. Prepare versions, CHANGELOG and docs on a development branch. Root, `apps/*` and `packages/*` versions must match the target tag; plugin and world packages may version independently.
2. Complete local `pnpm lint`, `pnpm test`, UI/E2E checks and `pnpm release:preflight` sequentially, then exercise the [real-model player flow](./guide/e2e-testing.md#发版前的玩家流程验收) with isolated data.
3. Push the PR after local checks pass. Wait for CI / PostgreSQL integration and a `Build Desktop` dry run on the candidate branch (`publish_release=false`).
4. Merge the PR, verify checks and the exact commit on `main`, then create and push an annotated `v*` tag on that commit.
5. The [release workflow](../.github/workflows/release.yml) validates the immutable commit, framework versions and release notes, then builds and verifies macOS arm64 / Windows x64 artifacts before publishing. Download the assets to check versions, digests, startup and plugin lifecycle.

Record the platforms and flows actually exercised; a successful build is not an interactive playthrough. Release notes must disclose unsigned artifacts and the absence of macOS notarization.

### Code signing

Official releases intentionally use unsigned artifacts and require no platform signing credentials. Release notes must disclose this and explain that macOS Gatekeeper or Windows SmartScreen may warn on first launch. Enabling signing later requires changing the electron-builder configuration and release workflow together; local signing setup is documented in [`guide/desktop-packaging.md`](./guide/desktop-packaging.md).

## Reporting issues

Use the appropriate template in [Issues](https://github.com/AcKnEsS/covel/issues) to file bug reports or feature requests.

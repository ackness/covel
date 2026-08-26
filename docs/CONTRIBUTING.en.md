# Contributing to Covel

Thanks for considering contributing! This document outlines the process for contributing code, issues, and documentation.

> 🇨🇳 [中文版本](./CONTRIBUTING.md)

> Root README: [`../README.md`](../README.md).

## Development environment

- Node.js ≥ 26
- pnpm 11.22.0 (see the root `package.json` `packageManager`)
- Optional: Docker (for PostgreSQL mode)

```bash
pnpm install
cp llm.toml.example llm.toml   # configure LLM slots
cp .env.llm.example .env.llm   # fill in API keys
pnpm dev                       # start frontend + backend
```

### PostgreSQL 18 development environment

Docker Compose uses PostgreSQL 18 with pgvector 0.8.6 and stores data in the
new `pgdata18` volume. The previous PG17 `pgdata` volume is not mounted,
migrated, or deleted; the first `pnpm docker:build` after this upgrade creates
an empty PG18 development database.

To rebuild the current PG18 development database, run the commands below.
`docker:down-all` deletes the current Compose project's `pgdata18` volume and
all of its data, but does not delete the old `pgdata` volume:

```bash
pnpm docker:down-all
pnpm docker:build
```

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

Covel releases are driven by Git tags.

1. All changes merged into `main` with green CI
2. Add a `## [<version>] - YYYY-MM-DD` section at the top of [`CHANGELOG.md`](./CHANGELOG.md)
3. Unify version numbers across workspace packages (semver: `0.0.1-beta` / `0.1.0` / `1.0.0` …)
4. Run release preflight, commit, and tag:

   ```bash
   pnpm release:preflight
   git commit -am "chore(release): v0.0.4"
   git tag -a v0.0.4 -m "Covel v0.0.4"
   git push origin main
   git push origin v0.0.4
   ```

5. [`.github/workflows/release.yml`](../.github/workflows/release.yml) will, on any `v*` tag push:
   - Validate the tag, immutable commit SHA, workspace versions, CHANGELOG, and release gates
   - Build and verify Electron macOS arm64 `.dmg` / `.zip` and Windows x64 `.exe` artifacts
   - Sign and notarize macOS artifacts and Authenticode-sign Windows artifacts
   - Extract the matching release notes from `docs/CHANGELOG.md`
   - Publish or update the GitHub Release only after every gate passes

6. Open the Releases page and verify the published release notes and assets

### Code signing (required for publication)

- macOS: configure `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` in repository Secrets
- Windows: configure `WIN_CSC_LINK` (`.pfx`) and `WIN_CSC_KEY_PASSWORD`; `WIN_CSC_TIMESTAMP_SERVER` is optional

The release workflow fails when any required credential is absent and never publishes unsigned artifacts. Local non-publishing builds may remain unsigned. See [`guide/desktop-packaging.md`](./guide/desktop-packaging.md).

## Reporting issues

Use the appropriate template in [Issues](https://github.com/AcKnEsS/covel/issues) to file bug reports or feature requests.

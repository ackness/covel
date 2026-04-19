# Contributing to Covel

Thanks for considering contributing! This document outlines the process for contributing code, issues, and documentation.

> 🇨🇳 [中文版本](./CONTRIBUTING.md)

> Root README: [`../README.md`](../README.md).

## Development environment

- Node.js ≥ 20.19
- pnpm 10.7+
- Optional: Docker (for PostgreSQL mode and E2E testing)

```bash
pnpm install
cp llm.toml.example llm.toml   # configure LLM slots
cp .env.llm.example .env.llm   # fill in API keys
pnpm dev                       # start frontend + backend
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

Coverage target: ≥ 80% (`pnpm test:coverage`).

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
2. Update the `[Unreleased]` section at the top of [`CHANGELOG.md`](./CHANGELOG.md) (located under `docs/`) and migrate it to the new version
3. Unify version numbers across workspace packages (semver: `0.0.1-beta` / `0.1.0` / `1.0.0` …)
4. Commit and tag:

   ```bash
   git commit -am "chore(release): v0.0.1-beta"
   git tag v0.0.1-beta
   git push origin main --tags
   ```

5. [`.github/workflows/release.yml`](../.github/workflows/release.yml) will, on any `v*` tag push:
   - Build `.dmg` / `.zip` on a macOS runner (arm64 + x64)
   - Build NSIS installer and portable `.exe` on a Windows runner
   - Aggregate artifacts into a draft GitHub Release

6. Open the Releases page, review the draft, edit release notes, and publish

### Code signing (optional)

- macOS: configure `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in repository Secrets, and enable notarize in `apps/desktop/electron-builder.yml`
- Windows: configure `CSC_LINK` (`.pfx`) and `CSC_KEY_PASSWORD` in Secrets

Unsigned artifacts are marked as such, and operating systems will warn on first run. See [`apps/desktop/PACKAGING.md`](../apps/desktop/PACKAGING.md).

## Reporting issues

Use the appropriate template in [Issues](https://github.com/AcKnEsS/covel/issues) to file bug reports or feature requests.

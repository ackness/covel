# Repository Guidelines

## Project Structure & Module Organization

Covel is a pnpm/Turborepo TypeScript modular monolith: plugins carry gameplay logic, while the kernel supplies primitives and orchestration. Deployable targets live in `apps/`: `web` is the React/Vite client, `server` is the Hono API, and `desktop` is the Electron shell. Shared framework code belongs in `packages/`. Each `plugins/<name>/` package requires `PLUGIN.md` and `package.json`; optional capabilities live in `prompts/`, `schemas/`, `server/`, `client/`, `ui/`, or `tests/`. World content and shared prompts live in `worlds/` and `prompts/`. Keep maintained documentation in `docs/` and temporary plans, audits, or handoff notes in `devs/docs/`. Unit tests are colocated in workspace `tests/` or `__tests__/`; browser flows live in `tests/e2e/`.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile` installs the Node 26+/pnpm 11.22 workspace.
- `pnpm dev` starts the Vite client and API server; `pnpm build` builds all Turbo targets.
- `pnpm lint` runs workspace TypeScript checks; `pnpm format` applies Prettier.
- `pnpm test` runs all Vitest suites; target one package with `pnpm --filter @covel/runtime test`.
- `pnpm e2e` runs Playwright; use `pnpm db:up` before PostgreSQL-backed tests.

## Coding Style & Architecture Rules

Use strict TypeScript and ESM. Follow Prettier output (two-space indentation, double quotes, semicolons) and include `.js` extensions in TypeScript relative imports for NodeNext resolution. Use `camelCase` for values/functions, `PascalCase` for types and React components, and kebab-case module names. Avoid bare `any`; validate external input with Zod. Aim for at most 400 lines per file; 800 is the hard limit.

Framework code in `packages/`, `apps/server/src/`, and `apps/web/src/` must not branch on concrete plugin IDs. Discover behavior through manifest `capabilities` and `outputKind`. Update the matching `docs/reference/` page whenever a framework-visible contract changes.

## Testing Guidelines

Name Vitest files `*.test.ts` or `*.test.tsx` and Playwright files `*.spec.ts`. Add focused regression tests for features and fixes. The coverage goal is at least 80% (`pnpm test:coverage`), but CI does not currently enforce it.

## Commit & Pull Request Guidelines

Use Conventional Commits, for example `fix(web): stabilize session restore`; common types include `feat`, `fix`, `refactor`, `docs`, `test`, and `chore`. Branch from and target `main`. Complete the PR template with rationale, verification, related context, and documentation updates. Run `pnpm lint` and `pnpm test`; include `pnpm e2e` for UI or end-to-end changes. Mark breaking changes with a `BREAKING CHANGE:` footer.

## Configuration & Security

Copy `.env.example`, `.env.llm.example`, and `llm.toml.example` for local setup. Never commit provider keys, generated local data, or machine-specific configuration.

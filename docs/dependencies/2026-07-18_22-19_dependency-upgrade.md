# Dependency upgrade plan (2026-07-18)

## Goal

Move the workspace to the newest stable dependency set that satisfies the repository's seven-day release-age policy, migrate pnpm 10 to pnpm 11, and preserve web, server, desktop, plugin, and storage behavior.

## Scope

- Audit every external dependency declared by the root, `apps/*`, `packages/*`, and `plugins/*` manifests.
- Compare declared and locked versions with current stable upstream releases.
- Review major-version migration guides and peer/runtime compatibility for frontend, server/data, build/test, and Electron/native modules.
- Update manifests, `pnpm-lock.yaml`, package-manager configuration, affected code/configuration, and documentation.
- Apply a new upstream feature only when it removes existing custom work or materially improves correctness, security, or maintenance with focused validation.

## Assumptions

- `minimumReleaseAge: 10080` remains the dependency-supply-chain policy; releases younger than seven days are intentionally excluded from this upgrade.
- Node.js 22 remains the minimum supported runtime because CI and Docker use Node 24/22 and pnpm 11 requires Node 22 or newer.
- Existing uncommitted user changes, if any appear during execution, are preserved.
- The current lockfile is the reproducibility baseline; dependency resolution must be performed by pnpm rather than hand-editing resolved package metadata.

## Risks

- pnpm 11 removes `onlyBuiltDependencies`; an incorrect `allowBuilds` migration can prevent `better-sqlite3` or `esbuild` installation.
- Electron and `better-sqlite3` cross Node/Electron ABI boundaries and require desktop staging/rebuild validation.
- Zod, Drizzle, Hono, React, Vite, Vitest, and json-render changes can alter types or runtime behavior even in minor releases.
- pnpm 11 changes configuration lookup, store format, security defaults, and lifecycle-script enforcement; CI, Docker, and standalone plugin configuration must be audited.
- The execution sandbox cannot reach the npm registry directly. Upstream versions are researched through primary documentation, while lockfile regeneration requires locally available package artifacts or a reachable registry outside the sandbox.

## Steps

1. Inventory unique direct dependencies and record declaration, locked version, package owner, runtime surface, and native/peer constraints.
2. Query current stable releases and official migration notes; classify updates as patch/minor, major, or intentionally deferred by the seven-day gate.
3. Migrate `packageManager` from pnpm 10 to the current stable pnpm 11 and convert `onlyBuiltDependencies` to `allowBuilds`.
4. Apply compatible dependency updates by risk group: tooling, frontend, server/data, then Electron/native modules.
5. Regenerate the lockfile with the pinned pnpm version; inspect peer warnings, lifecycle-script approvals, and unexpected transitive churn.
6. Apply the smallest required compatibility fixes and selected low-risk upstream features.
7. Run focused checks first, then full format, dependency hygiene, typecheck, tests, build, release preflight, and desktop-specific verification where the environment permits.

## Validation

- `pnpm install --frozen-lockfile` succeeds with the pinned pnpm version after lockfile generation.
- `pnpm format:check`
- `pnpm deps:check`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm check:i18n`
- `pnpm release:preflight`
- Desktop staging/build checks for Electron and `better-sqlite3`; PostgreSQL and browser E2E checks are run when their external services/binaries are available.

## Implemented baseline

| Area                    | Selected stable baseline                                                             | Compatibility action                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Runtime/package manager | Node `>=22.19.0`, pnpm `11.9.0`                                                      | Migrated native build approval to `allowBuilds`; retained the seven-day release gate.                    |
| Compiler/test           | TypeScript `7.0.2`, Vitest/coverage `4.1.10`                                         | Upgraded `i18next` to `26.3.6` and `react-i18next` to `17.0.9` so their peer ranges accept TypeScript 7. |
| Web/build               | Vite `8.1.4`, Tailwind `4.3.2`, eligible TanStack Router releases                    | Replaced Vite's compatibility alias `rollupOptions` with `rolldownOptions`.                              |
| UI/test hygiene         | Eligible Radix packages, `@radix-ui/react-slot 1.3.0`, `@testing-library/dom 10.4.1` | Removed the unused Radix umbrella package and declared Testing Library's required peer directly.         |
| Server/HTTP             | Hono `4.12.29`, `@hono/node-server 2.0.8`, Undici `8.6.0`                            | Raised the Node floor required by Undici 8 and retained the existing DNS-safe custom dispatcher path.    |
| Desktop                 | Electron `43.1.0`, `@electron/rebuild 4.2.0`, electron-builder `26.15.6`             | Kept the explicit Electron binary materialisation and native-module rebuild flow.                        |
| Cleanup                 | `smol-toml 1.7.0`; current stable patch releases across the workspace                | Removed the deprecated, unreferenced optional `langfuse` dependency.                                     |

Versions with a newer npm release inside the seven-day quarantine window are pinned exactly. Workspace overrides keep the transitive Vite toolchain on `rolldown 1.1.4` and `tsx 4.22.4` for the same reason. `knip 6.25.0` is the sole eligible direct update left deferred: its `6.26.0` native OXC binding metadata/tarballs were unavailable in the restricted local cache, so a reproducible frozen lockfile could not be produced for it.

Observed validation in the restricted environment:

- pnpm 11 lockfile-only resolution completed for all 40 workspace projects and 848 locked packages.
- `pnpm peers check` reported no peer dependency issues.
- Manifest/importer consistency, JSON/YAML parsing, `git diff --check`, and plugin-template generation passed.
- A full frozen install reused 631 cached packages, then stopped because registry access is blocked and `@vitest/utils 4.1.10` was not present in the local tarball cache. The partial `node_modules` and temporary stores were removed; a networked `pnpm install --frozen-lockfile` is required before lint, tests, builds, Electron ABI verification, and E2E.

## Networked validation follow-up (2026-07-18)

Completing the deferred networked validation surfaced four issues the
restricted environment could not detect; all are fixed in this change set:

1. **Supply-chain policy violation in the lockfile.** The offline resolution
   locked transitive `@tanstack/router-core@1.171.15` (published 2026-07-13,
   inside the seven-day window) because publish timestamps were unavailable.
   Added a workspace override pinning `@tanstack/router-core: 1.171.14`
   (2026-07-01, the exact version `@tanstack/react-router 1.170.17` itself
   depends on) and re-resolved the lockfile.
2. **`allowBuilds` migration missed `electron-winstaller`.** pnpm 11 hard-fails
   on build scripts that are neither allowed nor denied (pnpm 10 silently
   ignored unlisted ones). Declared `electron-winstaller: false` to preserve
   the pnpm 10 behavior (its script never ran and Windows packaging works
   without it).
3. **Radix umbrella-to-package migration broke `Button asChild`.**
   `@radix-ui/react-slot` exports `Root` as a sibling alias of `Slot`, not as a
   property (`Slot.Root` is `undefined` → React crash when `asChild` is set).
   Fixed `button.tsx` to render `Slot` directly.
4. **Prettier 3.9.5 formatting drift.** `pnpm format` re-formatted 80 files so
   `format:check` passes in CI.

Validation results on a networked machine (macOS, Node 26.5): frozen install
passes the supply-chain policy (901 entries) with better-sqlite3 / esbuild /
electron builds approved; `pnpm peers check`, full `pnpm lint` (TypeScript 7,
21 tasks), full `pnpm test` (40 tasks, includes ai-provider's 239 tests
exercising the Undici 8 pinned-dispatcher path), `pnpm format:check`,
`pnpm deps:check`, `pnpm check:i18n`, `pnpm release:preflight`, and the Vite 8
web production build (manualChunks honored under `rolldownOptions`) all pass.
Electron 43.1.0 binary materialises and runs (ABI 148).

Known pre-existing issue (not caused by this upgrade): the web main chunk
bundles the full `lucide-react` icon set (~1.2 MB raw) because
`right-panel.tsx` resolves plugin icons via a namespace import with dynamic
property access, which defeats tree-shaking under both Rollup and Rolldown.

## Rollback

Revert only the files changed by this upgrade: dependency manifests, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, focused compatibility changes, and these planning artifacts. Restore `packageManager: pnpm@10.33.2` together with `onlyBuiltDependencies` if the pnpm 11 migration cannot pass frozen install and native-module verification.

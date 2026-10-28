# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Security releases bypass the normal seven-day window; keep tag and digest aligned.
FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS base
RUN apk add --no-cache libc6-compat libstdc++
# Node 25+ no longer bundles Corepack. Pin both the shim and pnpm payload so
# builds cannot drift and the non-root runtime never downloads a package
# manager on first start. Keep pnpm aligned with package.json.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack
RUN npm i -g corepack@0.36.0 \
    && corepack enable pnpm \
    && corepack install --global pnpm@12.14.0 \
    && chmod -R a+rX /opt/corepack
WORKDIR /app

# ── Stage 1: Copy workspace manifests (cached by lockfile + manifests) ───
FROM base AS workspace-manifests
RUN apk add --no-cache --virtual .build-deps python3 make g++
# Every workspace importer declared in pnpm-lock.yaml must have its manifest
# present for --frozen-lockfile to succeed. Stable Dockerfile 1.27 supports
# `--parents`, which preserves workspace paths without a drifting member list.
COPY --parents pnpm-lock.yaml package.json pnpm-workspace.yaml apps/*/package.json packages/*/package.json plugins/*/package.json ./
# The root preinstall guard is local and lockfile-independent; it must be
# present before either dependency install runs.
COPY scripts/require-pnpm.mjs scripts/require-pnpm.mjs

# ── Stage 2a: Dev dependencies for the web build ──────────────────
FROM workspace-manifests AS dev-deps
RUN --mount=type=cache,id=covel-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm exec node scripts/require-pnpm.mjs \
    && pnpm install --frozen-lockfile --ignore-scripts

# ── Stage 2b: Production dependencies for the runtime image ────────
FROM workspace-manifests AS prod-deps
# SQLite is `node:sqlite`, built into Node, and tsx resolves esbuild's
# platform package directly, so no package script needs to run. Disable them,
# then verify both runtime paths explicitly.
RUN --mount=type=cache,id=covel-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm exec node scripts/require-pnpm.mjs \
    && pnpm install --prod --frozen-lockfile --ignore-scripts \
    && pnpm --filter @covel/store exec node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.prepare('select 1').get();db.close()" \
    && pnpm --filter @covel/server exec tsx --eval "const value: number = 1; if (value !== 1) process.exit(1)"

# ── Stage 3: Build web frontend (static assets) ─────────────────────
FROM dev-deps AS build-web
COPY tsconfig.json turbo.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @covel/plugin-handlers-utils build
# TanStack Router generates routeTree.gen.ts during vite build,
# but tsc -b runs first and fails without it. Skip tsc in Docker
# (the dev workflow already catches type errors).
RUN cd apps/web && pnpm exec vite build

# ── Stage 4: Production runtime ─────────────────────────────────────
FROM prod-deps AS production
RUN apk del .build-deps

# Root tsconfig (needed by workspace packages)
COPY tsconfig.json ./

# Workspace packages (TS source — no build step, tsx handles runtime transpilation)
COPY packages/ packages/
COPY --from=build-web /app/packages/plugin-handlers-utils/dist/ packages/plugin-handlers-utils/dist/

# Server source
COPY apps/server/src/ apps/server/src/
COPY apps/server/tsconfig.json apps/server/

# Plugins (loaded by plugin-loader at startup)
COPY plugins/ plugins/

# Externalized prompt templates (loaded by @covel/context at runtime)
COPY prompts/ prompts/

# World packages (seed data loaded on first startup)
COPY worlds/ worlds/

# Product presets are declarative files loaded at runtime.
COPY packs/ packs/

# Model slot config. llm.toml is gitignored, so it is never in a CI/Render
# build context — it is supplied at runtime by the compose mount (or any
# bind-mount to /app/llm.toml); absent, the server boots on built-in defaults.
# The server resolves ./llm.toml from its cwd (/app/apps/server), hence the
# explicit override.
ENV COVEL_LLM_TOML=/app/llm.toml

# Built web static assets
COPY --from=build-web /app/dist/web apps/server/web-dist/

WORKDIR /app/apps/server

# sqlite-vec's Linux binaries use glibc fortified symbols. Preload the Alpine
# compatibility library so SQLite can dlopen the extension under musl.
ENV LD_PRELOAD=/lib/libgcompat.so.0
ENV NODE_ENV=production
ENV SERVE_STATIC=true
ENV STATIC_DIR=./web-dist
EXPOSE 3001

RUN mkdir -p /app/apps/server/data /home/node/.covel/worlds /home/node/.covel/plugins \
    && chown -R node:node /app/apps/server/data /home/node/.covel
USER node

# Verify the same non-root, offline runtime used at startup, including vectors.
RUN --network=none node --input-type=module -e "import { createRequire } from 'node:module'; import { DatabaseSync } from 'node:sqlite'; const require = createRequire(new URL('../../packages/store/package.json', import.meta.url)); const db = new DatabaseSync(':memory:', { allowExtension: true }); require('sqlite-vec').load(db); db.prepare('select vec_version()').get(); db.close();"

# One Node process with tsx as its loader. `pnpm exec tsx` adds a pnpm process
# and a tsx CLI process around the server (about 100 MB more at idle), which
# matters on small instances such as Render's free plan, and they stand
# between the container's signals and the server's graceful shutdown.
CMD ["node", "--import", "tsx", "src/index.ts"]

# node:26-alpine (26.5.0-alpine3.24 as of 2026-07-21) — pinned by digest so
# the base image can't silently drift; bump the digest (and this comment)
# when intentionally upgrading Node.
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS base
RUN apk add --no-cache libc6-compat libstdc++
RUN corepack enable pnpm
WORKDIR /app

# ── Stage 1: Copy workspace manifests (cached by lockfile + manifests) ───
FROM base AS workspace-manifests
RUN apk add --no-cache --virtual .build-deps python3 make g++
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./

# Apps (every workspace importer declared in pnpm-lock.yaml must have its
# manifest present for --frozen-lockfile to succeed, even if we don't
# actually use the app in the final image)
COPY apps/desktop/package.json apps/desktop/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Packages (alphabetical — keep in sync with packages/ directory)
COPY packages/ai-provider/package.json packages/ai-provider/
COPY packages/approval/package.json packages/approval/
COPY packages/context/package.json packages/context/
COPY packages/create/package.json packages/create/
COPY packages/events/package.json packages/events/
COPY packages/memory/package.json packages/memory/
COPY packages/plugin-handlers-utils/package.json packages/plugin-handlers-utils/
COPY packages/plugin-loader/package.json packages/plugin-loader/
COPY packages/plugin-test-utils/package.json packages/plugin-test-utils/
COPY packages/runtime/package.json packages/runtime/
COPY packages/settings/package.json packages/settings/
COPY packages/shared/package.json packages/shared/
COPY packages/state/package.json packages/state/
COPY packages/store/package.json packages/store/
COPY packages/test-runtime/package.json packages/test-runtime/
COPY packages/tools/package.json packages/tools/

# Plugins (workspace members, need manifests for pnpm install)
COPY plugins/branch-reply/package.json plugins/branch-reply/
COPY plugins/char-creator/package.json plugins/char-creator/
COPY plugins/character-blueprint/package.json plugins/character-blueprint/
COPY plugins/character-presence/package.json plugins/character-presence/
COPY plugins/chat-mode-narrator/package.json plugins/chat-mode-narrator/
COPY plugins/codex/package.json plugins/codex/
COPY plugins/cost-gate/package.json plugins/cost-gate/
COPY plugins/director/package.json plugins/director/
COPY plugins/guide/package.json plugins/guide/
COPY plugins/living-world-rules/package.json plugins/living-world-rules/
COPY plugins/memory/package.json plugins/memory/
COPY plugins/narrator/package.json plugins/narrator/
COPY plugins/npc-graph/package.json plugins/npc-graph/
COPY plugins/player-identity/package.json plugins/player-identity/
COPY plugins/pregame/package.json plugins/pregame/
COPY plugins/scene-cast/package.json plugins/scene-cast/
COPY plugins/scene-prompts/package.json plugins/scene-prompts/
COPY plugins/scene-stage/package.json plugins/scene-stage/
COPY plugins/story-guard/package.json plugins/story-guard/
COPY plugins/world-init/package.json plugins/world-init/

# ── Stage 2a: Dev dependencies for the web build ──────────────────
FROM workspace-manifests AS dev-deps
RUN pnpm install --frozen-lockfile

# ── Stage 2b: Production dependencies for the runtime image ────────
FROM workspace-manifests AS prod-deps
RUN pnpm install --prod --frozen-lockfile

# ── Stage 3: Build web frontend (static assets) ─────────────────────
FROM dev-deps AS build-web
COPY tsconfig.json turbo.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
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

# Server source
COPY apps/server/src/ apps/server/src/
COPY apps/server/tsconfig.json apps/server/

# Plugins (loaded by plugin-loader at startup)
COPY plugins/ plugins/

# Externalized prompt templates (loaded by @covel/context at runtime)
COPY prompts/ prompts/

# World packages (seed data loaded on first startup)
COPY worlds/ worlds/

# llm.toml (model slot config, optional — mount or override at runtime)
COPY llm.toml* ./

# Built web static assets
COPY --from=build-web /app/dist/web apps/server/web-dist/

WORKDIR /app/apps/server

ENV NODE_ENV=production
ENV SERVE_STATIC=true
ENV STATIC_DIR=./web-dist
EXPOSE 3001

CMD ["pnpm", "exec", "tsx", "src/index.ts"]

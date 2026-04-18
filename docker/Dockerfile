FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ── Stage 1: Install dependencies (cached by lockfile + manifests) ───
FROM base AS deps
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./

# Apps
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Packages (alphabetical — keep in sync with packages/ directory)
COPY packages/ai-provider/package.json packages/ai-provider/
COPY packages/api-client/package.json packages/api-client/
COPY packages/approval/package.json packages/approval/
COPY packages/context/package.json packages/context/
COPY packages/create/package.json packages/create/
COPY packages/events/package.json packages/events/
COPY packages/lorebook/package.json packages/lorebook/
COPY packages/memory/package.json packages/memory/
COPY packages/plugin-loader/package.json packages/plugin-loader/
COPY packages/plugin-test-utils/package.json packages/plugin-test-utils/
COPY packages/runtime/package.json packages/runtime/
COPY packages/shared/package.json packages/shared/
COPY packages/state/package.json packages/state/
COPY packages/store/package.json packages/store/
COPY packages/tools/package.json packages/tools/

# Plugins (workspace members, need manifests for pnpm install)
COPY plugins/core-char-creator/package.json plugins/core-char-creator/
COPY plugins/core-codex/package.json plugins/core-codex/
COPY plugins/core-guide/package.json plugins/core-guide/
COPY plugins/core-narrator/package.json plugins/core-narrator/
COPY plugins/core-npc-graph/package.json plugins/core-npc-graph/
COPY plugins/core-pregame/package.json plugins/core-pregame/
COPY plugins/core-world-init/package.json plugins/core-world-init/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build web frontend (static assets) ─────────────────────
FROM deps AS build-web
COPY tsconfig.json turbo.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
# TanStack Router generates routeTree.gen.ts during vite build,
# but tsc -b runs first and fails without it. Skip tsc in Docker
# (the dev workflow already catches type errors).
RUN cd apps/web && pnpm exec vite build

# ── Stage 3: Production runtime ─────────────────────────────────────
FROM deps AS production

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

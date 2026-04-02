FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ── Stage 1: Install dependencies (cached by lockfile + manifests) ───
FROM base AS deps
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./

# Apps
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Packages
COPY packages/shared/package.json packages/shared/
COPY packages/ai-provider/package.json packages/ai-provider/
COPY packages/runtime/package.json packages/runtime/
COPY packages/context/package.json packages/context/
COPY packages/kernel/package.json packages/kernel/
COPY packages/plugin-runtime/package.json packages/plugin-runtime/
COPY packages/store/package.json packages/store/
COPY packages/plugin-test-utils/package.json packages/plugin-test-utils/

# Plugins (each has its own package.json)
COPY plugins/core-persona/package.json plugins/core-persona/
COPY plugins/core-narrator/package.json plugins/core-narrator/
COPY plugins/core-combat/package.json plugins/core-combat/
COPY plugins/core-init-wizard/package.json plugins/core-init-wizard/
COPY plugins/core-char-tracker/package.json plugins/core-char-tracker/
COPY plugins/core-guide/package.json plugins/core-guide/
COPY plugins/core-inventory/package.json plugins/core-inventory/
COPY plugins/core-quest/package.json plugins/core-quest/
COPY plugins/core-dice/package.json plugins/core-dice/
COPY plugins/core-memory/package.json plugins/core-memory/
COPY plugins/core-world-state/package.json plugins/core-world-state/

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

# Plugins (loaded by plugin-host at startup)
COPY plugins/ plugins/

# Built web static assets
COPY --from=build-web /app/apps/web/dist apps/server/web-dist/

WORKDIR /app/apps/server

ENV NODE_ENV=production
ENV SERVE_STATIC=true
ENV STATIC_DIR=./web-dist
EXPOSE 3001

CMD ["pnpm", "exec", "tsx", "src/index.ts"]

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
COPY packages/store/package.json packages/store/
COPY packages/plugin-loader/package.json packages/plugin-loader/
COPY packages/state/package.json packages/state/
COPY packages/events/package.json packages/events/
COPY packages/tools/package.json packages/tools/
COPY packages/approval/package.json packages/approval/

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

# Externalized prompt templates (loaded by @covel/context at runtime)
COPY prompts/ prompts/

# World packages (seed data loaded on first startup)
COPY worlds/ worlds/

# Built web static assets
COPY --from=build-web /app/dist/web apps/server/web-dist/

WORKDIR /app/apps/server

ENV NODE_ENV=production
ENV SERVE_STATIC=true
ENV STATIC_DIR=./web-dist
EXPOSE 3001

CMD ["pnpm", "exec", "tsx", "src/index.ts"]

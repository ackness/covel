FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ── Stage 1: Install dependencies (cached by lockfile + manifests) ───
FROM base AS deps
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ai-provider/package.json packages/ai-provider/
COPY packages/runtime/package.json packages/runtime/
COPY packages/kernel/package.json packages/kernel/
COPY packages/plugin-runtime/package.json packages/plugin-runtime/
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build web frontend (static assets) ─────────────────────
FROM deps AS build-web
COPY tsconfig.json turbo.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @covel/web build

# ── Stage 3: Production runtime ─────────────────────────────────────
# Reuse deps stage (node_modules already installed, including tsx)
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

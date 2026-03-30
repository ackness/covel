# Covel — AI RPG 插件式框架

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Monorepo** | pnpm workspaces + Turborepo |
| **Frontend** | Vite 8 + React 19 + TailwindCSS v4 + shadcn/ui |
| **Router** | TanStack Router |
| **i18n** | i18next + react-i18next |
| **Backend** | Hono |
| **ORM** | Drizzle ORM |
| **Queue** | pg-boss |
| **Database** | PostgreSQL 17 (Docker Compose) |
| **Validation** | Zod |
| **Language** | TypeScript |

## Project Structure

```
covel/
├── apps/
│   ├── web/          # Vite 8 + React 19 frontend
│   └── server/       # Hono API server
├── packages/
│   └── shared/       # Shared types & contracts
├── docker/
│   └── docker-compose.yml
├── docs/
│   └── system-architecture-v0/
├── .env.example
├── pnpm-workspace.yaml
└── turbo.json
```

## Getting Started

### Prerequisites

- Node.js >= 20.19.0
- pnpm >= 10.x
- Docker & Docker Compose

### Setup

```bash
# Install dependencies
pnpm install

# Copy env file
cp .env.example .env

# Start database
pnpm db:up

# Run migrations
pnpm db:migrate

# Start dev servers (web + server)
pnpm dev
```

### Ports

- **Web**: http://localhost:5173
- **API**: http://localhost:3001
- **PostgreSQL**: localhost:5432

### Database

```bash
pnpm db:up        # Start PostgreSQL
pnpm db:down      # Stop PostgreSQL
pnpm db:generate  # Generate migrations
pnpm db:migrate   # Run migrations
pnpm db:studio    # Open Drizzle Studio
```

## Architecture

See [docs/system-architecture-v0/](./docs/system-architecture-v0/) for the full architecture documentation.

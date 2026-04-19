# Covel

Plugin-driven AI interactive storytelling engine. The kernel provides execution primitives; plugins carry all gameplay logic.

> 🇨🇳 [中文版本](../README.md) · 📖 [Docs index / 中文文档索引](./README.md)

[![Version](https://img.shields.io/badge/version-v0.0.1--beta-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-≥20.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.7-f69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

---

Covel is a plugin platform designed for AI RPGs. Every turn follows a fixed priority pipeline (trigger → schedule → context assembly → LLM inference → proposal commit). All gameplay mechanics live in plugins that can be hot-swapped at runtime.

Supports DeepSeek · Qwen (DashScope) · OpenAI · Anthropic. Model routing is configured through `llm.toml` slots — no code changes required to switch models.

## Download

Pre-built desktop binaries are available on the [Releases](https://github.com/AcKnEsS/covel/releases) page:

| Platform | Installer | Architecture |
|---|---|---|
| macOS | `Covel-<version>-arm64.dmg` / `Covel-<version>-x64.dmg` | Apple Silicon / Intel |
| macOS | `Covel-<version>-arm64-mac.zip` / `Covel-<version>-x64-mac.zip` | Apple Silicon / Intel |
| Windows | `Covel Setup <version>.exe` | x64 / arm64 |
| Windows | `Covel-<version>-portable.exe` | x64 |

> On first launch you need to configure an LLM provider (enter an API key from the in-app settings page).

## Getting started (from source)

**Prerequisites:** Node.js ≥ 20.19, pnpm 10.7+

```bash
# Install dependencies
pnpm install

# Configure LLM (required)
cp llm.toml.example llm.toml    # fill in model IDs and endpoints
cp .env.llm.example .env.llm    # fill in provider API keys

# Start (in-memory store — no database needed)
pnpm dev
```

Open `http://localhost:5173`. Debug page is at `/debug`.

### Using PostgreSQL

```bash
cp .env.example .env
pnpm db:up       # start PostgreSQL container
pnpm dev:pg      # backend switches to pg store
pnpm dev:web     # run the frontend in another terminal
```

### Docker one-liner

```bash
cp .env.example .env
cp llm.toml.example llm.toml && cp .env.llm.example .env.llm

pnpm docker:build   # build + start (frontend + backend + PostgreSQL)
```

Once running, open `http://localhost:3001`.

### Build desktop locally

```bash
pnpm desktop:build   # build web + stage server resources
pnpm desktop:dist    # produce installer for current platform (release/)
```

See [`apps/desktop/PACKAGING.md`](../apps/desktop/PACKAGING.md) for signing and notarization details.

## Project structure

```
covel/
├── apps/
│   ├── web/          React 19 + Vite 8 + TanStack Router (includes plugin-driven UI)
│   ├── desktop/      Electron desktop app (wraps web + server)
│   └── server/       Hono API server + Drizzle ORM
├── packages/
│   ├── shared/            Shared types & contracts
│   ├── runtime/           Execution engine (LLM tool-calling loop + smart retry)
│   ├── context/           Context assembly (TurnContextStore + PromptAssembler)
│   ├── ai-provider/       Multi-provider LLM abstraction (2597-model capability DB)
│   ├── plugin-loader/     Plugin discovery + registry
│   ├── store/             Storage abstraction (Memory / SQLite / IndexedDB / PostgreSQL)
│   ├── tools/             Tool system (registry + builtins)
│   ├── lorebook/          World / session lorebook
│   ├── approval/          RPC approval pipeline
│   └── state / events / memory / plugin-test-utils
├── plugins/          Core plugins (pregame / narrator / codex / npc-graph / guide / ...)
├── worlds/           World packages (cloudmere / mistport / neonridge)
├── prompts/          Externalized prompt templates (locale-aware markdown)
└── docs/             Reference docs and developer guides
```

## Common commands

```bash
pnpm dev                   # frontend + backend
pnpm dev:pg                # backend (PostgreSQL mode)
pnpm build                 # build all packages
pnpm lint                  # type check
pnpm test                  # run all tests
pnpm e2e                   # Playwright E2E tests
pnpm desktop:dev           # desktop dev mode
```

## Documentation

| | |
|---|---|
| [API reference](./reference/api.md) | HTTP endpoints, request formats, curl examples |
| [Plugin registry](./reference/plugins.md) | All plugins, triggers, frontmatter fields |
| [Tool registry](./reference/tools.md) | Builtin + local tools |
| [Protocol](./reference/protocol.md) | SSE event types and envelopes |
| [UI panels](./reference/ui-panels.md) | Plugin-driven UI architecture (json-render) |
| [Plugin authoring guide](./guide/plugin-authoring.md) | Writing a plugin from scratch |

More: [`reference/`](./reference/) · [`guide/`](./guide/) · [`architecture/`](./architecture/).

## Releasing

Releases are driven by Git tags:

```bash
git tag v0.0.1-beta
git push origin v0.0.1-beta
```

Pushing a `v*` tag triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds Electron installers in parallel on GitHub-hosted macOS and Windows runners, then creates a draft GitHub Release. See [contributing guide · release process](./CONTRIBUTING.en.md#release-process).

## Contributing

Issues and pull requests are welcome. Please read [`CONTRIBUTING.en.md`](./CONTRIBUTING.en.md) first.

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md).

## License

[MIT](../LICENSE) © 2026 Covel Contributors

# Covel

> A plugin-driven AI text-adventure platform — every gameplay feature is an Agent.

[![Status](https://img.shields.io/badge/status-WIP-f59e0b)](https://github.com/AcKnEsS/covel)
[![Version](https://img.shields.io/badge/version-v0.0.1--beta-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-≥22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.7-f69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

![Covel demo](./.assets/images/demo.gif)

> English (current) · [中文](./README.md)
>
> ⚠️ **Work in Progress** — the project is in early `v0.0.x`. APIs, data formats, and plugin frontmatter fields may change in breaking ways from one version to the next. Not recommended for production.

---

## What is it

Covel is an LLM-powered **text-adventure platform** where every gameplay feature is expressed as a **plugin**.

Each plugin is an **autonomous Agent Runtime**: it decides when to trigger, which context slices to read, which tools to call, and what state to write. Narration, action guidance, NPC relationship graphs, codex, character creation, world init — each one is an independent plugin you can **install, remove, hot-swap, or write yourself**.

Ships with 8 first-party plugins — playable out of the box, and useful as a starting point for your own.

## Features

- **Plugin = Agent** — each plugin declares its own trigger rules, context injections, tool list, and write agent; LLM scheduling is entirely plugin-driven
- **Multi-provider LLM** — DeepSeek · Qwen (DashScope) · OpenAI · Anthropic, routed via `llm.toml` slots with no code changes
- **Multi-backend storage** — MemoryStore (dev) · IndexedDB (browser) · SQLite (desktop) · PostgreSQL (prod), behind one contract
- **Three deployment modes** — Web / Electron / Tauri (the latter two share the same Node sidecar; Tauri ships a smaller bundle)
- **File-based world packages** — `world.yaml` + `WORLD.md`; dimensions can be auto-extracted by the LLM
- **Declarative UI via json-render** — plugins describe panels and message blocks with JSON specs; no React code required
- **Graph-RAG memory** — NPC relationship extraction + 2-hop retrieval + three-tier memory (Core / Recall / Archival)
- **Browser-held API keys** — kept in localStorage and forwarded per request via `X-Provider-Keys`; never persisted on the server

## Showcase

| World picker | Main narrative + plugin messages | Debug page: Turn / Prompt / Trace |
|:-:|:-:|:-:|
| ![](./.assets/images/select.png) | ![](./.assets/images/session.jpg) | ![](./.assets/images/debugger.png) |

## Quick Start

### End users · Download the desktop build

> ⚠️ The project is very early. Prebuilt binaries on [Releases](https://github.com/AcKnEsS/covel/releases) **may be taken down or reset at any time**. If you want to track the project long-term, prefer the source-build path.

Only **macOS arm64** (Apple Silicon) prebuilds are provided right now. Two shell flavours are published:

| Shell | Installer | Recommended | Notes |
|------|-----------|:-:|-------|
| **Electron** | `Covel-electron-<version>-mac-arm64.dmg` | ⭐ | More feature-complete; this is what we develop and debug against daily |
| Tauri | `Covel-tauri_<version>_aarch64.dmg` | | Smaller bundle, native WebView — experimental |

Both share the same Node sidecar and backend; data is interchangeable. On first launch go to **Settings** and paste your LLM API key. Windows and Intel Mac builds are not provided yet — build from source (see the next section) if you need them.

Desktop config — `~/.covel/`, `config.toml`, `keys.env`, `llm.toml` details — see [`docs/guide/desktop-config.en.md`](./docs/guide/desktop-config.en.md).

### Developers · Run from source

**Prerequisites**: Node.js ≥ 22, pnpm 10.7+.

```bash
pnpm install
cp llm.toml.example llm.toml        # fill model IDs and endpoints
cp .env.llm.example .env.llm        # fill provider API keys
pnpm dev                            # frontend 5173 + backend 3001 (in-memory store)
```

Open `http://localhost:5173`; the debug page is at `/debug`.

To switch to PostgreSQL: `cp .env.example .env && pnpm db:up && pnpm dev:pg && pnpm dev:web` (backend in a second terminal).

### Self-host · Docker one-liner

```bash
cp .env.example .env
cp llm.toml.example llm.toml && cp .env.llm.example .env.llm
pnpm docker:build   # build and start frontend + backend + PostgreSQL
```

Then open `http://localhost:3001`.

### Build the desktop shells locally

```bash
pnpm dev:electron      # Electron shell with hot reload (dev)
pnpm dev:tauri         # Tauri shell with hot reload (dev)
pnpm build:electron    # Current-platform Electron installer → release/
pnpm build:tauri       # Current-platform Tauri installer   → release/
pnpm build:desktop     # Produce both in sequence
```

Signing & notarisation: [`apps/desktop/PACKAGING.md`](./apps/desktop/PACKAGING.md).

## Writing a plugin

A minimal plugin is `PLUGIN.md` + `package.json`. Frontmatter declares the trigger, context injections, and tool list; the markdown body is the LLM agent skill prompt.

```yaml
---
name: my-plugin/main
priority: 500
model: plugin
trigger:
  type: scheduled
  interval: 1
tools:
  builtin: [create-form, plugin-data-set]
---

You are an XXX agent. On this turn you need to…
```

Full tutorial: [Plugin authoring guide](./docs/guide/plugin-authoring.md).
Reference: [Plugin registry](./docs/reference/plugins.md) · [Tool registry](./docs/reference/tools.md).

## Project structure

```
covel/
├── apps/
│   ├── web/              React 19 + Vite 8 frontend (with json-render plugin panels)
│   ├── server/           Hono API + Drizzle ORM
│   ├── desktop/          Electron shell
│   └── desktop-tauri/    Tauri shell
├── packages/             Internal packages (shared / runtime / context / ai-provider / …)
├── plugins/              Core plugins (narrator / codex / npc-graph / char-creator / …)
├── worlds/               World packages (cloudmere / mistport / neonridge)
├── prompts/              Externalised prompt templates
└── docs/                 Reference docs and developer guides
```

Full package list and dependency graph: [`CLAUDE.md`](./CLAUDE.md#monorepo-structure).

## Documentation

| Role | Entry points |
|------|--------------|
| **Understand the project** | [Architecture flow](./docs/architecture/flow.md) · [`CLAUDE.md`](./CLAUDE.md) |
| **Write a plugin** | [Plugin authoring guide](./docs/guide/plugin-authoring.md) · [Plugin registry](./docs/reference/plugins.md) · [Tool registry](./docs/reference/tools.md) |
| **Talk to the API** | [API reference](./docs/reference/api.md) · [Protocol](./docs/reference/protocol.md) |
| **Build UI** | [UI panel architecture](./docs/reference/ui-panels.md) · [Prompt structure](./docs/reference/prompt-structure.md) |
| **Run desktop builds** | [Desktop config](./docs/guide/desktop-config.en.md) · [Packaging](./apps/desktop/PACKAGING.md) |
| **Release / Contribute** | [CONTRIBUTING](./docs/CONTRIBUTING.en.md) · [CHANGELOG](./docs/CHANGELOG.md) |

Full index: [`docs/README.md`](./docs/README.md) (Chinese).

## Roadmap

- ✅ Plugin system + 8 core plugins + json-render UI architecture
- ✅ Multi-provider / multi-storage / dual desktop shells (Electron + Tauri)
- 🚧 Long-session context budget and smart truncation
- 🚧 Keyword-triggered lorebook scanning with Reserved Tokens budgeting
- 📋 Character Card V2/V3 import/export (SillyTavern / RisuAI interop)
- 📋 Cross-session long-term memory (embedding / vector recall)

Detailed improvement assessment: [`devs/docs/insights/covel-improvement-plan.md`](./devs/docs/insights/covel-improvement-plan.md).

## Contributing

Issues and pull requests are welcome. Please read [`CONTRIBUTING.en.md`](./docs/CONTRIBUTING.en.md) first.

Releases are driven by Git tags: pushing a `v*` tag triggers [`.github/workflows/release.yml`](./.github/workflows/release.yml), which builds Electron + Tauri arm64 dmgs on macOS runners and produces a draft GitHub Release. Windows / Intel Mac / Linux prebuilds are not provided.

## License

[MIT](./LICENSE) © 2026 Covel Contributors

# Covel

A next-generation agent-orchestration platform for AI role-playing games. Gameplay mechanics — narration, NPC relationships, codex, character creation — are each written as an independent plugin agent. **Plugins are the features.**

[![Version](https://img.shields.io/badge/version-v0.0.1--beta-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

English · [中文](./README.md)

![Covel demo](./.assets/images/demo.gif)

> The project is in a very early stage. Features are not stable, and **APIs, data formats, and plugin frontmatter fields will break between versions**. Only local usage is supported right now, and the only prebuilt binary is a macOS Apple Silicon test build. Don't keep anything important in it.

## Why

Most AI-RPG tools today (SillyTavern, RisuAI, assorted ChatBot shells) are built around a single LLM call: character cards, lorebooks, and prompt templates are assembled into one big request and sent off. Covel takes a different approach — each gameplay mechanic is a **standalone agent** that decides when it fires, which slices of context to read, which tools to call, and what state to write. A single turn can chain several agents together.

Two things follow from this:

- Features live in plugins rather than being baked into the kernel. Narration, action guidance, NPC graphs, world knowledge, character creation — all are independent packages you can install, remove, or swap.
- RPG complexity accumulates in plugins instead of in a single monster system prompt. Each agent only cares about its own slice.

## What's in the repo

Eight core plugins to start from:

| Plugin | Role |
|--------|------|
| `core-narrator` | Main narration |
| `core-guide` | Action guidance and option generation |
| `core-npc-graph` | NPC relationship extraction + 2-hop retrieval |
| `core-codex` | World-knowledge codex |
| `core-char-creator` | Character-creation flow |
| `core-world-init` | World dimension initialisation |
| `core-pregame` | Pre-game bootstrap (pure-function plugin, no LLM call) |
| `core-memory` | Memory panel (UI-only plugin) |

Plus three sample world packs: `cloudmere`, `mistport`, `neonridge`.

The minimal plugin is `PLUGIN.md` + `package.json`. Frontmatter declares the trigger, context injections, and tool list; the markdown body is the agent's skill prompt. Tools can be built-in (forms, state writes, record appends, …) or custom JS tools.

## Screenshots

| World picker | Main narrative + plugin messages | Debug: Turn / Prompt / Trace |
|:-:|:-:|:-:|
| ![](./.assets/images/select.png) | ![](./.assets/images/session.jpg) | ![](./.assets/images/debugger.png) |

## Try it

Only a **macOS arm64** (Apple Silicon) Electron prebuilt test build is available right now — grab `Covel-electron-<version>-mac-arm64.dmg` from [Releases](https://github.com/AcKnEsS/covel/releases). After installing, open Settings and paste your LLM API key to get going.

Windows / Intel Mac / Linux aren't officially shipped — build from source if you want them. The Tauri shell is on hold for now (toolchain issues) and no longer published.

Desktop-build data dir, `config.toml`, `keys.env`, `llm.toml` details: [`docs/guide/desktop-config.en.md`](./docs/guide/desktop-config.en.md).

> The project is still early. Builds on Releases **may be pulled, reset, or reformatted at any time**. Use the source path if you want a stable target.

## Run from source

Prerequisites: Node.js ≥ 22, pnpm 10+.

```bash
pnpm install
cp llm.toml.example llm.toml        # model IDs and endpoints
cp .env.llm.example .env.llm        # provider API keys
pnpm dev                            # frontend 5173 + backend 3001, SQLite by default (./data/covel.db)
```

Open `http://localhost:5173`; the debug page is at `/debug`. To skip persistence (process exit wipes everything), set `STORE_BACKEND=memory` in `.env`.

### Build the desktop shell locally

```bash
pnpm dev:electron      # Electron shell with hot reload
pnpm build:electron    # Current-platform Electron installer → release/
```

Signing and notarisation details: [`apps/desktop/PACKAGING.md`](./apps/desktop/PACKAGING.md).

## Writing a plugin

Minimal example:

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

Full walkthrough: [Plugin authoring guide](./docs/guide/plugin-authoring.md). Existing plugins are good references too — see the [`plugins/`](./plugins/) directory, or [plugin registry](./docs/reference/plugins.md) and [tool registry](./docs/reference/tools.md).

## Repo layout

```
covel/
├── apps/
│   ├── web/              Frontend (React 19 + Vite)
│   ├── server/           Backend (Hono + Drizzle)
│   └── desktop/          Electron shell
├── packages/             Internal packages (runtime / context / ai-provider / store / memory / tools / …)
├── plugins/              Core plugins
├── worlds/               World packs
├── prompts/              Externalised prompt templates
└── docs/                 Reference docs and author guides
```

Monorepo managed with pnpm workspaces + Turborepo. Full package list and dependency graph: [`CLAUDE.md`](./CLAUDE.md#monorepo-structure).

## Documentation

- Architecture overview: [`docs/architecture/flow.md`](./docs/architecture/flow.md)
- Writing plugins: [`docs/guide/plugin-authoring.md`](./docs/guide/plugin-authoring.md)
- Plugin / tool registries: [`docs/reference/plugins.md`](./docs/reference/plugins.md) · [`docs/reference/tools.md`](./docs/reference/tools.md)
- API and protocol: [`docs/reference/api.md`](./docs/reference/api.md) · [`docs/reference/protocol.md`](./docs/reference/protocol.md)
- Desktop config: [`docs/guide/desktop-config.en.md`](./docs/guide/desktop-config.en.md)

Full index (Chinese): [`docs/README.md`](./docs/README.md).

## Contributing

It's early days — issues and PRs are both welcome. Please read [`docs/CONTRIBUTING.en.md`](./docs/CONTRIBUTING.en.md) first.

Releases are driven by Git tags: pushing a `v*` tag triggers [`.github/workflows/release.yml`](./.github/workflows/release.yml), which builds the Electron arm64 dmg on a macOS runner and drafts a GitHub Release. No official builds for other platforms yet.

## License

[MIT](./LICENSE) © 2026 Covel Contributors

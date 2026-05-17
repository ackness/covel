# Covel

**A modern, agentic AI RPG. Customize every mechanic with a plugin.**

**English** · [简体中文](./README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-v0.0.2-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stage](https://img.shields.io/badge/stage-early--access-orange)]()

![Covel demo](./.assets/images/demo.gif)

> ⚠️ **Early access.** APIs, data formats, and plugin frontmatter may break between versions. Only macOS Apple Silicon prebuilt binaries ship today. Don't keep anything important in it yet.

---

## What is Covel

Covel is an AI-driven role-playing game where every gameplay mechanic — narration, NPC relationships, world lore, character creation, memory — runs as its own **autonomous agent**. A single turn can chain several agents together. Each agent is a plugin: install one, swap one, or write your own.

## See it in action

The gif above is one normal turn. While the narrator writes the scene, four other agents work in parallel:

- **Narrator + Guide** — drive the story and offer next actions
- **NPC Graph** — extracts relationships and surfaces who-knows-whom
- **Codex** — accumulates world lore as you play
- **Memory** — keeps long-range context across the session

Every agent is its own plugin. Disable one, swap one, or write your own.

## Quick start

### Play it

Grab the latest **macOS Apple Silicon** build from [Releases](https://github.com/AcKnEsS/covel/releases) — `Covel-electron-<version>-mac-arm64.dmg`.

Open Settings, paste an LLM API key, pick one of the four sample worlds (`cloudmere` / `mistport` / `neonridge` / `haruka-academy`), and play.

Your data lives at `~/.covel/` — config, keys, SQLite, custom worlds, logs. Full schema → [`docs/guide/desktop-config.en.md`](./docs/guide/desktop-config.en.md).

> Windows / Intel Mac / Linux are not officially shipped — build from source. Electron is the only desktop shell in the current codebase.

### Run from source

```bash
pnpm install
cp llm.toml.example llm.toml        # model IDs and endpoints
cp .env.llm.example .env.llm        # provider API keys
pnpm dev                            # web :5173 + server :3001 (SQLite)
```

Open <http://localhost:5173>; debug page at `/debug`.

Need PostgreSQL, in-memory mode, or alternative paths? See [`docs/guide/env-registry.md`](./docs/guide/env-registry.md).

## Make your own

You don't need to write code. This repo ships **two Claude Code skills** that turn a conversation into a working plugin or world pack:

- **`/create-plugin`** — describe the agent you want; the skill generates a `PLUGIN.md` (frontmatter + skill prompt) and a minimal `package.json`.
- **`/create-world`** — describe a setting; the skill produces `world.yaml`, `WORLD.md`, and `data/world.data.yaml` ready to drop into `~/.covel/worlds/`.

Open Claude Code in this repository, type `/create-plugin` or `/create-world`, and have a conversation.

> An official community for sharing plugins and world packs is on the roadmap. For now, share via Gist or fork.

## Develop

For hand-writing plugins, debugging the runtime, or extending the kernel.

### Bundled plugin packages

| Plugin                |   Kind   | Role                                           |
| --------------------- | :------: | ---------------------------------------------- |
| `branch-reply`        | Function | Reply candidates and accepted-variant storage  |
| `char-creator`        |  Mixed   | Player creation and character tracking         |
| `character-blueprint` | Function | Reusable character blueprints                  |
| `character-presence`  | Function | Character portraits, sprites, voice, and media |
| `chat-mode-narrator`  |  Agent   | Dialogue-focused narration                     |
| `codex`               |  Agent   | World-knowledge codex                          |
| `guide`               |  Agent   | Action guidance and option generation          |
| `living-world-rules`  | Function | Persistent world rules and lorebook projection |
| `memory`              |    UI    | Memory panel                                   |
| `narrator`            |  Agent   | Main traditional-story narration               |
| `npc-graph`           |  Mixed   | Relationship graph retrieval and extraction    |
| `player-identity`     | Function | Hero voice, goals, and boundaries              |
| `pregame`             | Function | Pre-game bootstrap                             |
| `scene-cast`          | Function | Current scene cast and active-speaker context  |
| `scene-prompts`       |  Agent   | Dialogue-mode short action prompts             |
| `world-init`          |  Mixed   | World schema and lore initialization           |

### Write a plugin manually

Minimum: `PLUGIN.md` + `package.json`. Frontmatter declares trigger and tools; the markdown body is the agent's skill prompt.

```yaml
---
name: my-plugin/main
priority: 500
model: plugin
trigger: { type: scheduled, interval: 1 }
tools:
  builtin: [create-form, plugin-data-set]
---
You are an XXX agent. On this turn you need to…
```

Full walkthrough → [Plugin authoring guide](./docs/guide/plugin-authoring.md). Existing plugins under [`plugins/`](./plugins/) are good references too. See also: [plugin registry](./docs/reference/plugins.md) · [tool registry](./docs/reference/tools.md).

### Repo layout

```
covel/
├── apps/
│   ├── web/              Frontend (React 19 + Vite)
│   ├── server/           Backend (Hono + Drizzle)
│   └── desktop/          Electron shell
├── packages/             Internal packages (runtime / context / ai-provider / store / memory / tools / …)
├── plugins/              Bundled plugin packages
├── worlds/               Sample world packs
├── prompts/              Externalised prompt templates
└── docs/                 Reference docs and author guides
```

pnpm workspaces + Turborepo · ESM-only · TypeScript strict. Full package list → [`CLAUDE.md`](./CLAUDE.md#monorepo-structure).

### Documentation

| Topic                        | Link                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Architecture & turn pipeline | [`docs/architecture/flow.md`](./docs/architecture/flow.md)                                                          |
| Writing plugins              | [`docs/guide/plugin-authoring.md`](./docs/guide/plugin-authoring.md)                                                |
| Plugin / tool registries     | [`docs/reference/plugins.md`](./docs/reference/plugins.md) · [`docs/reference/tools.md`](./docs/reference/tools.md) |
| API / SSE protocol           | [`docs/reference/api.md`](./docs/reference/api.md) · [`docs/reference/protocol.md`](./docs/reference/protocol.md)   |
| Desktop config               | [`docs/guide/desktop-config.en.md`](./docs/guide/desktop-config.en.md)                                              |
| Desktop packaging            | [`apps/desktop/PACKAGING.md`](./apps/desktop/PACKAGING.md)                                                          |

Full index → [`docs/README.md`](./docs/README.md). The in-app debug page at `/debug` shows session timeline, runtime traces, and prompt diffs.

## Roadmap

- Windows / Linux / Intel Mac builds
- Official community for sharing plugins and world packs
- Plugin marketplace inside the desktop app

## Contributing & releases

- Issues and PRs welcome — please read [`docs/CONTRIBUTING.en.md`](./docs/CONTRIBUTING.en.md) first.
- Releases are driven by Git tags: pushing a `v*` tag triggers [`.github/workflows/release.yml`](./.github/workflows/release.yml) to build the Electron arm64 installer on a macOS runner and publish a GitHub Release.

## License

[MIT](./LICENSE) © 2026 Covel Contributors

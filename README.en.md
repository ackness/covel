# Covel

**An agentic role-playing game framework.**
Narration, action guidance, NPC graphs, world lore, character cards — every gameplay mechanic is an **autonomous agent** that decides when to fire, what context to read, what tools to call, and what state to write. A single turn can chain several agents together.

[![Version](https://img.shields.io/badge/version-v0.0.1-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stage](https://img.shields.io/badge/stage-early--access-orange)]()

English · [中文](./README.md)

![Covel demo](./.assets/images/demo.gif)

> ⚠️ **Early access**: APIs, data formats, and plugin frontmatter fields will break between versions. Only macOS Apple Silicon prebuilt binaries are shipped right now. Don't keep anything important in it.

---

## What is Covel

Most AI-RPG tools today (SillyTavern, RisuAI, …) revolve around **a single LLM call** — character cards, lorebooks, and prompt templates are assembled into one big request and sent off.

Covel breaks that single call into an **Agentic Pipeline**:

```
Trigger → Priority Schedule → [Agent₁ → Agent₂ → … → Agentₙ] → Validate → Commit → SSE
                              ↑ Each agent decides its own trigger, context, tools, writes
```

**Result**: gameplay complexity accumulates in plugins instead of in a monster system prompt. Narration, NPC graphs, codex, character creation — all are independent packages you can install, remove, or swap.

## Quick start

### A. Try the prebuilt (macOS Apple Silicon)

Grab `Covel-electron-<version>-mac-arm64.dmg` from [Releases](https://github.com/AcKnEsS/covel/releases). After installing, open Settings and paste an LLM API key.

**Config files** (auto-created on first launch):

```
~/.covel/
├── config.toml      ← data dir pointer + log rotation
├── llm.toml         ← model / provider / baseUrl
├── keys.env         ← API keys (one KEY=VALUE per line, mode 0600)
└── data/
    ├── covel.db     ← SQLite
    ├── worlds/      ← custom worlds
    └── logs/        ← electron / server logs
```

The in-app Settings panel and these files stay in sync — pick whichever you prefer. Full schema → [`docs/guide/desktop-config.en.md`](./docs/guide/desktop-config.en.md).

### B. Run from source (Node ≥ 22, pnpm 10+)

```bash
pnpm install
cp llm.toml.example llm.toml        # model IDs and endpoints
cp .env.llm.example .env.llm        # provider API keys
pnpm dev                            # web :5173 + server :3001 (SQLite)
```

Open http://localhost:5173; debug page at `/debug`.

**Config locations** (**different** from the desktop build — don't mix them up):

| File | Location | Purpose |
|------|----------|---------|
| `llm.toml` | repo root | model slot config |
| `.env.llm` | repo root | provider API keys (loaded by the dev server) |
| Web LLM keys | `localStorage: covel:keys` | written from the browser Settings panel |
| Web user prefs | `localStorage: covel:settings` | same |
| SQLite | `./data/covel.db` | set `STORE_BACKEND=memory` for an in-memory store |

> Windows / Intel Mac / Linux are not officially shipped — build from source. The Tauri shell is on hold for now.

## Bundled plugins

| Plugin | Kind | Role |
|--------|:-:|------|
| `core-narrator`     | Agent    | Main narration |
| `core-guide`        | Agent    | Action guidance + option generation |
| `core-npc-graph`    | Agent    | NPC graph extraction + 2-hop retrieval |
| `core-codex`        | Agent    | World-knowledge codex |
| `core-char-creator` | Agent    | Character-creation flow |
| `core-world-init`   | Agent    | World-dimension initialisation |
| `core-pregame`      | Function | Pre-game bootstrap (no LLM call) |
| `core-memory`       | UI       | Memory panel |

Sample world packs: `cloudmere`, `mistport`, `neonridge`.

## Write a plugin

The minimal shape is `PLUGIN.md` + `package.json`. Frontmatter declares trigger and tools; the markdown body is the agent's skill prompt:

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

Full walkthrough → [Plugin authoring guide](./docs/guide/plugin-authoring.md)
Existing plugins are good references too → [`plugins/`](./plugins/) · [plugin registry](./docs/reference/plugins.md) · [tool registry](./docs/reference/tools.md)

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

pnpm workspaces + Turborepo · ESM-only · TypeScript strict
Full package list → [`CLAUDE.md`](./CLAUDE.md#monorepo-structure)

## Documentation

| Topic | Link |
|-------|------|
| Architecture & turn pipeline | [`docs/architecture/flow.md`](./docs/architecture/flow.md) |
| Writing plugins              | [`docs/guide/plugin-authoring.md`](./docs/guide/plugin-authoring.md) |
| Plugin / tool registries     | [`docs/reference/plugins.md`](./docs/reference/plugins.md) · [`docs/reference/tools.md`](./docs/reference/tools.md) |
| API / SSE protocol           | [`docs/reference/api.md`](./docs/reference/api.md) · [`docs/reference/protocol.md`](./docs/reference/protocol.md) |
| Desktop config               | [`docs/guide/desktop-config.en.md`](./docs/guide/desktop-config.en.md) |
| Desktop packaging            | [`apps/desktop/PACKAGING.md`](./apps/desktop/PACKAGING.md) |

Full index → [`docs/README.md`](./docs/README.md)

## Contributing & releases

- Issues and PRs welcome — please read [`docs/CONTRIBUTING.en.md`](./docs/CONTRIBUTING.en.md) first
- Releases are driven by Git tags: pushing a `v*` tag triggers [`.github/workflows/release.yml`](./.github/workflows/release.yml) to build the Electron arm64 installer on a macOS runner and publish a GitHub Release

## License

[MIT](./LICENSE) © 2026 Covel Contributors

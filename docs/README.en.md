# Covel

An LLM-powered text adventure platform, extended through plugins.

Each plugin is an Agent Runtime: it decides when to trigger, what context to read, which tools to call, and what state to write. Narration, NPC relationships, lore, characters, combat, image generation — each one is a separate plugin you can install, remove, hot-swap, or write yourself.

> 🇨🇳 [中文版本](../README.md) · 📖 [Docs index / 中文文档索引](./README.md)

[![Version](https://img.shields.io/badge/version-v0.0.1--beta-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-≥22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.7-f69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

---

Ships with first-party plugins — narrator, action guide, NPC relation graph, codex, character creator — playable out of the box, and useful as a starting point for your own.

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

## Config & data layout

On first launch the desktop app creates `~/.covel/` for config and `~/.covel/data/` for runtime data. The two are decoupled through `config.toml` — redirect the data root (SQLite, worlds, logs) to an external drive without touching the rest.

### Directory structure

```
~/.covel/                    ← config root (small, version-stable)
  config.toml                ← data_root pointer + log rotation params
  llm.toml                   ← LLM slot config (provider / model / baseUrl)
  keys.env                   ← provider API keys, plain KEY=VALUE lines
  plugins/                   ← user plugins (merged on top of bundled cores)

<data_root>/                 ← default ~/.covel/data; redirectable
  covel.db                   ← SQLite database
  worlds/                    ← user-created worlds
  logs/                      ← app logs (auto-rotated)
    tauri-main*.log          ← Tauri main process
    electron-*.log           ← Electron main process
    server-*.log             ← Node backend (pino-roll)
  server.port                ← last boot port (diagnostics)
```

### `~/.covel/config.toml`

Seeded with a commented template on first launch. Fields:

```toml
[paths]
# Data directory. Relative paths resolve against this file's directory;
# absolute paths are used as-is. Default: ~/.covel/data
# data_root = "/Volumes/External/covel-data"

[logging]
# Single log file cap (MB). Rolls over once exceeded.
max_size_mb = 10
# Retained rotated files. Oldest is dropped past this cap.
# Total disk usage ≈ max_size_mb × max_files.
max_files   = 10
```

Restart Covel after edits. **Changing `data_root` does NOT move old data** — the new location is empty; the old path is left intact for you to migrate manually (or ignore).

### `~/.covel/keys.env`

```env
# One KEY=VALUE per line; # lines are comments.
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

The server scans every `*_API_KEY` entry and injects it into the matching provider runtime. Key naming = provider name uppercase + `_API_KEY`. Saved by the app with mode `0600`; if you edit manually, don't loosen the permissions.

### `~/.covel/llm.toml`

See `llm.toml.example` at repo root. Each slot pairs a provider + model. The app ships a fallback `story` slot pointing at DeepSeek, so filling `DEEPSEEK_API_KEY` in `keys.env` is enough to boot.

### Frontend entry point

Settings → Desktop tab surfaces all the paths, opens folders in one click, and lets you change `data_root` with a picker — no need to hand-edit files unless you want to.

## Getting started (from source)

**Prerequisites:** Node.js ≥ 22, pnpm 10.7+

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

Two shells ship side by side: Electron (battle-tested) and Tauri (smaller/lighter).

```bash
# Dev (hot reload, launches the actual shell against the real sidecar)
pnpm dev:electron
pnpm dev:tauri
pnpm dev:web          # browser only, no shell

# Produce an installer in release/ for the current platform
pnpm build:electron
pnpm build:tauri
pnpm build:desktop    # both, back to back
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
pnpm dev:electron          # Electron shell (dev)
pnpm dev:tauri             # Tauri shell (dev)
pnpm build:electron        # produce Electron installer (release/)
pnpm build:tauri           # produce Tauri installer (release/)
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

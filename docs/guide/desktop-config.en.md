# Desktop config & data layout

Applies to both [`apps/desktop/`](../../apps/desktop/) (Electron) and [`apps/desktop-tauri/`](../../apps/desktop-tauri/) (Tauri). Both launchers boot the same Node sidecar bundle and feed it the same env-var contract documented below; the two implementations are mirrored and must stay in sync.

> **Recommended entry: Electron.** The Tauri shell now follows the same contract, but still has open compatibility issues around macOS multi-window, code signing, and `tauri-plugin-log` swap-out. **It is not an officially supported distribution channel today** — use `pnpm build:electron` artifacts for shipping; Tauri is for tinkerers only.

## Directory structure

On first launch the desktop app creates `~/.covel/`. Config, user plugins, and user worlds live here; the heavy bits (SQLite, logs) live in `~/.covel/data/` by default and can be redirected to an external drive — that way relocating data does not strand `worlds/` or `keys.env`.

```
~/.covel/                    ← config root (small, version-stable)
  config.toml                ← data_root pointer + log rotation params
  llm.toml                   ← LLM slot config (provider / model / baseUrl)
  keys.env                   ← provider API keys, plain KEY=VALUE lines
  plugins/                   ← user plugins (merged on top of bundled cores)
  worlds/                    ← user-created worlds (NOT under data_root, so
                               redirecting data_root does not strand them)

<data_root>/                 ← default ~/.covel/data; redirectable
  covel.db                   ← SQLite database
  logs/                      ← app logs (auto-rotated)
    tauri-main*.log          ← Tauri main process
    electron-*.log           ← Electron main process
    server-*.log             ← Node backend (pino-roll)
  server.port                ← last boot port (diagnostics)
```

## `~/.covel/config.toml`

Seeded with a commented template on first launch. Fields:

```toml
[paths]
# Data directory. Relative paths resolve against this file's directory;
# absolute paths are used as-is. Default: ~/.covel/data
# data_root = "/Volumes/External/covel-data"

[logging]
# Single log-file cap (MB). Rolls over once exceeded.
max_size_mb = 10
# Retained rotated files. Oldest is dropped past this cap.
# Total disk usage ≈ max_size_mb × max_files.
max_files   = 10
```

Restart Covel after edits. **Changing `data_root` does NOT move old data** — the new location starts empty, and the old path is left intact for you to migrate (or ignore).

## `~/.covel/keys.env`

```env
# One KEY=VALUE per line; # starts a comment.
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

The server scans every `*_API_KEY` entry and injects it into the matching provider runtime. Key naming = provider name uppercase + `_API_KEY`. Written with mode `0600` by the app; if you edit manually, don't loosen the permissions.

## `~/.covel/llm.toml`

See [`llm.toml.example`](../../llm.toml.example) at repo root. Each slot pairs a provider + model. The app ships a fallback `story` slot pointing at DeepSeek — filling `DEEPSEEK_API_KEY` in `keys.env` is enough to boot.

## Frontend entry point

**Settings → Desktop** tab surfaces every path, opens folders in one click, and lets you change `data_root` via a picker — no need to hand-edit files unless you want to.

## Related docs

- [README · Quick Start](../../README.en.md#quick-start) — download & first launch
- [apps/desktop/PACKAGING.md](../../apps/desktop/PACKAGING.md) — local desktop builds, signing, notarisation
- [reference/api.md](../reference/api.md) — backend API reference

# Desktop config & data layout

> 🇨🇳 [中文版本](./desktop-config.md)

Applies to [`apps/desktop/`](../../apps/desktop/) (Electron). The desktop shell boots the same Node sidecar bundle and feeds it the env-var contract documented below.

## Directory structure

On first launch the desktop app creates `~/.covel/`. Config and user plugins live here; the heavy bits (SQLite, logs, and user worlds) live in `~/.covel/data/` by default and can be redirected together.

```
~/.covel/                    ← config root (small, version-stable)
  config.toml                ← data_root pointer + log rotation params
  llm.toml                   ← LLM slot config (provider / model / baseUrl)
  keys.env                   ← provider API keys, plain KEY=VALUE lines
  settings.json              ← front-end preferences (unified SettingsStore: locale / appearance / slot overrides / per-plugin settings)
  plugins/                   ← user plugins (merged on top of bundled cores)

<data_root>/                 ← default ~/.covel/data; redirectable
  covel.db                   ← SQLite database
  worlds/                    ← user-created worlds
  logs/                      ← app logs (size-rotated, one NDJSON record per line)
    desktop.log              ← Electron main-process events
    server.log               ← Node sidecar stdout/stderr
    desktop.log.1 … .N       ← rotated copies, oldest dropped past max_files
    server.log.1 … .N
  server.port                ← last boot port (diagnostics)
```

Sidecar stderr is recorded as `error` by default. Recoverable framework warnings carry a `[covel:warn]` transport marker; collectors remove the marker and persist them at `warn`, so `policy: warn` scheduling diagnostics and automatic retries do not inflate error counts.

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

Restart Covel after edits. **Changing `data_root` does NOT move old data** — the new location starts empty, and the old data and user worlds are left intact for you to migrate or ignore.

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

- [README · Quick Start](../../README.md#quick-start) — download & first launch
- [apps/desktop/PACKAGING.md](../../apps/desktop/PACKAGING.md) — local desktop builds, signing, notarisation
- [reference/api.md](../reference/api.md) — backend API reference

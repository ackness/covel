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
  app-update.json            ← ignored desktop app release
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

The `/api/health` request is skipped by the Hono logger by default. Add
comma-separated paths with `COVEL_LOG_QUIET_PATHS`. Business traces (LLM,
proposal, and tool calls) stay in the `trace_events` database table rather
than these log files. When running `pnpm dev:server`, stdout/stderr is also
mirrored to `server.log`; set `COVEL_SERVER_LOG_FILE=""` to disable that
mirror or provide an explicit path to override it.

`settings.json` is atomically replaced through a same-directory temporary file and uses persistence `schemaVersion: 2` with a monotonic `revision`. A valid v1 bundle (which must contain object `entries`) is migrated in memory as revision 0 and written as v2 after the next successful save. Existing corrupt, unreadable, or future-version files are never treated as empty: reads fail with `settings_file_invalid`, and saves preserve the original file. Saves carry the loaded revision; an intervening write returns `409 settings_revision_conflict` without replacing the file. A failed initial read keeps SettingsStore read-only. An ordinary revision conflict instead loads and validates the latest snapshot, then compares each changed setting against its original value. Disjoint changes can be replayed under CAS; a conflict on the same key, including an entire object or array, is rejected and shown for review. Browser storage events, focus, and restored visibility refresh ordinary settings without reading or writing API keys. See the [SettingsStore contract](../reference/settings-store.en.md).

## `~/.covel/config.toml`

Seeded with a commented template on first launch. Fields:

```toml
schema_version = 1

[paths]
# Data directory. Relative paths resolve against this file's directory;
# absolute paths are used as-is. Default: ~/.covel/data
# data_root = "/Volumes/External/covel-data"

[network]
# direct | system | http | socks
proxy_mode = "direct"
# proxy_url = "http://127.0.0.1:7890"

[logging]
# Single log-file cap (MB). Rolls over once exceeded.
max_size_mb = 10
# Retained rotated files. Oldest is dropped past this cap.
# Total disk usage ≈ max_size_mb × max_files.
max_files   = 10
```

Legacy files without `schema_version` are read as v1. The desktop UI and REST endpoints patch only the known fields above while preserving unknown fields, unknown sections, and existing comments; the complete TOML is parsed strictly before and after every write. A malformed file does not block startup (defaults are used with a warning), but it is never overwritten and must be repaired manually. Successful writes use a same-directory temporary file plus atomic rename and set mode `0600`.

Manual edits require a Covel restart; saving under **Settings → Desktop → Network Proxy** applies immediately. `direct` bypasses proxies, `system` follows Electron's OS proxy resolution, `http` accepts HTTP(S) URLs, and `socks` accepts SOCKS5 URLs. A missing scheme is normalized to `http://` or `socks5://`. URLs may include `user:password@host`, so the file is tightened to mode `0600` when proxy settings are saved.

The proxy covers framework-owned LLM calls, GitHub model-database updates, and desktop app version checks. Third-party plugin `fetchWithRetry` remains direct with strict DNS/SSRF pinning.

## New-version prompt

Packaged desktop apps query the latest stable GitHub Release through `GET /api/app-update/latest` once per launch. The sidecar performs this request through the selected direct, system, HTTP(S), or SOCKS5 route. When the GitHub SemVer is newer, a platform-native dialog lets the player open the fixed Covel GitHub Releases page or ignore that version. Ignored versions are recorded in a separate `app-update.json`, avoiding SettingsStore revision conflicts, and remain quiet until a higher release appears. A failed check is logged without delaying startup, and no file is downloaded or installed automatically.

**Changing `data_root` does NOT move old data** — the new location starts empty, and the old data and user worlds are left intact for you to migrate or ignore.

## `~/.covel/keys.env`

```env
# One KEY=VALUE per line; # starts a comment.
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

The server scans every `*_API_KEY` entry and injects it into the matching provider runtime. Key naming = provider name uppercase + `_API_KEY`. Written with mode `0600` by the app; if you edit manually, don't loosen the permissions.

## `~/.covel/llm.toml`

See [`llm.toml.example`](../../llm.toml.example) at repo root. Each model role pairs a provider and model. The built-in fallback `story` role uses `deepseek-v4-flash`; filling `DEEPSEEK_API_KEY` in `keys.env` is enough to boot.

The model settings are split into **Model Roles**, **Providers & Models**, and **Generation**. The provider catalogue uses a list-and-detail layout: configure an endpoint, protocol, key, and price multiplier once, then bulk-add any number of opaque model IDs. IDs containing `/`, such as `openai/gpt-5.6-sol`, are sent unchanged. Assign the provider and model separately under Model Roles; creating a custom preset is no longer required. Price multipliers default to `1` and scale reference prices in the debug cost estimate.

Model settings persist `llm.providers` as the only source of truth. On startup, legacy `llm.customPresets` first migrates connection keys and model references and is removed only after every step succeeds. The legacy API facade and request custom-preset shape are compiled from providers instead of maintaining a second synchronized copy.

### Choose a plugin runtime model for one world or session

The **Model Roles** page maps each slot to the provider and model currently used on this device. For example, the `plugin` slot may resolve to `ali-coding-plan / qwen3.8-flash`. A plugin manifest declares only its default slot, such as `model: plugin`; it does not pin a concrete model inside the world package.

Each agent runtime can choose a slot in the **Session Prep** plugin list:

- **Runtime default: `plugin`** means there is no world-level override. The runtime follows the effective `plugin` assignment from Settings.
- Choosing another slot such as `story` or `fast` stores `runtimeId → slot` in the new session's `runtimeModelOverrides`. It affects only that session and does not modify the world package or global settings.
- Multi-runtime plugins show each qualified runtime ID, such as `char-creator/character-tracker`, and each runtime can be assigned independently.
- After the game starts, the slot can still be changed in the left-side plugin list. Covel persists it through `PATCH /api/sessions/:id`, and the next execution uses the new slot.

Default summaries and picker options show the slot, provider, and **effective model** together. `default: plugin` is the routing declaration; `ali-coding-plan · qwen3.8-flash` is the concrete target currently resolved on this device. Changing the `plugin` assignment in Settings therefore updates every runtime that still follows that slot without editing each world.

`runtimeModelOverrides` applies only to agent runtimes. Image, speech, and similar function runtimes commonly select a media provider slot through the plugin setting `modelPresetId`. Session Prep exposes that separately as a **provider slot** setting, persisted for this device rather than in the session runtime override map.

The LLM page can reload `llm.toml` without restarting through `POST /api/llm-config/reload`. Parse errors fall back to the built-in `story` slot and are exposed in `GET /api/llm-config` and the Settings UI.

Plugins such as image generation may declare a `modelPresetId` provider slot. If its default slot is missing but another compatible slot is configured, Session Prep lets you override the **provider slot** inline; the warning clears as soon as a configured slot is selected.

## Frontend entry point

**Settings → Desktop** surfaces every path, proxy selection, one-click folder actions, and the `data_root` picker.

## Desktop REST authentication

Packaged desktop sidecars generate a one-time bearer token at every launch and
inject it as `COVEL_DESKTOP_REST_TOKEN`. Write endpoints (`/api/config/keys`,
`/api/config/settings`, `/api/config/proxy`, `/api/config/data-root`, and
`/api/config/open-folder`) and the local-config or outbound reads for
settings/proxy/app updates
require `Authorization: Bearer <token>`. `/api/config/info` and the provider
name-only `/api/config/keys` response remain public. Development web/server
mode keeps the token gate disabled when the variable is absent.

## Related docs

- [README · Quick Start](../../README.md#quick-start) — download & first launch
- [desktop-packaging.md](./desktop-packaging.md) — local desktop builds, signing, notarisation
- [reference/api.md](../reference/api.md) — backend API reference

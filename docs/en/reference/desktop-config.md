# Desktop config & data layout

> [中文版](../../reference/desktop-config.md)

This page describes every file the desktop app (Electron, source in [`apps/desktop/`](../../../apps/desktop/)) uses: where it is, what it holds, and what happens when it is damaged. Read it when you edit config by hand, debug the desktop app, or write a tool for it. If you only want to know where saves are and how to back them up, [Data, backup and upgrade](../start/data-and-upgrade.md) is enough.

At launch the desktop shell starts a backend process on this machine (the "backend" below) and passes it the directories below through environment variables.

## Directory structure

On first launch the desktop app creates `~/.covel/`. Small config files and user plugins live here. The heavy parts (the database, logs, and user worlds) live in `~/.covel/data/` by default and can be moved together through `config.toml`.

```text
~/.covel/                    ← config root (small files)
  config.toml                ← data location, network proxy, log rotation (see below)
  llm.toml                   ← model slot config (provider / model / baseUrl)
  keys.env                   ← provider API keys, plain KEY=VALUE lines
  settings.json              ← settings made in the UI: locale, appearance, slot overrides, per-plugin settings
  reasoning-models.json      ← optional: reasoning levels of models the bundled data does not name yet
  app-update.json            ← ignored desktop app release
  window-state.json          ← window size, position, maximized and fullscreen state
  data-root-copy.json        ← a pending data directory copy; exists only until the next start
  plugins/                   ← user plugins (merged with the bundled core plugins)

<data_root>/                 ← default ~/.covel/data; can point anywhere
  covel.db                   ← SQLite database
  worlds/                    ← worlds the user created or installed
  logs/                      ← app logs (rotated by size, one NDJSON record per line)
    desktop.log              ← main-process events (window / IPC / backend supervision / startup failures)
    server.log               ← backend stdout/stderr (startup output and request log)
    desktop.log.1 … .N       ← rotated copies, oldest dropped past max_files
    server.log.1 … .N
  server.port                ← port of the last launch (preferred on the next one)
```

The reasoning level data is described in [model slots](./slots.md).

**Logging rules**:

- The request log skips `/api/health` by default. `COVEL_LOG_QUIET_PATHS=/api/foo,/api/bar` replaces that list.
- Model calls, proposals and tool calls of a turn are **not written to these files**. They are in the `trace_events` database table; view them on the `/debug` page or through a JSON export.
- When `pnpm dev:server` runs on its own, the server also writes its stdout/stderr to `server.log`, and the terminal still shows it. `COVEL_SERVER_LOG_FILE=""` turns that off; `COVEL_SERVER_LOG_FILE=/path/foo.log` changes the path.
- Ordinary backend stderr is recorded as `error`. The framework marks recoverable warnings with `[covel:warn]`; the log collector removes the marker and records them as `warn`. So `policy: warn` scheduling diagnostics and automatic retries do not count as errors.
- Very old versions wrote `electron.log`. It is not migrated and expires through rotation.

## `~/.covel/config.toml`

Created from a commented template on first launch. Fields:

```toml
schema_version = 1

[paths]
# Data directory. Relative paths resolve against this file's directory;
# absolute paths are used as-is. Default: ~/.covel/data
# data_root = "/Volumes/External/covel-data"

[network]
# direct | system | http | socks
proxy_mode = "direct"
# HTTP(S) example: http://127.0.0.1:7890
# SOCKS5 example:  socks5://127.0.0.1:7891
# proxy_url = "http://127.0.0.1:7890"

[logging]
# Single log-file cap (MB). Rolls over once exceeded.
max_size_mb = 10
# Retained rotated files. Oldest is dropped past this cap.
# Total disk usage ≈ max_size_mb × max_files.
max_files   = 10
```

Read and write rules:

- A file without `schema_version` is read as v1.
- The UI and the REST endpoints change only the known fields above. Unknown fields, unknown sections and existing comments are kept.
- The whole TOML is parsed strictly before and after every write.
- When the file is malformed, the app still starts with defaults and prints a warning, but it refuses to overwrite the file. Repair it by hand first.
- A write goes to a temporary file in the same directory, is renamed over the original, and sets mode `0600`.

**When a change applies.** A manual edit needs a Covel restart. Saving under **Settings → Desktop → Network Proxy** applies immediately.

**Proxy modes:**

| `proxy_mode` | Effect                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `direct`     | No proxy                                                                                             |
| `system`     | Asks the OS proxy rules for each target URL and tries the proxies in the order the system returns    |
| `http`       | Uses `proxy_url`; accepts `http://` and `https://` addresses; a missing scheme becomes `http://`     |
| `socks`      | Uses `proxy_url`; accepts `socks://` and `socks5://` addresses; a missing scheme becomes `socks5://` |

A proxy URL may contain `user:password@host`, so the file is tightened to mode `0600` when proxy settings are saved.

**Which requests the proxy covers:**

- Model requests the framework itself sends.
- Model-database updates from GitHub.
- Resolving and downloading plugins from GitHub.
- The desktop app version check.

A third-party plugin's `fetchWithRetry` does not use the proxy. It stays direct and pins its DNS result strictly, so remote DNS on the proxy side cannot bypass the plugin's network limits.

## New-version prompt

A packaged desktop app queries the latest stable GitHub Release through `GET /api/app-update/latest` at every launch.

- The backend sends the request through the selected `direct`, `system`, HTTP(S) or SOCKS5 route.
- When the GitHub version is newer than the current one, a platform-native dialog offers two buttons: "Open download page" and "Ignore this version".
- "Open download page" opens the fixed Covel GitHub Releases page.
- "Ignore this version" records the version in a separate `app-update.json` (not in `settings.json`, so it cannot conflict with a settings save). The prompt returns only when a higher version appears.
- A failed check is written to the desktop log and does not delay startup.
- Nothing is downloaded or installed automatically.

> [!NOTE]
> **Editing `data_root` by hand copies no data.** A new location without data starts empty, and the old data and user worlds stay where they were. When you switch in **Settings → Desktop**, Covel asks whether to copy; see [Frontend entry point](#frontend-entry-point).

## `~/.covel/keys.env`

```env
# One KEY=VALUE per line; # starts a comment.
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

- The backend finds every `*_API_KEY` entry and hands it to the matching provider.
- Variable name = provider name in upper case + `_API_KEY`.
- The file mode is `0600` by default and the app resets it on save. If you edit by hand, do not loosen the permissions.

How a save works:

- When the backend is unavailable, the desktop shell reads the existing keys itself and changes only the providers named in this save; the others stay as they are.
- It writes an exclusive temporary file in the same directory with mode `0600`, then renames it over the original.
- When the write, the permission change or the rename fails, the original file is kept, the temporary file is cleaned up if possible, and the failure is reported.
- A key value containing a line break is rejected before writing.

This guarantees the file is either the old content or the complete new content. It does not guarantee the new content is on disk after a power loss.

## `~/.covel/llm.toml`

The desktop shell always passes this path to the backend, even before the file exists. The app never copies model configuration from its install directory: the first launch uses the built-in default, and creating this file and reloading applies it.

- See [`llm.toml.example`](../../../llm.toml.example) at the repository root. Each model slot pairs one provider with one model.
- The built-in default `story` slot uses `deepseek-v4-flash`. Filling `DEEPSEEK_API_KEY` in `keys.env` is enough to run.

**Settings UI.** The model settings have three pages: **Model Roles**, **Providers & Models**, and **Generation**.

- **Providers & Models** is a provider list with a detail view. Configure a provider's endpoint, protocol, key and price multiplier once, then add any number of model IDs in bulk.
- A model ID containing `/`, such as `openai/gpt-5.6-sol`, is sent unchanged.
- Then pick the provider and model for each slot under **Model Roles**. No custom preset is needed.
- The price multiplier defaults to `1`. The cost panel on the debug page multiplies the model's reference price by it.

Model settings made in the UI are stored only in `llm.providers`. Startup and reads neither migrate nor fall back to `llm.customPresets`. Recreate affected model configurations and credentials in the current provider UI; obsolete entries are not deleted automatically.

**Hot reload.** Editing `llm.toml` needs no restart. Go to **Settings → LLM → Model Roles** and click **Reload config**: the backend re-reads the file and applies it to the running gateway (`POST /api/llm-config/reload`), and added or removed slots take effect at once. On desktop this endpoint is protected by the one-time bearer token like the other write endpoints, and the UI attaches it; in development and web deployments without a token it is open.

**Parse failures are visible.** When `llm.toml` has a syntax error (a key with `=` and no value, say):

- At first start: the built-in default is used.
- On a manual reload: **the last valid configuration is kept**; the models in use are not swapped silently.
- In both cases `GET /api/llm-config` carries an `error` field and the top of the model settings shows a red notice with the error. Fix the file and click **Reload config**.

### Choose a plugin runtime model for one world or session

**Model Roles** maps each slot to the provider and model used on this device. For example, the `plugin` slot may point to `ali-coding-plan / qwen3.8-flash`. A plugin manifest declares only its default slot, such as `model: plugin`; it does not pin a concrete model like `deepseek-v4-flash` inside the world.

On the configuration page shown before a session starts, each agent runtime in the plugin list can pick a slot:

- **Runtime default: `plugin`** means no override. The runtime follows the current `plugin` assignment from Settings.
- Choosing another slot such as `story` or `fast` stores `runtimeId → slot` in the new session's `runtimeModelOverrides`. It affects only that session and changes neither the world package nor global settings.
- A multi-runtime plugin shows each full runtime ID, such as `char-creator/character-tracker`, and each one is chosen independently.
- After the game starts, the slot can still be changed in the plugin list on the left. The server saves it through `PATCH /api/sessions/:id`, and it applies from the next execution.

Picker options and default summaries show the slot, the provider and the **effective model** together. `default: plugin` is the routing declaration; `ali-coding-plan · qwen3.8-flash` beside it is what this device actually calls. The two do not conflict. Pointing `plugin` at another model in Settings later moves every runtime that still follows `plugin`, with no per-world edits.

`runtimeModelOverrides` applies only to agent runtimes. Image, speech and similar function runtimes usually choose their media `[covel.<slot>]` through the plugin setting `modelPresetId`. The same page shows that separately as **provider slot**; it is saved in this device's plugin settings, not in the session's runtime overrides.

**Changing the provider slot in place.** Some plugins, such as image generation, name the `[covel.<slot>]` they use through `modelPresetId` (`openai-image`, say). If you have not configured that slot but have another of the same kind (`gpt-image`, say), pick it directly in the **provider slot** picker on that plugin's row before the session starts. You need not edit the plugin's settings or copy the plugin's default slot name. The missing-slot warning clears once a configured slot is selected, and the value is passed to that plugin's function runtime with each turn.

## Frontend entry point

**Settings → Desktop** lists every path and the proxy selection, opens folders in one click, and switches `data_root`. Use it when you would rather not edit files.

**Switching `data_root`.** After you pick a folder in the desktop app, what happens depends on the two locations:

- The current folder has data and the new one has none: a dialog asks "Copy my data" or "Start empty".
- The new folder already holds a `covel.db` or user worlds: it is used as it is. Nothing is copied or overwritten.
- With "Copy my data", only a `data-root-copy.json` is written to the config root at that moment, and `data_root` stays unchanged. At the next start the main process copies `covel.db`, `covel.db-wal`, `covel.db-shm` and `worlds/` before it starts the backend (not `logs/`, not `server.port`), and rewrites `data_root` only after the copy succeeded.
- The copy is tried once. When it fails, is cut short, or another Covel process still has the database open, the files this copy wrote are removed, `data_root` stays unchanged, and a dialog says why.
- The old folder is only read: nothing is moved or deleted.

Switching through REST from a browser (`PUT /api/config/data-root`) only rewrites `data_root` and never copies.

**Opening and editing `llm.toml`:**

- **Open llm.toml** uses the effective `COVEL_LLM_TOML` path and falls back to `llm.toml` in the config root only when it is unset. `keys.env` is always in the config root.
- While `llm.toml` does not exist, the app runs on the built-in default: a DeepSeek `story` slot, or the endpoint in `DEFAULT_BASE_URL` when it is set; see [model slots](./slots.md).
- The first **Edit llm.toml** click creates the file from that built-in default and then opens it. The active models do not change.
- Any other missing target returns `open_target_unavailable`.

Tags under **Settings → LLM → Providers & Models**:

- Models from the file are tagged "From llm.toml"; when no file exists they are tagged "Built-in default". Both kinds are removed only by editing the file.
- Providers added in the UI are stored in `settings.json` and can be deleted there.

In source development the priority of the root `llm.toml`, the user resource directories and the Docker mounts differ from desktop; see the [environment loading rules](./env-registry.md#load-paths-and-differences-between-environments).

**Window state.** Stored in `window-state.json` under the config root. Startup checks the dimensions, coordinates and boolean flags; a malformed or invalid record gives the default window. Coordinates on a disconnected display are ignored; valid negative coordinates still restore a window on a secondary display.

**Version.** The framework version comes from the app package. The page, the desktop bridge and the server health endpoint do not each keep a hardcoded version.

## Startup and recovery

On startup failure, the main process waits for the splash page to finish loading before sending the error, so the page can show retry and log controls.

- The app takes a single-instance lock before starting. Another launch only focuses the existing window.
- Once the backend is listening, it tells the main process through private IPC and the window loads immediately. When the desktop parent disconnects, the backend drains and exits.
- `server.port` holds the last port that worked. It is reused when free; otherwise another free port is chosen.
- The page uses Electron's persistent default session. The page origin includes the port, so what an earlier port stored (the media cache, the panel layout) is never read again: at startup the app clears the storage of every earlier loopback origin and, when it found one, the HTTP cache.
- After installing a plugin or world package, click **Restart now** in the prompt. The main process waits for the new backend and reloads the window with the current page path and query. Backend crash, restart and recovery states are shown in the app.
- Session data survives the restart. Community plugin grants live only in the process and may need approval again.
- The native Import Plugin and Import World menus open **Settings → Install & manage**, where you choose the ZIP, preview it, authorize it and see the result.

## Desktop REST authentication

The desktop shell generates a one-time bearer token at every launch and passes it to the backend as `COVEL_DESKTOP_REST_TOKEN`.

| Endpoint                                                                                                                                                   | Token                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `PUT /api/config/keys`, `PUT /api/config/settings`, `PUT /api/config/proxy`, `PUT /api/config/data-root`, `POST /api/config/open-folder` (write endpoints) | Required                                         |
| `GET /api/config/settings`, `GET /api/config/proxy`, `GET /api/app-update/latest` (return local config, or send an outbound request for you)               | Required                                         |
| `GET /api/config/info`                                                                                                                                     | Not required                                     |
| `GET /api/config/keys`                                                                                                                                     | Not required. Returns provider names, never keys |

An endpoint that requires the token checks the `Authorization: Bearer <token>` header and returns `401` when it is missing or wrong.

- The `GET /api/config/info` response has a `requiresAuth` field; the frontend uses it to decide whether to send the Authorization header.
- The Electron page gets `restToken` through the `covel:get-info` IPC and adds it to every write request.
- In development, when the variable is absent, the token gate is off. Plain web deployments and the `pnpm dev:web` flow are unaffected.

**How keys appear in the UI.** The Electron UI reads plaintext keys from `keys.env` through `covel:keys:load` IPC. SettingsStore keeps them in memory to build the `X-Provider-Keys` header, without writing them to the desktop page's `localStorage`. Saving sends a patch through `covel:keys:save`: unchanged keys stay, new values are written, and `null` deletes a key. The main process first writes through the sidecar's `PUT /api/config/keys`; in development without a sidecar, or when the sidecar is unavailable, it writes the file directly.

`GET /api/config/keys` returns provider names only, never key values. The current Electron UI does not call it: its `json-file` backend uses IPC, while a plain browser uses `localStorage`. An integration that explicitly selects the `json-file` REST transport represents this list as in-memory “server-managed key” markers, which never enter `X-Provider-Keys`. See [Settings store](./settings-store.md).

**When `keys.env` cannot be read.** GET returns `500 keys_file_unreadable` and PUT returns `409 keys_file_unreadable`; the original file is kept. Writes use the same temporary file plus rename.

**`settings.json` format and conflicts.**

- A write uses a temporary file in the same directory plus rename. The current format is `schemaVersion: 2` with a `revision` that only increases.
- A file this version cannot use is not converted. At startup the desktop shell renames a v1, unversioned or damaged `settings.json` to `settings.<v1|unversioned|damaged>.bak.json`, and the settings start from their defaults.
- When only single values are no longer accepted, the file is first copied to `settings.conflict.bak.json` and those values are removed.
- The app says so once in both cases, and the copies can be viewed under **Settings → Data**. `keys.env` is not affected.
- The separate settings import/export file still uses `schemaVersion: 1`.
- Read the [v0.0.42 upgrade guide](../internals/upgrade-0.0.42.md) before upgrading.

Errors when reading or writing through REST:

| Situation                                                                 | Result                                                                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| File unreadable, JSON or `entries` damaged, or version newer than the app | GET returns `500 settings_file_invalid`, PUT returns `409 settings_file_invalid`; the file is kept. Settings stay read-only |
| The `revision` sent with a save is stale (another instance saved first)   | `409 settings_revision_conflict`; the file is unchanged                                                                     |

Every write must carry the `revision` it read. On an ordinary revision conflict the UI first loads and validates the latest content, then compares setting by setting:

- The two sides changed different keys: your change is applied again on the latest content and saved.
- Both changed the same key (a whole object or array counts as one key): the overwrite is refused and you are asked to review the latest value and retry.

Ordinary settings sync on browser storage events, when the window regains focus, and when the page becomes visible again. These syncs neither read nor write API keys. See the [SettingsStore contract](./settings-store.md).

## Related docs

- [Install](../start/install.md): download and first launch
- [Data, backup and upgrade](../start/data-and-upgrade.md): the part a player needs
- [Desktop packaging](../internals/desktop-packaging.md): local builds, signing, notarisation
- [API reference](./api.md)

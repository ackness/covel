# Environment variable registry

This page lists every environment variable that Covel reads: its default value, what it does, and which file it is written in. People who run Covel from source, deploy it with Docker, or maintain the server need it. If you only use the desktop app, you usually do not need to set any variable. [Data, backup, and upgrade](../start/data-and-upgrade.md) is enough for you.

The only source of the variable list is `packages/shared/src/env/registry.ts`. This page must mention every variable declared there, and a test checks this.

When code reads an environment variable, it uses the functions that `@covel/shared` provides:

- `readRuntimeEnv()`: reads the common settings for the server, storage, and desktop in one go.
- `isEnvEnabled()`: reads a switch that is off by default. Only the string `1` turns it on.
- `isEnvDefaultOn()`: reads a switch that is on by default. `0` or `false` turns it off.
- `readEnvString()` / `readEnvInt()` / `readEnvChoice()`: read a single variable. `readEnvChoiceStrict()` throws an error when the value is not valid.
- `providerApiKeysFromEnv()`: finds every `*_API_KEY` and maps it to a provider ID.

## Groups

Every variable belongs to a group (`group`):

| group       | Purpose                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `storage`   | `STORE_BACKEND`, `DATABASE_URL`, SQLite / PostgreSQL settings               |
| `server`    | Port, CORS, static assets, deployment tier, rate limits                     |
| `desktop`   | Paths and desktop mode settings that Electron passes to the backend process |
| `ai`        | Model config, provider keys, model database, prompt root directory          |
| `feature`   | Feature switches that apply at run time                                     |
| `web`       | Vite development proxy and variables visible in the browser                 |
| `test`      | Playwright, real-provider tests, e2e scripts, development scripts           |
| `packaging` | Keys for Electron signing and notarization                                  |

## Status

| status      | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `active`    | The code already reads it. It is the current setting                       |
| `packaging` | The packaging tools read it. The app itself usually just passes it through |

## What each file is for

| File                   | What goes in it                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.env`                 | Infrastructure, server, storage, feature switches, and local development helpers                                 |
| `.env.llm`             | Provider API keys and provider addresses                                                                         |
| `llm.toml`             | Model roles (slots), providers, models, protocols, and capabilities. You can use `${VAR}` to refer to a variable |
| `~/.covel/keys.env`    | Provider API keys saved by the desktop app                                                                       |
| `~/.covel/config.toml` | Desktop app data folder, network proxy, and log rotation settings                                                |

`.env`, `.env.llm`, and `llm.toml` are copied from their `*.example` files. Do not commit them to the repository. The example files contain only values that are safe to publish.

## Load paths and differences between environments

Different ways of starting Covel read different files.

**Server in source development**

- It reads `.env` and `.env.llm` in the repository root. A value that is already in the process environment takes priority.
- The model config file is set by `COVEL_LLM_TOML` (default `./llm.toml`). If it is not set, the `llm.toml` in the repository root is always used. It is not replaced by another copy in your personal folder.
- If `llm.toml` does not exist, the built-in default is used. If the first load fails, an error is shown and the built-in default is used. If a manual reload fails, the current valid config is kept.
- Key priority: process environment > `.env.llm` > `.env` > `$COVEL_HOME/keys.env`.
- A key entered in the interface is sent with the request. It takes priority over an allowed server default key.

**Electron desktop app**

- It always uses `$COVEL_HOME/llm.toml`. `COVEL_HOME` defaults to `~/.covel`.
- For the other files, see [Desktop app config and data folder](./desktop-config.md).

**Vite (web front end)**

- It reads `.env`, `.env.local`, and the files for the matching mode from the repository root. Only `VITE_*` variables are exposed to the browser.
- The development proxy's target host is `RUNTIME_HOST` (default `127.0.0.1`). The port is taken from `RUNTIME_PORT`, then `SERVER_PORT`, then `3001`. A value set in the shell takes priority.
- The build cache counts these root environment files and `VITE_*` as inputs. So after you change a public setting, an old build is not reused.
- `NODE_ENV` in the root `.env` affects only the server. `pnpm --filter @covel/web build` (and `pnpm build` and `pnpm build:electron`, which run it) always produces a production build. Only if you export `NODE_ENV=development` explicitly in the shell do you get a development build of the front end.

**Pre-start check for `pnpm dev:pg`**

- It reads the root `.env`, and by default checks that the database can be reached using `DATABASE_URL`.
- If there is no URL, it checks `127.0.0.1:POSTGRES_PORT` (default `5432`).
- If the URL has no port, it uses the PostgreSQL default port, `5432`.
- `COVEL_PG_PREFLIGHT_HOST` / `COVEL_PG_PREFLIGHT_PORT` can set the check target directly. `COVEL_PG_PREFLIGHT_SKIP=1` skips the check.

**Docker**

- The process environment is injected by Compose. The model config is mounted read-only from the host machine. For paths and persistence rules, see [Docker Compose](#docker-compose).

**Plugin translations**

- Plugin translations that live outside the package (translation packs, local machine translation) are read from `COVEL_USER_TRANSLATIONS_DIR`. If it is not set, `$COVEL_HOME/translations` is used. If the folder does not exist, nothing is read. For the format, see [i18n](./i18n.md).

**Worlds and plugins you install**

- Installing and discovering at startup both use `COVEL_USER_WORLDS_DIR` / `COVEL_USER_PLUGINS_DIR`. If they are not set, `$COVEL_HOME/worlds` / `$COVEL_HOME/plugins` are used. The desktop app uses the folders that it injects itself.
- After a world installs successfully, you can query and use it right away. After a plugin installs, the server must be restarted.
- A symbolic link to a directory inside the plugin folder (for example, a plugin developed in another repository) is discovered like an ordinary plugin. Reading is limited to the plugin directory that the link resolves to. A broken symbolic link is skipped, and a warning is logged.

**Offline image script**

- It uses the same TOML reading logic as the app. It supports inline metadata tables, sub-tables, and `${VAR}` references.
- The config path is `COVEL_LLM_TOML`. Otherwise it is `$COVEL_HOME/llm.toml`.
- Key priority: `COVEL_IMG_KEY` > the provider's own environment variable > that provider's key in `$COVEL_HOME/keys.env` > `OPENAI_API_KEY` (environment variable or file).
- To preview a generation job from source with the root config:

  ```bash
  COVEL_LLM_TOML=llm.toml pnpm exec tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm scripts/generate-scenes.mjs haruka-academy --dry-run
  ```

  To generate for real, remove `--dry-run`, and use `--slot` to pick one role from the config.

### Personal config and save boundaries

The same setting is stored in different places depending on whether you use the browser or the desktop app:

| Setting                                                     | Browser with pnpm / Docker                                                                                                    | Electron                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Model defaults                                              | The `llm.toml` in the project or the mounted one                                                                              | `$COVEL_HOME/llm.toml`                                                    |
| Connections, roles, and parameters entered in the interface | `covel:settings` for the current origin                                                                                       | `$COVEL_HOME/settings.json`, through IPC                                  |
| API keys entered in the interface                           | `covel:keys` for the current origin                                                                                           | `$COVEL_HOME/keys.env`, through IPC                                       |
| Server default keys                                         | Environment variables; only trusted origins that are allowed can use them                                                     | Same environment priority. File changes are synced to the running backend |
| Settings the server runs with                               | Server database (`server_settings` table); editable in personal form, operator-configured in browser-private and hosted forms | Same as left: written to the database through the local server            |
| Game saves                                                  | In memory mode, the browser saves checkpoints. In SQLite / pg mode, your own instance keeps them                              | Your own SQLite, or a backend you choose explicitly                       |

A few rules that are easy to get wrong:

- When you use a browser to reach the desktop app's backend, the browser's own settings are used.
- `COVEL_HOME` only sets paths. The file management REST API needs `COVEL_DESKTOP_REST=1` set explicitly (off by default). Electron sets it automatically and provides a token.
- `GET /api/provider-keys` only tells you whether a provider has a usable key. It does not return the key value or any part of it. Neither startup nor reload copies server keys into the browser.
- Deleting a personal key does not delete instance defaults set elsewhere in the shell or in `.env.llm`. Those external settings still apply after a restart.
- "Reload config" rereads only the model TOML. It does not reread `.env` or `.env.llm`. If you change those two files, restart.

If reading `settings.json` / `covel:settings` fails:

- The original data is kept, and the settings become read-only. The settings page shows the recovery steps. It does not pretend that a save succeeded.
- The current storage format is schema v2. Old data is not migrated automatically. When you deal with old development data, back it up first. Then move the old settings file or the matching browser key out of the way, and configure again.
- You do not need to delete `keys.env`, the game database, or the whole personal folder.

> [!IMPORTANT]
> This repository is meant for trusted personal instances and clients. SQLite and PostgreSQL do not provide the account isolation that a public server needs. Commercial providers, hosted bring-your-own keys, and account saves need a separate product boundary.

### User resource folders

| Entry                    | World folder                                            | Plugin folder                                             |
| ------------------------ | ------------------------------------------------------- | --------------------------------------------------------- |
| Source / ordinary server | `COVEL_USER_WORLDS_DIR`, otherwise `$COVEL_HOME/worlds` | `COVEL_USER_PLUGINS_DIR`, otherwise `$COVEL_HOME/plugins` |
| Electron                 | The desktop program injects `<data_root>/worlds`        | The desktop program injects `<config_root>/plugins`       |
| Docker Compose           | `/home/node/.covel/worlds`                              | `/home/node/.covel/plugins`                               |

- An ordinary server uses `~/.covel` when `COVEL_HOME` is not set.
- `COVEL_WORLDS_DIR` / `COVEL_PLUGINS_DIR` point to the worlds and plugins that **ship with the app**. Installed worlds and worlds generated by AI are written to the user folder.
- The plugin scaffold and `test:runtime` also use the user plugin folder. An explicit `--target` / `--plugins-dir` takes priority. The `--with-tools` scaffold always writes into the repository's `plugins/` folder.

### Docker Compose

There are two Compose files for self-hosting. Both are personal instances bound to loopback:

| Backend          | File                               | Commands                                                                                             |
| ---------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| SQLite (default) | `docker/docker-compose.sqlite.yml` | `pnpm docker:build` / `docker:up` / `docker:down` / `docker:down-all` / `docker:logs`                |
| PostgreSQL       | `docker/docker-compose.yml`        | `pnpm docker:pg:build` / `docker:pg:up` / `docker:pg:down` / `docker:pg:down-all` / `docker:pg:logs` |

Preparation:

1. Copy `.env.example` to `.env`, and copy `llm.toml.example` to `llm.toml`.
2. Set `COVEL_MEDIA_TOKEN_SECRET` in `.env` (generate it with `openssl rand -hex 32`). Without it, a production app fails when it issues its first media URL, the SQLite stack refuses to start without it. The PostgreSQL stack does not check it, so that `pnpm db:up` can start only the database; set it yourself.
3. For PostgreSQL, uncomment the PostgreSQL block of `.env.example` and set `POSTGRES_PASSWORD`. If you only run `pnpm db:up`, you need only the PostgreSQL settings (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`).
4. The server's provider keys can go in the optional `.env.llm`.

Then:

```bash
pnpm docker:build
pnpm docker:logs
```

For PostgreSQL:

```bash
pnpm docker:pg:build
pnpm docker:pg:logs
```

Behavior that both Compose files share:

- It uses `DEPLOYMENT_TIER=self`. The host binds only to the loopback address by default, and the same-origin interface does not need an operator token or CORS configuration.
- Inside the app container, `SERVER_PORT` is fixed at `3001`. The host entry point is set by `APP_BIND_IP` (default `127.0.0.1`) and `APP_PORT` (default `3001`). Both stacks use the same default port, so do not start them together.
- A browser that opens it at `localhost` or `127.0.0.1` needs nothing more. If you change `APP_BIND_IP` to open it from other machines, list the names it is opened by in `COVEL_ALLOWED_HOSTS`.
- The built-in health check reaches `http://127.0.0.1:3001/api/health` inside the container.
- The root `llm.toml` is mounted read-only at `/app/llm.toml`. If the file is missing, Compose reports an error.
- The `appdata` volume is mounted at `/home/node/.covel`, and it stores the user's worlds and plugins.

The SQLite stack:

- The Alpine image preloads its installed `gcompat` library so the Linux `sqlite-vec` extension can load under musl. During the build, an unprivileged user runs `vec_version()` without network access. A loading failure stops the build instead of silently disabling vectors.
- It has one app container and no database service. `STORE_BACKEND=sqlite`, `SQLITE_PATH=/home/node/.covel/data/covel.db`, and `MEDIA_ROOT=/home/node/.covel/data/media` are set in the Compose file, and they override variables of the same name that `.env` holds for runs from source. The database and the media are therefore both in the `appdata` volume.
- A folder of the image that has no volume (for example `/app/apps/server/data`) is lost when the container is recreated, so the database must not be placed there.
- The project name is `covel-sqlite` and the container name is `covel-sqlite-app`.

The PostgreSQL stack:

- The database address inside the container is fixed at `postgres:5432`. It does not depend on the host's `POSTGRES_PORT`.
- The `pgdata18` volume stores the database.

> [!CAUTION]
> `docker:down` / `docker:pg:down` keep the volumes. **`docker:down-all` deletes the SQLite stack's `appdata` volume, which means the database and all the data in it; `docker:pg:down-all` deletes both volumes of the PostgreSQL stack and the data in them.**

Before an upgrade, if the old container already has worlds or plugins installed, export `/home/node/.covel` first, and then import it into the new volume. New volumes do not automatically move files that were written in the old container's writable layer.

### Vector memory

`VECTOR_BACKEND` has three values:

| Value      | Effect                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embedded` | Default. Uses semantic search when storage supports vectors and an embedding function is connected. If that fails or is unavailable, it falls back to keyword search.                                                   |
| `none`     | Turns off automatic locking of the embedding model, semantic memory ingestion, and vector search. Keyword memory and stored vectors are kept. It does not forbid explicit embedding requests outside the memory system. |
| `external` | The host must inject an adapter explicitly.                                                                                                                                                                             |

For details, see [API configuration notes](./api.md#installed-resource-storage-and-vector-configuration).

## Database maintenance commands

Both SQLite and PostgreSQL create the current table structure when the app starts. There is no automatic upgrade for an existing table structure. The repository has no version-controlled migration records, so there is no `db:migrate` command. Newly generated table SQL cannot be applied directly to an existing database.

| Command            | What it does                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:generate` | Generates a PostgreSQL table structure snapshot and SQL for development review (written to `apps/server/drizzle/`, not committed) |
| `pnpm db:studio`   | Opens the PostgreSQL viewer                                                                                                       |

Both commands run Drizzle directly and read the root `.env`. A `DATABASE_URL` set in the shell takes priority.

Covel supports only the current data contract and provides no migration path for old databases. If the data schema is incompatible, back it up and create a new SQLite file or empty PostgreSQL database; see [schema checks](../internals/storage.md#capabilities-and-migrations). These tools neither migrate data nor bypass the startup version check.

### Plugin extension development data

v0.0.42 changed the plugin extension contract. Old development data is not upgraded automatically. For how to back up, move to new storage, and roll back for the desktop app, the server, PostgreSQL, and the browser, see the [v0.0.42 upgrade guide](../internals/upgrade-0.0.42.md) ([English](../internals/upgrade-0.0.42.md)).

**Why an old SQLite database cannot keep being used.** The old `lorebook_entries` table used `plugin_id` as part of a column and of the primary key. The current version requires `owner`. The startup schema check refuses this old database with `StoreSchemaVersionError`, which names its absolute file path. Deleting or recreating sessions, snapshots, or browser checkpoints alone cannot fix this table structure.

**Steps for an old development environment:**

1. Stop all server and desktop processes that use this database.
2. Read the absolute path in the `StoreSchemaVersionError` message to identify the database. An explicit `SQLITE_PATH` wins, including a value in the repository's `.env`. Relative paths use the server's working directory: `apps/server/` under `pnpm dev`. The source-development home bootstrap selects `<COVEL_HOME>/data/covel.db` only when that home already exists and `SQLITE_PATH` is unset; the default home is `~/.covel/`. Otherwise, the registry uses `<COVEL_DATA_ROOT>/covel.db` if configured, then falls back to `./data/covel.db`, which is `apps/server/data/covel.db`.
3. If the data must be kept, back up this database file and its `-wal` and `-shm` files to a safe place.
4. Point `SQLITE_PATH` to a new file that **does not exist yet**, or move the backed-up files aside together. If the development data is disposable, you can delete these files instead.
5. Start the current version so it creates the new table structure. Then create new sessions and snapshots.

> [!CAUTION]
> While a process still has the database open, do not move or delete the WAL or SHM files on their own. These steps do not require deleting real user data.

**Also check the user folders.** Look at the user plugin folder (`COVEL_USER_PLUGINS_DIR`, default `$COVEL_HOME/plugins`) and the user world folder (`COVEL_USER_WORLDS_DIR`, default `$COVEL_HOME/worlds`):

- The sub-manifest of a plugin with several runtimes must be named `RUNTIME.md`, not the old sub-`PLUGIN.md`.
- A world's `pluginPolicy` uses the current form: `preset`, `plus`, `pitch`, `packs` and `requires` (see [world data](./world-data.md#plugin-selection-pluginpolicy)).
- A target in `worldData` that points to plugin data uses `contract:<id>`.

Back up the old folders first. Then update the packages until they pass the current validation. Old files are not converted automatically. User content that has not been checked does not need to be overwritten.

The current contract also requires these consumers to be updated:

- Background jobs must persist the full `turn-digest@1`, including the structured `lastPlayerInput` and `runtimeResults`. Old jobs, snapshots, and sessions must be rebuilt, and those missing fields cannot be recovered. `ctx.playerMessage` is still text. `ctx.session.lastPlayerInput` is now the committed record or `null`.
- Plugin state reads `hostState`, `sessionState`, and the separate `serverCodeApproved`. Do not use `loaded` to infer whether a session is authorized.
- Cross-package runtime inputs, `needs`, and `after` use the contracts declared in the root manifest. The order of a one-time setup uses `after`. Do not write a finished setup as `needs`, or every later run will require it to produce a result.
- World time moves from `dimensions.time` to `world.time-definition@1` data. Panel bindings and GraphCanvas update to the current props contract. The three ways of saving world generation (write a file, store only, return directly) all carry `contractData`.

## Other runtime variables in the registry

The variables below are also in `registry.ts`. For variables whose use is already described above, this section lists only the default values.

**Server and storage**

<!-- prettier-ignore -->
| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Node run mode (`development` / `production` / `test`) |
| `STORE_BACKEND` | `sqlite` | Where server data is stored (`memory` / `sqlite` / `pg`) |
| `SQLITE_PATH` | `./data/covel.db` | SQLite file path, relative to the server's working directory (`apps/server/` under `pnpm dev`); see above for home bootstrap and `COVEL_DATA_ROOT` selection |
| `DATABASE_URL` | — | PostgreSQL connection string. Required when `STORE_BACKEND=pg` |
| `MEDIA_BACKEND` / `MEDIA_ROOT` | `mirror` / — | Where media is stored (`mirror` / `memory` / `sqlite` / `pg` / `none`) and the root folder for files. `mirror` follows `STORE_BACKEND`. `none` turns off the media interface. If `MEDIA_ROOT` is not set, the media folder next to `SQLITE_PATH` is used |
| `VECTOR_BACKEND` | `embedded` | Vector capability (`embedded` / `none` / `external`) |
| `POSTGRES_USER` / `POSTGRES_DB` | `covel` / `covel` | PostgreSQL user name and database name in Docker Compose |
| `POSTGRES_PASSWORD` | — | PostgreSQL password in Docker Compose |
| `POSTGRES_PORT` | `5432` | Host port of PostgreSQL in Docker Compose |
| `SERVER_PORT` | `3001` | Port the HTTP service listens on |
| `APP_PORT` | `3001` | Host port of the app in Docker Compose |
| `COVEL_BIND_HOST` | `127.0.0.1` | Address the HTTP service listens on |
| `COVEL_ALLOWED_HOSTS` | — | Host names, besides `localhost`, `127.0.0.1` and `[::1]`, that the `self` tier answers to, separated by commas |
| `COVEL_SOURCE_REPOSITORY` | — | The public source repository of this build (an `https` address). `/api/health` reports it, and the notice on a shared server links to it |
| `COVEL_SOURCE_COMMIT` | — | The commit of this build (7–40 hexadecimal characters), reported by `/api/health`. When it is not set, `RENDER_GIT_COMMIT` is used |
| `RENDER_GIT_COMMIT` | Set by Render on every deploy | The commit Render is deploying. Read only as the fallback for `COVEL_SOURCE_COMMIT` |
| `DEPLOYMENT_TIER` | `self` | Deployment tier (`self` / `demo` / `commercial`). It decides how strict authentication is |
| `SERVE_STATIC` / `STATIC_DIR` | `false` / `./web-dist` | Lets the server host the web front end in the given folder |
| `CORS_ORIGIN` | — | List of allowed HTTP origins, separated by commas |
| `ENABLE_DEBUG_PAGE` | `false` | Turns on debug and internal routes in production |
| `RATE_LIMIT_RPM` | `60` | Request quota per IP address per minute, used only by `GET /api/events/stream`; other routes set their quota in their own code |
| `TRUSTED_PROXY_IPS` | — | List of trusted proxy addresses. Only requests from these addresses are trusted to carry forwarded IP headers |
| `COVEL_MEDIA_TOKEN_SECRET` | Required in production | Key used to sign short-lived access links for media. If it is not set in development, a random one is generated at each start |
| `COVEL_MEDIA_CLEANUP_ENABLED` | `false` | Turns on `POST /api/media/cleanup` |
| `COVEL_INSTALL_API_ENABLED` | `false` | Without a desktop bearer token, explicitly turns on the API for installing and uninstalling plugins and worlds |
| `COVEL_SUSPENSION_TTL_MS` | `604800000` (7 days) | How long an unresolved suspension is kept before it is cleaned up |
| `COVEL_PG_LOCK_POOL_MAX` | `16` | Size of the connection pool used only for PostgreSQL session locks |
| `COVEL_PG_INGEST_LOCK_POOL_MAX` | `4` | Size of the PostgreSQL lock connection pool used only for semantic memory ingestion |
| `COVEL_LOG_QUIET_PATHS` | `/api/health` | Paths that are not logged in request logs, separated by commas |
| `COVEL_APP_VERSION` | The app's `package.json` | Overrides the framework version shown in the desktop preload and the server health check |

**Desktop and paths**

<!-- prettier-ignore -->
| Variable | Default | Purpose |
| --- | --- | --- |
| `COVEL_HOME` | `~/.covel` | Root folder of personal config. `keys.env` is also here |
| `COVEL_DATA_ROOT` | — | Data root folder of the desktop app, where SQLite, worlds, and logs are stored |
| `COVEL_USER_CONFIG_DIR` | — | Config folder of the desktop app, where the model database and settings are |
| `COVEL_LLM_TOML` | `./llm.toml` | Path of the `llm.toml` that is in effect |
| `COVEL_PLUGINS_DIR` / `COVEL_WORLDS_DIR` | — | Folders of plugins and worlds that ship with the app |
| `COVEL_USER_PLUGINS_DIR` / `COVEL_USER_WORLDS_DIR` | — | Folders of plugins and worlds that the user installs |
| `COVEL_USER_TRANSLATIONS_DIR` | — | Folder of translations for plugins outside the package |
| `COVEL_DESKTOP_REST` | `false` | Turns on the desktop config REST interface |
| `COVEL_DESKTOP_REST_TOKEN` | — | Bearer token for the desktop config write interface. It is also the operator credential for the hosted tier |
| `COVEL_SYSTEM_PROXY_URL` | — | Static system proxy for hosts without dynamic system-proxy IPC |
| `COVEL_DESKTOP_SYSTEM_PROXY_IPC` | `false` | Internal flag injected by Electron. It means the backend can ask the system proxy one URL at a time |
| `COVEL_LOGS_DIR` | — | Log folder of the desktop app (shown on the settings page) |
| `COVEL_LOG_MAX_SIZE_MB` / `COVEL_LOG_MAX_FILES` | `10` / `10` | Log rotation for the desktop app: the size limit of one file, and how many files are kept |
| `COVEL_SERVER_LOG_FILE` | — | File where the server saves its stdout/stderr. An empty string means nothing is saved. If not set, `server.log` in the log folder is used |

**Models**

| Variable                             | Default                 | Purpose                                                                                                                                                                      |
| ------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_BASE_URL` / `DEFAULT_MODEL` | — / `deepseek-v4-flash` | When there is no `llm.toml`, the built-in `story` role uses this OpenAI-compatible endpoint and model instead (provider `default`). `e2e:replay --record` also records to it |
| `DEFAULT_API_KEY`                    | —                       | Key for the `default` provider. The built-in role above and the sessions in `tests/llm-replay/` both use it                                                                  |
| `COVEL_LLM_RETRY_DISABLED`           | `false`                 | Set to `1` to turn off provider HTTP retries                                                                                                                                 |
| `COVEL_LLM_MAX_CONCURRENT`           | `4`                     | Limit on text model calls running at the same time across the whole process                                                                                                  |
| `COVEL_MODEL_DB_PATH`                | —                       | Overrides the path of the model database JSON                                                                                                                                |
| `COVEL_PROMPTS_DIR`                  | —                       | Overrides the root folder of prompt templates                                                                                                                                |
| `COVEL_IMG_KEY`                      | —                       | Key for the offline portrait and scene generation scripts. It takes priority over the provider's own key                                                                     |

**Feature switches**

| Variable                         | Default                                      | Purpose                                                                                      |
| -------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `COVEL_EFFECTS_POLICY`           | `warn`                                       | What to do when a read-write conflict appears in the same parallel layer (`warn` / `strict`) |
| `COVEL_INSTRUCTION_LOCALE`       | Follows the session language                 | Fixes the instruction language for all sessions (`en` / `zh`)                                |
| `COVEL_COMPACTOR_CONTEXT_WINDOW` | Calculated from model capabilities           | Fixes the context window used for compression and prompt budgets                             |
| `COVEL_SNAPSHOT_INTERVAL_TURNS`  | `5`                                          | Writes an automatic snapshot every this many player turns                                    |
| `COVEL_AUTO_SNAPSHOT_RETENTION`  | `20`                                         | How many automatic snapshots are kept for each session                                       |
| `COVEL_TRUSTED_SOURCES`          | Unset                                        | Comma-separated trusted GitHub owners or repositories                                        |
| `COVEL_TRACE_RETENTION_DAYS`     | `30`                                         | How many days traces and event logs are kept                                                 |
| `COVEL_PLUGIN_LOG_LEVEL`         | `debug` in development, `info` in production | Lowest level of plugin logs that are written to storage                                      |

For details of these switches, see [Runtime Contract](#runtime-contract).

**Web development and testing**

| Variable                                              | Default                         | Purpose                                                                                                           |
| ----------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `RUNTIME_HOST` / `RUNTIME_PORT`                       | `127.0.0.1` / `3001`            | Server that the Vite development proxy points to                                                                  |
| `E2E_BASE_URL` / `E2E_MODEL_SLOT`                     | `http://127.0.0.1:5181` / `e2e` | Address used when Playwright tests an external environment. The model role used by the plugin verification script |
| `COVEL_RANDOM_SEED`                                   | —                               | For server tests only: `ctx.random` in plugins gives the same numbers on every run                                |
| `CI`                                                  | `false`                         | CI mode. Affects how lint and Playwright behave                                                                   |
| `LIVE_LLM_ENABLED`                                    | `false`                         | Turns on tests that call real providers                                                                           |
| `COVEL_PG_PREFLIGHT_HOST` / `COVEL_PG_PREFLIGHT_PORT` | `127.0.0.1` / `5432`            | Target of the TCP check before `dev:pg` starts                                                                    |
| `COVEL_PG_PREFLIGHT_SKIP`                             | `false`                         | Set to `1` to skip the TCP check of `dev:pg`                                                                      |

**Packaging**

Only the Electron packaging tools and the desktop packaging scripts read these variables. For details, see [Desktop app packaging](../internals/desktop-packaging.md).

| Variable                      | Default                         | Purpose                                       |
| ----------------------------- | ------------------------------- | --------------------------------------------- |
| `CSC_LINK`                    | —                               | Path or URL of the code signing certificate   |
| `CSC_KEY_PASSWORD`            | —                               | Password of the code signing certificate      |
| `WIN_CSC_TIMESTAMP_SERVER`    | `http://timestamp.digicert.com` | Timestamp server used for Windows signing     |
| `APPLE_ID`                    | —                               | Apple developer account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | —                               | App-specific password used for notarization   |
| `APPLE_TEAM_ID`               | —                               | Apple developer team ID                       |

**Names that are not in the registry**

- `*_API_KEY` names are listed by code dynamically. The registry lists only common examples.
- `*_BASE_URL` has an effect only when the active `llm.toml` refers to it with `${VAR}`.
- `APP_BIND_IP` is read only by `docker/docker-compose.yml` and `docker/docker-compose.sqlite.yml`.
- `COVEL_MEMORY_V1`, `COVEL_STORY_BASE_URL`, `COVEL_PLUGIN_BASE_URL`, `VITE_API_URL`, and `LIVE_IMAGE_ENABLED` are not read by any code. You can delete them from your local config.

## Migration rules

Follow these rules when you add or change an environment variable:

1. First add a definition in `COVEL_ENV_REGISTRY`, and then mention it on this page.
2. Runtime code reads variables with the functions above. Reading `process.env` directly is reserved for cases where names are enumerated dynamically.
3. A new provider only needs to follow the `${PROVIDER}_API_KEY` naming. It does not need to be registered one by one.
4. Name a new feature switch with a clear capability name. Do not use a version number to show the development stage.
5. Use `isEnvEnabled()` for a switch that is off by default. Use `isEnvDefaultOn()` for a switch that is on by default, and state clearly in the registry which value turns it off.
6. `.env.example` and `.env.llm.example` contain only example values that are safe to publish.

## Runtime Contract

This section explains, one by one, the variables whose behavior is more detailed.

### Storage and deployment

**`STORE_BACKEND`, `MEDIA_BACKEND`, `VECTOR_BACKEND`**

- The default of `STORE_BACKEND` is `sqlite`.
- These three variables decide where data is stored. They are read with `readEnvChoiceStrict()`. A value outside the allowed range (for example writing `postgres` instead of `pg`) makes the service fail to start. The error message lists the values that are accepted. The system does not quietly fall back to the default.
- Variables that do not affect where data goes, such as `NODE_ENV`, are still read with `readEnvChoice()`. An unknown value falls back to the default.

**`DEPLOYMENT_TIER`**

- `self` is a local self-hosted deployment. A request from localhost can read the metadata of the provider keys that the server injects.
- `demo` / `commercial` require a session owner token.
- Even with `self`, when `NODE_ENV=production` and the storage actually in use is MemoryStore (the browser-private form, which public trials use), a session owner token is required; global world writes, community plugin server code, diagnostics, model database refresh, host configuration and media cleanup require the operator token; server settings cannot be written; and there is no Host check. This check looks at the storage that is actually injected, not only at the value of `STORE_BACKEND`. For the deployment steps, see [Deploy a trial on Render](../start/deploy-render.md).
- Case and surrounding spaces do not count. Any other value stops the server at startup, and the error lists the accepted values.
- At startup the server combines it with the storage and the tokens into its host profile; routes no longer read it themselves. For the rules of each tier, see [Security boundaries](../internals/security.md#host-profile); for authentication details, see the authentication section of [`api.md`](./api.md).
- The desktop app always passes `self` when it starts the server.

**`COVEL_DESKTOP_REST_TOKEN`**

- It is the operator token. Using it as a Bearer token passes the owner check of any session. Admin tools and e2e scripts rely on it.
- In the `demo` / `commercial` tiers, these operations must include it: creating, forking and listing sessions, world writes and dimension imports, AI world generation, model probing and refresh, and activating the server code of community plugins.
- If `DEPLOYMENT_TIER=demo|commercial` starts without it configured, the server refuses to start (a startup check of the host profile).
- The `self` tier does not require it at startup. But under the production MemoryStore, creating, changing, deleting, importing dimensions into, and saving server-generated content for global worlds all check it, and so do the other operator operations listed under `DEPLOYMENT_TIER`. If it is not configured, these operations stay off. Public reads and valid session access still work.
- A normal local or desktop session does not need a token. The desktop config interface has its own token check.
- This is a trust model with "one operator". It does not provide multi-tenant identity or a code sandbox. See the authentication section of [`api.md`](./api.md).

**`COVEL_BIND_HOST`**

- The default `127.0.0.1` means local and desktop deployments listen only on the loopback interface, and cannot be reached over the network.
- A container or multi-pod deployment must set `COVEL_BIND_HOST=0.0.0.0` explicitly (both Docker Compose files already do). Before listening publicly, check `DEPLOYMENT_TIER` and the authentication settings.

**`COVEL_ALLOWED_HOSTS`**

- The `self` tier answers only requests opened at `localhost`, `127.0.0.1` or `[::1]` (on any port). Every other host name gets `403 host_not_allowed`. This stops DNS rebinding: a malicious page that points its own domain at your machine still cannot drive the token-less API.
- To open a self-hosted web app from other machines, list the names it is opened by, for example `COVEL_ALLOWED_HOSTS=covel.example.com,192.168.1.20`. A port in an entry is ignored; only the host name is compared.
- Behind a reverse proxy, list the `Host` the proxy forwards. When the proxy rewrites `Host` to the upstream name (such as nginx's default `app:3001`), list that name.
- The `demo` / `commercial` tiers and the browser-private form on a production MemoryStore use their own authentication policy and skip this check. Setting it on these deployments makes the server refuse to start, because the value has no effect there.

**`COVEL_SOURCE_REPOSITORY` / `COVEL_SOURCE_COMMIT` / `RENDER_GIT_COMMIT`**

- They only tell players which code the site runs, and do not affect authentication or execution. `/api/health` reports them in `deployment.source`; see the [API reference](./api.md#get-apihealth).
- The repository address must be an `https` address with no user name or password; the commit must be 7–40 hexadecimal characters. Values that do not qualify are not reported.
- The commit comes from `COVEL_SOURCE_COMMIT` first, and from `RENDER_GIT_COMMIT`, which Render injects on every deploy, when that is not set. The project's `render.yaml` sets the repository address.

**`TRUSTED_PROXY_IPS`**

- The rate-limit middleware (`middleware/rate-limit.ts`) uses it to decide whether to trust `X-Forwarded-For`.
- SSRF protection for outbound requests is open by default to all public `https` hosts. So there is no variable such as "allowed model hosts".

**`COVEL_PG_LOCK_POOL_MAX`**

- The default is `16`. It is the upper limit of the connection pool used only for PostgreSQL session locks.
- Each turn that is in progress takes one connection. When several pods run at the same time, raise it according to the peak number of concurrent sessions.
- The timeout for getting a lock is 30 seconds. This includes all the time spent queuing in the pool and polling for the lock.

**`COVEL_PG_INGEST_LOCK_POOL_MAX`**

- The default is `4`. It is the PostgreSQL lock connection pool used only for semantic memory ingestion.
- Reading progress and hashing, calling embedding, and writing vectors all happen under a lock in the `memory-ingest` namespace. One session is handled serially across pods. Different sessions still run in parallel.
- It uses a separate small pool so that background provider requests cannot take up all the lock connections needed for player turns.

**`COVEL_MEDIA_CLEANUP_ENABLED`**

- The default is `false`. It decides whether `POST /api/media/cleanup` can be used.
- With `DEPLOYMENT_TIER=commercial` this endpoint always returns 503, so setting it to `true` on that tier makes the server refuse to start.
- For details, see the media management section of [`api.md`](./api.md).

### Desktop proxy

**`COVEL_DESKTOP_SYSTEM_PROXY_IPC`, `COVEL_SYSTEM_PROXY_URL`**

- When the desktop app selects the `system` proxy, the backend asks Chromium's system proxy through IPC for each target URL. It then tries the connection in the proxy order that the system returns.
- Electron injects the internal flag `COVEL_DESKTOP_SYSTEM_PROXY_IPC=1`. So ordinary Node IPC or cluster processes do not use this protocol by mistake.
- `COVEL_SYSTEM_PROXY_URL` supplies a static system proxy address for hosts without dynamic IPC; Electron resolves the proxy for each request URL over IPC.
- The proxy is used for the framework's own provider requests, model database updates, and GitHub plugin resolution and download. It does not apply to `fetchWithRetry` of third-party plugins.

### Model calls

**`COVEL_LLM_MAX_CONCURRENT`**

- The limit on text model calls running at the same time across the whole process. The default is `4`. `0` or a negative number turns this limit off. It is read by `packages/shared/src/llm-slots.ts`.
- Text, object, streaming, and evaluation calls from agents, functions, background jobs, and direct callers share the gateway queue. Embedding and media do not occupy text slots.
- Queue time credits an agent runtime deadline; functions keep their fixed execution deadline. Logical request budgets include queuing.
- A hosted deployment with many sessions can adjust it to the provider's throughput.

**`COVEL_COMPACTOR_CONTEXT_WINDOW`**

This is an **optional explicit override**.

- When it is not set, the compression threshold and the hard trimming budget for prompts use the most conservative model capabilities across all enabled text roles. That means the smallest `contextWindow` and the smallest `maxOutputTokens`. So when the story, plugin, and fast roles have different windows in the same turn, a larger window is not allowed through.
- It takes effect immediately after a hot reload of `llm.toml`. If the model capabilities are also missing, it falls back to `262144` / `16384`.
- When the story role is temporarily overridden in a request, the smaller of that value and the base budget is used.
- When this variable is set, the window is fixed at this value. The part reserved for output is still based on the conservative model capabilities.

**`COVEL_INSTRUCTION_LOCALE`**

- Takes `en` / `zh`. It is not set by default.
- Not set: sessions in Simplified Chinese read the plugins' `*.zh.md` prompts and the framework's Chinese instructions. Sessions in other languages read the English versions.
- `en`: all sessions read English.
- `zh`: all sessions prefer the Chinese version. Plugins without a Chinese version still read English.
- Instructions that plugin code writes (`pickLocaleText`, `instructionLocaleFor`, templates a plugin loads with `createPromptLoader`) follow it as well.
- It only decides the language of the instructions. It does not change the language of the session content. Use it to compare the effect of two instruction languages, or to fix one language for a particular model.

### Testing

**`COVEL_RANDOM_SEED`**

- For server tests only.
- When it is not set, a plugin's `ctx.random.int(min, max)` is `randomInt` from `node:crypto`.
- When it is set, the nth number that the same runtime (or the same RPC action) draws in a session is decided only by the seed, the plugin ID, the runtime ID, and n. So the dice rolled in the same scripted session are the same on every run.
- The count is kept in the process. When the same session ID is created again, counting starts from the beginning.
- Recording and replaying model requests is done by the external proxy `pnpm llm:replay`. The server process has no replay cache, and it has no matching environment variable.
- For how to use it with `e2e:verify --session-id` and `pnpm llm:replay`, see [Real model verification](../ship/real-model.md).

> [!WARNING]
> The seed makes the dice predictable. Do not set it in a deployment that players use.

### Snapshots, traces, and cleanup

**`COVEL_SNAPSHOT_INTERVAL_TURNS`**

- The default is `5`. It controls how often an automatic snapshot (`kind=auto`) is written.
- When `completedPlayerTurns <= 1`, a snapshot is always written. After that, one is written every N completed player turns. `1` means a snapshot every turn.
- A resumed suspension is not limited by this interval. It is always written.
- Each value of `completedPlayerTurns` has only one automatic snapshot. Its ID is `auto-<count>-<sessionId>`. Later background or resume commits under the same count refresh it in place. So the checkpoint includes the background results of that turn, and no second copy is stored.
- The reason it is not written every turn: building a snapshot reads the full message history and all of the session's data. If it were written every turn, the cost would grow with the square of the number of turns, and storage would also swell.

**`COVEL_AUTO_SNAPSHOT_RETENTION`**

- The default is `20`. It is the number of automatic snapshots kept for each session. `0` or a negative number keeps all of them.
- After each checkpoint is written, older `kind=auto` snapshots are deleted. A snapshot that is referenced as the `parentId` of a fork is not deleted. Manual snapshots and fork snapshots are not affected.
- The snapshot content does not include the framework's own control data (the namespaces `_jobs`, `_runtime_jobs`, `_runtime_job_control`, `_logs`).

**`COVEL_TRUSTED_SOURCES`**

Comma-separated GitHub `owner` or `owner/repo` entries; no sources are trusted by default. Overrides and locks `trust.sources`; shared forms use only this environment value. One invalid entry makes the whole variable unset and is logged at boot. See [trusted sources](./plugin-installation.md#trusted-sources) for matching, snapshot and digest rules.

**`COVEL_TRACE_RETENTION_DAYS`**

The default is `30`. `0` keeps everything.

What is cleaned up, and when:

- When it is set to N, after each run is committed, the runtime trace events of this session that are N days old are deleted. Event logs from before the same deadline are also deleted. The event log is the `events` table: a copy of each event that the event bus publishes. No code reads it back.
- At service start, and then at most once a day (triggered after some commit), the same cleanup runs for all sessions. So sessions that nobody plays anymore are also cleaned.
- A cleanup failure only logs a warning. It does not affect a commit or a request.

What is never cleaned up:

- The trace of the latest turn in each session. The execution status and the retry entry of a failed turn are read from its `turn.started` / `turn.completed` / `turn.failed` records. If you return to the session after the retention period, retry still works.
- The story, messages, and saves. A trace is only diagnostic data. The debug page can show only records within the retention period.

Who decides:

1. When this variable is set, its value is the operator's value, and it overrides the player's choice in settings. The settings page shows "This deployment fixes the value."
2. When it is not set, the player's choice in settings is used. It takes effect only in personal form, where desktop users and owners of persistent self-hosted web instances can change it. It is saved in the `server_settings` table of the server database. A change takes effect at the next commit or cleanup. See [`settings-store.md`](./settings-store.md).
3. If neither is set, the value is 30 days.

The browser-private form and the `demo` / `commercial` tiers ignore the saved value and use only this variable. All "settings that the server runs with" follow this order: environment variable, saved value, default.

A newly created SQLite database uses incremental auto-vacuum, so after cleanup it hands free pages back to the file. Old database files stay as they are: their space is reused, but the file does not shrink. See [`storage.md`](../internals/storage.md).

**`COVEL_SUSPENSION_TTL_MS`**

- The default is `604800000` (7 days). It controls how long an unresolved suspension is kept before it is cleaned up. `0` or a negative number turns cleanup off.
- There is no separate timer. Cleanup is forced once when the service starts. After that, it is triggered when someone requests the list of suspensions or resumes one, at most once an hour.
- **Records that are being resumed (claimed) and records that were resolved successfully are never cleaned up.**
- The same cleanup also releases claims left behind when a process exited partway through. So the suspension can be resumed or abandoned again. The SQLite and memory backends release all claims at startup. PostgreSQL releases only claims older than 1 hour, because another process may be resuming them. This step is not affected by turning this variable off.
- It is a framework-level switch, not a session setting of a plugin. For details, see the Suspend / Resume section of [`api.md`](./api.md).

### Plugin-related

**`COVEL_PLUGIN_LOG_LEVEL`**

- Takes `debug` / `info` / `warn` / `error`. It is the lowest level of a plugin's `ctx.logger` that is written to `_logs`.
- When it is not set, the development environment uses `debug`. With `NODE_ENV=production`, it uses `info`. Logs below this level are not written to storage.
- `warn` and `error` logs that reach the level are also written to the server log.

**`COVEL_EFFECTS_POLICY`**

The default is `warn`. It decides how to handle this case: two runtimes in the same parallel layer, where one reads and the other writes the same data, and neither declares a dependency on the other.

- `warn`: gives stable diagnostic information, and still runs in parallel.
- `strict`: gives the diagnostic, and also splits the conflicting pair into serial execution, in a fixed order by runtime ID. It does not add a dependency edge, so it cannot create a cycle. Runtimes without a conflict still run in parallel.
- Any value other than `strict` is treated as `warn`.

It is a framework-level switch (in the `feature` group), not a session setting of a plugin.

**Plugins' own environment variables**

- A switch that a plugin has itself is read by the plugin through `process.env`. It is written in the plugin's own `PLUGIN.md` / `README.md`. These variables do not go through the framework's reading functions, and they are not in the group table on this page.
- For a plugin's threshold settings, prefer each session's `userSettings` (read in a hook through `HookContext.getOwnSettings()`). Use an environment variable only as a fallback.

# Upgrade from v0.0.41 to v0.0.42

> [中文版](../../internals/upgrade-0.0.42.md)

This page is for people still on v0.0.41: players, operators, and authors of plugins and worlds kept outside the repository. It explains how to move to v0.0.42 safely and which authoring forms changed.

v0.0.42 replaces the plugin, world-data, and storage formats. **It does not automatically convert v0.0.41 databases, sessions, snapshots, or browser checkpoints.** Keep the old application and a complete backup, give v0.0.42 a fresh set of data, and create new sessions. Creating a new session in an old database does not repair the old database schema.

The linked reference pages define the exact fields.

## Preserve the old environment first

1. **Record what you have and stop writes.** Note the old application version, the storage backend in use, the database and media locations, the browser origin and profile, and the installed plugins and worlds. Stop every server, desktop app, and worker that uses the old database, and confirm that writes have stopped.
2. **Back up the application and configuration.** Back up the old app or installer, configuration, settings, and installed plugins and worlds.
   - For desktop, also back up the configuration root (normally `~/.covel/`) and the actual `<data_root>`. `[paths].data_root` in `config.toml` may have moved it.
   - `keys.env`, environment files, and browser keys can contain credentials. Keep them in an access-restricted place and never paste them into tickets or logs.
3. **Back up SQLite.** Copy the database file together with any matching `-wal` and `-shm` files. Do not copy only the main file, and do not move the companion files on their own while a process still has the database open.
   - A server run from source uses the actual `SQLITE_PATH`; the default development path is in the [environment variables page](../reference/env-registry.md#plugin-extension-development-data).
   - Desktop defaults to `<data_root>/covel.db`.
4. **Back up the media bytes.** Backing up the media records in the database is not enough. Check where the files are for the backend you use:
   - SQLite or the local file system: `MEDIA_ROOT` may set the media directory.
   - PostgreSQL: media may be inside the database. Use a consistent backup that your database administrator approves, and include application volumes and external media storage.
   - Browser local mode: media is in IndexedDB.
   - Docker Compose: in the SQLite stack the database and the media are both in the `appdata` volume; in the PostgreSQL stack consider both the `appdata` and the `pgdata18` volume.

> [!CAUTION]
> `pnpm docker:down-all` and `pnpm docker:pg:down-all` delete the data in the volumes.

After the backup, confirm that the files are readable and that the database backup can be restored, and keep the original backup.

About settings and keys:

- You do not have to wipe all settings. Ordinary settings accept only the current `schemaVersion: 2`. Unversioned or v1 development data is rejected and its content is left as it is. Rebuild the affected settings after the backup. (Later versions move v1 data aside under a backup name and start from the defaults; see the [SettingsStore contract](../reference/settings-store.md).)
- Keys use a separate channel. Before upgrading, confirm that you can configure them again securely, and do not put keys into an ordinary settings export.

## Start with new data

Pick the section that matches how you run Covel.

### Desktop

1. Quit the old app and back up the directories above.
2. Install the new app. Before it first uses the old database, point `[paths].data_root` to a **new directory without the old database**, then start it.
3. Keep the old `<data_root>` for rollback.

The configuration root still holds `config.toml`, `settings.json`, `llm.toml`, `keys.env`, and `plugins/`. Check the old settings and plugins there. Directory rules: [desktop configuration](../reference/desktop-config.md).

### Source / ordinary server, SQLite

1. Stop the old processes and back up the database, the WAL/SHM files, and media.
2. Set `SQLITE_PATH` to a new database file that does not exist yet.
3. Start the current server so that it creates the current schema.

Confirm the effective values of `STORE_BACKEND`, `MEDIA_ROOT`, and related variables. If you reuse the old media root, check its backup and references first, so that shared content is not cleaned up by mistake.

### PostgreSQL / Docker

- Deploy the current schema to a **new empty database**. Or use a SQL migration that was designed separately, reviewed, and tested on a copy of the backup.
- Do not treat the generated initial DDL as an upgrade script for an old database.
- Keep the backups of the old database, volumes, and external media.
- Check the Compose `DATABASE_URL` together with the volume mappings. Before starting, confirm that the application connects to the new target.

See [database maintenance commands](../reference/env-registry.md#database-maintenance-commands) and [store transactions](../reference/transactions.md#schema-changes).

### Browser local mode

Where the data is:

| Data                                    | Location                                         |
| --------------------------------------- | ------------------------------------------------ |
| Sessions and worlds                     | `covel-browser-vault` (IndexedDB) of that origin |
| Media, cache, and some application data | `covel-browser-cache` (IndexedDB)                |
| Ordinary settings                       | localStorage                                     |
| Keys                                    | stored separately                                |

1. Back up the old browser profile and site data.
2. Use the new version in an **independent browser profile or origin** and create new sessions.

Do not import old checkpoints directly, and do not treat "clear site data" as a backup. Remote mode still needs the steps for its server backend. See [storage architecture](./storage.md) and [SettingsStore](../reference/settings-store.md).

### Old data is not current-format data

The old SQLite `lorebook_entries` table uses a `plugin_id` column; the current schema requires `owner`. `CREATE TABLE IF NOT EXISTS` does not change the old table, so creating the new index can fail with `no such column: owner`. Creating a session, deleting a session, or resetting browser checkpoints cannot fix that table. Other old backend schemas are not guaranteed to start either.

**Do not treat old sessions, memory, execution results, exports, queued jobs, or snapshots as current-format data.** In the new store, import the updated world packages again and recreate sessions and snapshots. An old checkpoint is not a recovery point. Keep the old backups for inspection or for a migration developed separately. The [development-data note](../reference/env-registry.md#plugin-extension-development-data) records the known boundary.

### Installed plugins and worlds

Updating the source or the installer does not rewrite installed plugins and worlds.

1. Back up their installed directories.
2. Upgrade or reinstall versions that **pass the v0.0.42 loader checks**. Discovery may skip old packages.

A new database alone leaves incompatible plugin and world files in place. The directories plugins are discovered in are listed in [plugin installation](../reference/plugin-installation.md). Desktop keeps plugins in `plugins/` under the configuration root and user worlds in `<data_root>/worlds/` by default.

## Plugin and world author checklist

The left column is the v0.0.41 form or assumption. The right column is the current rule and what to do.

| Old form or assumption                                                                                                      | Current contract and action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flat manifests or multiple child `PLUGIN.md` files; package and runtime treated as one thing                                | The root `PLUGIN.md` declares the package identity, `provides/requires/optional/conflicts`, schemas, and `contributes`. Multiple runtimes go in `runtimes/<id>/RUNTIME.md`; a single runtime may be written as `runtime` in the root file; a package with no runtime is valid. `loadPluginDefinition()` returns `packageManifest` and `manifests`, and the UI uses `loadPluginUi()`; stop reading the old `definition.plugin` or primary `manifest`. Register the package entry, UI, events, and extensions once. See [plugin contracts](../reference/plugins.md#package-and-runtime-files).                                   |
| Cross-package dependencies name a concrete runtime ID; a bare `provides` is expected to satisfy a kernel extension point    | Cross-package inputs and `needs` use a versioned contract, declared in the root `requires` or `optional`. Runtime IDs remain valid inside one package. Declare extension points in the root `contributes.extensions` and register them in the entry; the kernel resolves dependencies against the implementations that are registered. See [plugin contracts](../reference/plugins.md#runtime-field-groups) and [extension points](../reference/extension-points.md).                                                                                                                                                          |
| Function `value.events`, `value.pluginData`, `value.interactions`, or `value.preGameDone` treated as effects or completion  | `value` is the business value as it is: an object, array, scalar, or `null`. Put writes in `HandlerResult.effects` and the completion state in `completion`. The internal `RuntimeResult.output`, `effects`, and `completion` are separate; a hook that changes a function's `output` must change `canonicalValue` too. Input bindings, schemas, and `recordAs` use the same business value. See [inputs and outputs](../reference/plugins.md#inputs-and-outputs).                                                                                                                                                             |
| Extension handlers read snapshot-style cross-plugin `pluginData`, or register arbitrary points                              | Use the typed `provideExtension(point, id, handler)` for known points. The host execution scope reads lazily by namespace with `readPluginData(pluginId, namespace)`; a provider handler uses `ctx.pluginData.get/list`, bound to itself. Share across plugins through public services or contracts. Check schema, ordering, timeout, and failure policy. See [extension points](../reference/extension-points.md) and [plugin communication](../reference/plugin-extensions.md).                                                                                                                                              |
| Private character mirrors, the old Lorebook identity, a textual `lastPlayerInput`                                           | Character schemas and records belong to the kernel World Model. Lorebook entries are told apart by owner: world, player, or a plugin. `ctx.playerMessage` is still text; `ctx.session.lastPlayerInput` is a structured submission or `null`. Background jobs need a complete `turn-digest@1`, including the list of final runtime states; recreate old jobs and snapshots. See [World Model](../reference/world-model.md) and [plugin contracts](../reference/plugins.md#inputs-and-outputs).                                                                                                                                  |
| World `dimensions.time`, data targeted at a plugin ID, old rule IDs                                                         | Time goes into a `world.time-definition@1` data source. `pluginPolicy` uses `requested` / `recommended`, and plugin data is imported to a `contract:<id>` target. Rule IDs projected from WorldIR are `world-ir-<SHA256(statement.id)>`, with the source ID kept in `sourceStatementId`; import old rules again. See [world time](../reference/world-time.md) and [world data](../reference/world-data.md).                                                                                                                                                                                                                    |
| Saving keys sends the full provider map; image generation guesses roles from tags or only checks that a plugin is installed | `saveSecrets`, `/api/config/keys`, and desktop `covel:keys:save` take a patch: a string sets, `null` deletes, and a provider that is not listed stays as it is. Writing keys to browser localStorage needs Web Locks on HTTPS or localhost. Image generation resolves the image slot explicitly, `ImagesContext.isAvailable()` is required, and a generated result carries the actual `target`; the narrative stage depends on `scene-stage@1`. See [SettingsStore](../reference/settings-store.md#secret-channel-boundaries), [model slots](../reference/slots.md), and [image generation](../reference/image-generation.md). |

Examples:

- To update the key of one provider, submit only `{"openai":"<new-key>"}`. To delete it, submit `{"openai":null}`. Never put real keys in tests, docs, or ordinary settings snapshots.
- A world time source can use `schema: contract:world.time-definition@1` and `to: contract:world.time-definition@1`, as in the [world time example](../reference/world-time.md#definition).

### Vector index

Embedding requests now carry the expected model identity. A changed model is rejected as an identity mismatch even when the vector dimension is the same, so vectors of two models are never mixed.

- To switch models on purpose, rebuild the index in a new development session. Where the source messages are kept, ingest again from them.
- Derived `__kernel:vector` progress does not travel with snapshots, forks, or browser transfer. An old checkpoint cannot be restored directly as a current session.

See [vector index and transfer](../reference/transactions.md#vector-index-initialization-and-transfer).

### How authors check their package

1. Run `pnpm validate:plugin <path-to-plugin>` to validate the package.
2. Run the relevant package tests.
3. Run `pnpm e2e:extensions` to check third-party behaviour after installation.

Command arguments and environment: [plugin testing](../plugins/testing.md).

Also check these again:

- The server projection of UI slots, the ownership of panel data, and media references. See [UI slots](../reference/ui-panels.md#kernel-ui-slots).
- Generated media must be published before its metadata becomes visible. A failed import must not clean up media bytes shared with other sessions. See [MediaStore](../reference/media-store.md).

## Verify and roll back

### Verify

On the isolated new data, check:

1. `/api/health` reports the storage and media backends you expect.
2. World and plugin discovery diagnostics are clean, and model slots and keys are configured.
3. You can create a new world session and complete setup and one turn.
4. After a restart the session loads, and its media renders.

Plugin authors also check output contracts, effects, extension points, the settling of background jobs, and browser and desktop recovery.

> [!NOTE]
> These are the acceptance steps for this installation. Local runs or live-model runs recorded in an earlier pull request do not show that this installation has passed.

### Roll back

If the new version fails to start or fails acceptance:

1. Stop the new process.
2. Restore, **together with the old application version**, the old database, WAL/SHM files, media, browser profile, installed packages, and configuration.

> [!WARNING]
> Never let the old version open the new schema, and never overwrite the only old backup with a new one.

If old progress must stay playable, keep running the old version until a separately validated migration exists. This version provides no automatic conversion and does not read both formats.

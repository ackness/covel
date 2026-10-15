# World catalog, install, and update

This page explains how to install a world someone else made from GitHub, how to update it, and which data is left alone during an update. Players and world authors should read the first half and the last section. People who build tool integrations should read the API section.

To make your own world, see [Your first world](../worlds/first-world.md). To publish a world together with the plugins it needs, see [Collections](../ship/collections.md).

The **official catalog** is [covel-worlds](https://github.com/covel-ai/covel-worlds).

- The home page is in English by default. There is also a Chinese README, and other languages can be added.
- Official worlds are listed first. Community worlds are listed separately.
- Authors submit a structured catalog entry through a PR. The content of the world can stay in the author's own repository.
- Worlds built into the main repository still ship with Covel. They are not updated through this catalog.

> [!WARNING]
> Being listed in the catalog does not mean a world passed a security review. Before you use a third-party world, read its prompts, settings, and media yourself.

## Steps in the settings page

1. Open **Settings → Install & manage**.
2. Enter a public GitHub repository link, or a link of the form `/tree/<ref>/<path>`.
3. The installer looks for worlds at that location. If there is a `world.yaml` at the root, that is one world. Otherwise, it lists the worlds one level down (including those under `worlds/`), up to 20.
4. Check the worlds you want to install, and confirm. Each one is installed separately.

Once the install succeeds, the world is ready to use right away. No restart is needed.

Rules:

- When you install several worlds at once, each one must have a different ID.
- When `world.yaml` has no `id`, the world's ID is the name of its folder; for a ZIP install, it is the ZIP file's name without `.zip`. When that name cannot be an ID (for example, it has spaces or capital letters), the install is refused; write an `id` in `world.yaml`.
- A normal install does not overwrite anything. If an ID conflicts with an existing folder or a world in the database, the install is refused.
- Only the world folders you selected are installed. No scripts are run, and no plugin is authorized for you.
- Plugins under the same link are listed together with the world, and you can install them in one confirmation. The installer does not tick plugins for you, and it does not look for the plugins a world needs somewhere else. The exception is when the repository lists them in a [collection manifest](../ship/collections.md).
- A world author should state the plugins it needs in `pluginPolicy`. Before a game starts, players check the content, the plugins needed, and their permissions.

**Download and safety limits** are the same as for plugin installs. See [Plugin install](./plugin-installation.md) for details:

- Looking up the version and downloading the archive both go through the proxy you have configured.
- The link has the same limits, and the downloaded content is checked against a fixed commit.
- The preview is signed, and it is valid for 15 minutes.
- The archive has a size limit. The limit applies to the whole GitHub archive, not just the folder you selected.

**Checks made during preview**: the world's manifest, its external dimension file, and its world data references are validated in a temporary directory. This step does not use the local world overrides on your machine, so it checks the package itself.

## API

These endpoints are controlled by the "allow install" switch. Writing a world also has to follow the global world write permission.

| Method | Path                                       | Behavior                                                                           |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| POST   | `/api/install/world/github/preview`        | `{url}` → `{items}`                                                                |
| POST   | `/api/install/world/github`                | `{token, acceptRisk:true}` → `201 {ok:true,kind:"world",id,restartRequired:false}` |
| GET    | `/api/install/worlds`                      | `{items:[{id,version,source,pendingUpdate}]}`                                      |
| POST   | `/api/install/world/github/update/preview` | `{id,url?}` → current, pinned, or available + preview                              |
| POST   | `/api/install/world/github/update`         | `{token,acceptRisk:true}` → `201 {ok:true,kind:"world",id,restartRequired:true}`   |
| DELETE | `/api/install/world/github/update/:id`     | Cancels a staged update. Returns `{ok:true}`                                       |

- **The shape of a preview** is the same as the preview for a plugin package: `id`, `version`, `description`, `author`, `source`, `token`, and `expiresAt`. `author` is the author name from the manifest. It is `null` if none is declared.
- `description` is `I18nText`, including summary translations merged by the loader from `world.<locale>.yaml`. Clients call `resolveI18nText` with the UI language.
- `hasServerCode` is always `false`. It means "this install path does not load code." It does not mean "there are no script files in this folder."
- The signatures for install and update are kept apart by "plugin or world" and by "install or update." One cannot be passed off as the other.
- The ZIP install endpoint `/api/install/world` is still available.
- During a GitHub install, the installer writes a source record named `.covel-install.json` into the world folder. Later updates depend on it. ZIP and manual installs do not create this record or support automatic update checks.
- Only the installer writes `.covel-install.json`. A world package that supplies this file returns 400, including variations in filename case. ZIP, GitHub, and collection members share this rule.

**Checks for a ZIP install.** Before the world record is created, the world data is checked for errors:

- If the descriptor or source is missing, if the source cannot be parsed, or if the data does not match the schema it ships with, it returns 400. The folder created for this install is removed. After you fix the problem, you can retry with the same ID.
- A warning does not block the install.
- The check does not use local overrides, and it does not run scripts in the package or the code of community plugins.

When a collection fails, rollback of an activated world uses the same deletion lifecycle and retains worlds with sessions. See the [batch installation contract](./plugin-installation.md#multi-package-preview-and-batch-install) for rollback result lists.

## Updates and data protection

**Checking for updates:**

- If you installed the default branch or a specific branch, you can check for updates by hand.
- If you installed a tag or a commit, the version is fixed, so there are no updates.
- To switch to another version, enter a link to a different version of the same repository and the same folder.
- Only the world folder you installed is compared. The interface shows the version, the commit, and the files added, changed, and deleted. An update asks you to confirm the risk once more.

**When an update takes effect:**

1. After you confirm, the new files are first downloaded and staged in `.covel-updates/<id>/` in the user worlds folder.
2. They are swapped in at the next backend restart, before the worlds are loaded and before file watching starts.
3. At startup, the source and the digests of all files are checked again. If the check fails, the old files are kept, and an error status is recorded.
4. If swapping the files fails partway, the old folder is restored.

Deleting a world also cancels its staged update.

At startup, before applying updates or loading worlds, unfinished `.covel-install-*` staging directories are removed from the user worlds directory and its `.covel-updates/` directory. Queued updates and transaction backups are retained for update recovery.

World deletion first moves the whole package into `.covel-world-delete-*`, then deletes the database record. If the process stops between these steps, the next startup restores the package to a folder named after its world ID in the user worlds directory. It keeps the "deleting" state and allows the player to retry deletion immediately. If the record is already gone, startup only removes the remaining files; it does not recreate the world. If the destination is occupied, identity is unclear, or the database is unavailable, the staged files are retained and a warning is logged. Other packages are never overwritten.

After the record is deleted, the staging directory is renamed to `.covel-uninstall-*` before recursive cleanup. Cleanup failure does not undo deletion; the next startup retries cleanup. A partial package cannot be loaded.

**What blocks an update:**

- You have added, deleted, or changed files of this world locally.
- You have edited this world in Covel. In that case the world record is marked `packageModified`. Later updates no longer overwrite it, and startup loading and file watching do not overwrite it either. You can keep using this edited version.

When files on disk change while the world record keeps its older content, the world list shows "Update available". This also covers bundled worlds changed by an app upgrade. To apply the package on disk, open world details and choose "Restore the package version". It replaces world data and settings while keeping saved sessions. This is separate from checking GitHub for a newer release in Settings. See [World records and world packages](./world-data.md#world-records-and-world-packages).

> [!CAUTION]
> Deleting a world affects the sessions that were started with it. Do not treat "delete and reinstall" as an update that keeps your data.

**What an update does not touch:**

- Updating a world does not delete or rewrite existing sessions, and it does not sync world data automatically.
- Data in a save that a player or a plugin has changed is handled separately by [world data sync](./world-data.md#preflight-and-sync). It runs a trial first, and then checks for conflicts.
- Overrides outside the world package are not affected by the file replacement. But they may change what the new package actually does.
- Rolling back files only swaps the files back. It does not roll back gameplay, and it does not migrate data.

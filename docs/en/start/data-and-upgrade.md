# Data, Backup and Upgrades

This page explains where the desktop app keeps its data, how to back it up, and what to check before an upgrade.

## Where Files Are

The first time the desktop app starts, it creates `~/.covel/`. The small configuration files are in this folder, and the data that takes up space is by default in the `data/` folder under it.

```text
~/.covel/                 configuration
  config.toml             data location, network proxy, log settings
  llm.toml                model role configuration (optional)
  keys.env                provider API keys, in plain text
  settings.json           settings in the interface: language, appearance, model bindings, plugin settings
  plugins/                the plugins you installed

~/.covel/data/            data (the location can be changed)
  covel.db                save database
  media/                  Stored images, audio and other media
  worlds/                 the worlds you installed and created
  logs/                   logs
    desktop.log           logs of the desktop program itself
    server.log            logs of the backend
```

If you do not want to browse the folders, **Settings → Desktop** lists all the paths, and you can open them with one click.

## Moving the Data to Another Disk

In **Settings → Desktop**, switch the data folder, or edit `~/.covel/config.toml`:

```toml
[paths]
data_root = "/Volumes/External/covel-data"
```

After you pick the new folder in Settings, Covel asks whether to bring your existing data along:

- **Copy my data**: quit and reopen Covel. At startup it copies the save database, `worlds/` and `media/` to the new location, switches to it only after the copy succeeded, and tells you the result in a dialog.
- **Start empty**: after a restart Covel uses the new location without your data.
- When the new folder already holds Covel data, Covel does not ask and does not copy: after a restart it uses that data as it is and overwrites nothing.

Whichever you choose, nothing in the old folder is moved or deleted. When the copy fails, Covel keeps using the old folder and a dialog says why.

> [!NOTE]
> Editing `config.toml` by hand copies nothing, and you need to restart Covel afterwards. A new location without data starts empty, and the old saves and worlds stay where they are. To bring them over, quit Covel first, then copy the database, `worlds/` and `media/` as the "Backup" section below describes.

## Backup

Quit Covel before you back up. While it runs, the database has two companion files, and these must be copied together with it.

| What to back up              | What to copy                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Saves                        | `covel.db`, plus `covel.db-wal` and `covel.db-shm` in the same folder (if they exist) |
| Your worlds                  | The whole `data/worlds/` folder                                                       |
| Plugins you installed        | The whole `~/.covel/plugins/` folder                                                  |
| Model and interface settings | `settings.json`, `llm.toml`                                                           |
| Keys                         | `keys.env`. It is in plain text, so keep it somewhere safe                            |
| Saved images and audio       | The entire `media/` directory under the active data root                              |

Restore the database and `media/` together under the new data root before opening Covel. If an earlier copy left media behind, manually copy `media/` from the old root first; files deleted from that root cannot be recovered without a backup.

If you only want to back up the interface settings, use "Export settings" under **Settings → Data**. It gives you a JSON file. API keys are not included by default.

> [!CAUTION]
> Do not move or delete `covel.db-wal` and `covel.db-shm` on their own while Covel is running. Doing so can damage your saves.

## Before an Upgrade

Covel is still in an early stage. Versions can have changes that are not compatible with each other, and **saves are not migrated automatically**. Before each upgrade:

1. Read the [changelog](../../CHANGELOG.md) for that version, and find the "Upgrade notes" and "Breaking changes".
2. Make a full backup using the method above.
3. If the changelog says the old database cannot be used any more, create a new save after upgrading. Keep the old backup, so you can go back to the old version.

When Covel starts, it checks which version wrote the save database. When this version cannot open it, the startup screen shows "Data from another Covel version", and Covel leaves the database unchanged. Then:

1. Quit Covel and back up the data directory.
2. As in [Moving the Data to Another Disk](#moving-the-data-to-another-disk) above, set `data_root` in `config.toml` to a new, empty directory.
3. Start Covel again; it starts from the empty directory. To keep playing the old saves, go back to the version that wrote them.

When the desktop app starts, it checks whether a new stable version is available. If there is one, a notice appears, and you can choose "Open download page" or "Ignore this version". It does not download or install anything automatically.

## Logs

When something goes wrong, first look at the two files under `~/.covel/data/logs/`:

- `desktop.log`: the window, startup, and supervision of the backend process.
- `server.log`: the output and request logs of the backend.

Logs rotate by size. Each file is 10 MB by default, and 10 copies are kept. The details of model requests and tool calls in each turn are not written to these files. They are in the app's Debugger page.

## Learn More

The [desktop configuration and data folder reference](../reference/desktop-config.md) has the full description of each file, including the proxy, the format of the key file, and how conflicts in the settings file are handled.

## Next Steps

- [Create your first world](../worlds/first-world.md)
- [Develop your first plugin](../plugins/first-plugin.md)

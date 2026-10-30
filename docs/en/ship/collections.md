# Collections

A collection is a list that says "these worlds and plugins should be installed together". The player pastes one link, ticks the items, confirms once, and everything is installed.

When to use it:

- You made a world, and you also wrote a few plugins for it.
- Your world needs a plugin that lives in someone else's repository.

A collection matters only at install time. After installation, each world and plugin in it is independent, and each can be updated and uninstalled on its own. For the world list’s "Update available" badge and how to apply a package version, see [World installation and updates](../reference/world-installation.md#updates-and-data-protection).

A collection does not pass its trust to members: each plugin is judged by its own receipt repository, including members pinned to another repository. Offline ZIP collections receive no trusted-source automatic approval; see [trusted sources](../reference/plugin-installation.md#trusted-sources).

## Make a Collection

Below, the things made in [the first world](../worlds/first-world.md) and [the first plugin](../plugins/first-plugin.md) are packed into one collection. Run the commands from the root directory of the Covel repository.

### 1. Generate the Folder

```bash
pnpm create-collection tidelamp-pack ~/tidelamp-pack
```

```text
tidelamp-pack/
├── covel-collection.yaml     manifest
├── README.md
├── plugins/
└── worlds/
```

### 2. Put the World and Plugins In

```bash
cp -R ~/.covel/worlds/tidelamp ~/tidelamp-pack/worlds/
cp -R ~/.covel/plugins/tavern-rumors ~/tidelamp-pack/plugins/
```

### 3. List Them in the Manifest

Open `~/tidelamp-pack/covel-collection.yaml`, and change the last two lines to:

```yaml
worlds:
  - path: worlds/tidelamp
plugins:
  - path: plugins/tavern-rumors
```

### 4. Check It

```bash
pnpm validate:collection ~/tidelamp-pack
```

```text
✓ tidelamp-pack: 1 plugin(s), 1 world(s) checked against Covel 0.0.51
```

When the manifest is empty, it gives this prompt:

```text
✗ (root): a collection lists at least one world or plugin
```

### 5. Publish It

Choose one of two ways:

- **Put it on GitHub.** Push `tidelamp-pack/` to a public repository. Players paste the repository link under **Settings → Install & manage**.
- **Pack it into one file.** Run the command below, and send the resulting ZIP to players. They drag it into the "Collection package" area on the same page.

```bash
pnpm pack:collection ~/tidelamp-pack ~/tidelamp-pack.zip
```

## How to Write the Manifest

```yaml
schemaVersion: 1
id: tidelamp-pack
name:
  zh-CN: 潮灯镇合集
  en-US: Tidelamp Pack
version: 0.1.0
covel: ">=0.0.51"
worlds:
  - path: worlds/tidelamp
plugins:
  - path: plugins/tavern-rumors
```

| Field                           | Notes                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `schemaVersion`                 | Always `1`                                                                         |
| `id`                            | The collection's ID: lowercase letters, numbers and hyphens                        |
| `name`, `description`           | The name and summary shown to players. Can be written separately for each language |
| `version`                       | The collection's own version. Used only for display                                |
| `author`, `license`, `homepage` | Author information. Used only for display                                          |
| `covel`                         | The Covel version it needs. See [Version ranges](#version-ranges)                  |
| `worlds`, `plugins`             | The worlds and plugins to install. 1 to 20 in total                                |

## Referencing Plugins From Someone Else's Repository

A plugin that a world needs may not be one you wrote. In that case, the manifest points to the repository where it lives:

```yaml
plugins:
  - repository: someone/covel-extra
    commit: 3f2a9c1e0b7d4a6f8c5e2d1b9a0f7e6d5c4b3a21
    path: plugins/weather
```

`commit` must be a full 40-character commit hash. This guarantees that after you publish, players always install the version you tested, and it cannot change silently because the other repository was updated.

A collection that contains members from someone else's repository cannot be packed into a ZIP. It can be installed only through a GitHub link.

## How a World Says What It Needs

A world does not name a specific plugin. Instead, it says which capability it needs:

```yaml
# worlds/tidelamp/world.yaml
pluginPolicy:
  requires:
    - action-check@1
```

This line means "I need a plugin that can do action checks". A collection that includes a plugin providing this capability works, and so does one that Covel bundles itself. When no plugin provides it, the check reports an error.

## Version Ranges

`covel` says "which versions of Covel this package needs". It can be written in the collection's manifest and in a plugin's `PLUGIN.md`.

```yaml
covel: ">=0.0.45"
covel: ">=0.0.45 <0.1.0"
```

- You can use `>=`, `>`, `<=`, `<` and `=`, and write versions as `X.Y.Z`.
- Separate several conditions with spaces. All of them must be satisfied.
- `^` and `~` are not supported.

When the player's Covel version is outside the range, the install is refused, and both version numbers are shown. The same applies to plugins that are already installed: if Covel is upgraded beyond the range, that plugin stops loading.

## What the Check Looks At

`pnpm validate:collection` checks the same things that the preview shows the player at install time:

| Problem                                                                                  | Result  |
| ---------------------------------------------------------------------------------------- | ------- |
| A capability a world needs has no plugin providing it                                    | Error   |
| A capability a plugin needs has no plugin providing it                                   | Error   |
| The current Covel version is outside the declared range                                  | Error   |
| The same world or plugin is listed twice                                                 | Error   |
| A capability is provided by several plugins, and the world does not say which one to use | Warning |
| A plugin the world wants is neither installed nor in the collection                      | Warning |

When there are errors, the command ends with a failure, so you can put it directly into automatic checks. Members from someone else's repository are not downloaded for checking. The command lists them and reminds you that the result is incomplete.

## What Happens When a Player Installs It

- The player sees a preview first. The preview does not write any file and does not run any code.
- The player ticks what to install and confirms once. The items are installed as a whole: plugins first, then worlds.
- If an item fails, packages installed by this request are rolled back. A world that acquired sessions during installation is retained to protect those saves; packages whose deletion fails are retained too. The error names retained packages so you can resolve them before retrying.
- Installing plugins requires restarting the backend once. Worlds are usable right away.
- Installation does not authorize code to run. Plugins still need session authorization: matching trusted sources can receive automatic grants; other cases ask the player.

When importing from a ZIP, there is no preview step, and a problem causes the install to be refused directly. All collection archives share the [installer’s extraction budget](../reference/plugin-installation.md#archive-limits); exceeding it rejects the request before writing.

Plugins in GitHub and offline collections follow the [installer’s runtime dependency rule](../reference/plugin-installation.md#what-the-installer-does-and-does-not-do). Authors must bundle dependencies into release files; the installer does not install dependencies for players.

Collection members cannot carry the installer's source receipt. Worlds and plugins share the [reserved-file rule](../reference/world-installation.md#api).

## Installing Several at Once Without a Manifest

When the repository has no `covel-collection.yaml`, after the player pastes the link they see all the worlds and plugins in that directory, and they can install them all at once in the same way. The manifest does two things: it specifies exactly what to install, and it references packages in other repositories.

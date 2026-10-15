# Install plugins and world packages

Besides the four built-in worlds and the set of plugins, you can install worlds and plugins that other people have made. This page takes you through installing them from a GitHub link, and tells you what to do after they are installed.

## Where to find them

- **[Plugin catalog](https://github.com/covel-ai/covel-plugins)**: official image and voice plugins and development examples, plus community plugins.
- **[World catalog](https://github.com/covel-ai/covel-worlds)**: official example worlds and community worlds.

You can also use the link of an author's repository directly.

## Install

Open **Settings → Install & manage**.

1. Browse the community catalog, or paste a public GitHub repository link. The link can point to a subfolder of the repository.
2. Parse the link. The plugins and world packages in that folder are listed together.
3. Check the items you want to install, confirm the ID, version, and source, read the code risk notice, and confirm once to install.

Selected packages are installed together, plugins first and then worlds. If any one of them fails, everything installed in this run is removed, so you are not left with a half-finished install.

Local ZIP packages are imported on the same page.

> [!WARNING]
> A plugin's server code **does not run in a sandbox**. It can reach the files and the network on your computer. Being listed in a catalog does not mean the code has been security audited. Install only plugins from authors you trust.

## After installing

| What you installed | When it is ready                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| World package      | Right away. It appears when you go back to the world selection page                                                      |
| Plugin             | You need to restart the backend once. In the desktop app, follow the prompt and click "Restart now". Your saves are kept |

After restarting the backend, complete two more steps before the plugin can run:

1. **Enable it**: select it in the plugin list on the world's session-prep screen, or have the world's gameplay pack include it.
2. **Authorize it**: the first time a community plugin needs to run code, the "Authorize plugin action" prompt appears. After you authorize it, it starts working. If you choose "Not now", the plugin stays paused, and the rest of the game keeps running as usual.

Authorization lasts only while the server is running. After you restart the backend, a community plugin asks for authorization again.

> [!NOTE]
> Plugins that the official project publishes but that you must install separately are treated like community plugins. They are not enabled automatically, and their authorization step is not skipped. Only plugins that ship built into Covel do not need authorization.

## Update and uninstall

Next to an installed package, click "Check for updates" to see what has changed. A confirmed update takes effect after the backend restarts.

- A package you have changed locally is not overwritten by an update.
- Updating a world package does not automatically rewrite the starting data of existing saves. They keep their own data and progress. To use the new starting data, start a new game.

You also uninstall from "Install & manage". After you uninstall a plugin, you need to restart the backend.

## Troubleshooting

| Symptom                                                      | What to do                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| You cannot select a package in the preview                   | Read the error next to it. Usually a capability it depends on is not provided by any plugin, or it needs a newer Covel version |
| The session-prep screen says the world is missing a plugin   | You can start without installing it, but the gameplay that plugin provides will not work                                       |
| The session-prep screen says no plugin provides a capability | The world cannot run without that capability (for example, dice checks). Install a plugin that provides it before you start    |
| A plugin is installed but does not run                       | Check in order: whether you restarted the backend, whether you enabled it in this game, and whether you authorized it          |
| The download fails                                           | Set up a proxy under **Settings → Desktop → Network Proxy**. Downloads follow the settings there                               |

## Learn more

- [Plugin catalog and install reference](../reference/plugin-installation.md)
- [World package install reference](../reference/world-installation.md)
- [Publish a world and the plugins it needs together: collections](../ship/collections.md)

## Next step

[Data, backup, and upgrades](./data-and-upgrade.md)

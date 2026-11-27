# Install plugins and world packages

Besides the four built-in worlds and the set of plugins, you can install worlds and plugins that other people have made. This page takes you through installing them from a GitHub link, and tells you what to do after they are installed.

## Where to find them

- **[Plugin catalog](https://github.com/covel-ai/covel-plugins)**: official image and voice plugins and development examples, plus community plugins.
- **[World catalog](https://github.com/covel-ai/covel-worlds)**: official example worlds and community worlds.

You can also use the link of an author's repository directly.

## Install

Open **Settings → Plugins → Install & manage**.

1. In **GitHub**, choose **Official plugins** or **Official worlds**. You can also paste a public repository or subdirectory URL and click **Preview**.
2. Search the preview by name, ID, or tag, then select the packages you want.
3. Check the version, source, commit, and code risk, then confirm installation. See the [batch installation and rollback rules](../reference/plugin-installation.md#multi-package-preview-and-batch-install).

Use **Local tools** to install a ZIP, import SillyTavern content, or validate a ZIP without installing it. The desktop import menu also opens this page.

> [!WARNING]
> A plugin's server code **does not run in a sandbox**. It can reach the files and the network on your computer. Being listed in a catalog does not mean the code has been security audited. Install only plugins from authors you trust.

## After installing

| What you installed | When it is ready                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| World package      | Right away. It appears when you go back to the world selection page                                                      |
| Plugin             | You need to restart the backend once. In the desktop app, follow the prompt and click "Restart now". Your saves are kept |

After restarting the backend, complete two more steps before the plugin can run:

1. **Enable it**: select it in the plugin list on the world's getting-ready screen, or have the world's gameplay pack include it.
2. **Authorize it**: if trusted-source authorization does not apply, the first time a community plugin needs to run code, the "Authorize plugin action" prompt appears. After you authorize it, it starts working. If you choose "Not now", the plugin stays paused, and the rest of the game keeps running as usual.

Explicit authorization lasts only while the server is running. Trusted-source code and runtime grants can pass automatically; other community plugins ask again after a restart.

> [!NOTE]
> Official plugins installed separately remain community plugins and are not enabled automatically. No source is trusted by default; see [trusted sources](../reference/plugin-installation.md#trusted-sources) for setup.

The preview lists the capabilities a package requests. Packages from a trusted source whose files are unchanged and request no new capabilities receive automatic code and runtime approval when enabled (showing "auto-approved: trusted source"). New capabilities, per-action requests, and locally modified files still prompt for approval; see [trusted sources](../reference/plugin-installation.md#trusted-sources).

## Update and uninstall

In **Installed**, search by name, ID, or repository. Next to a package, click **Check for updates** to see what has changed. A confirmed update takes effect after the backend restarts.

- A package you have changed locally is not overwritten by an update.
- Updating a world package does not automatically rewrite the starting data of existing saves. They keep their own data and progress. To use the new starting data, start a new game.

You also uninstall from "Install & manage". After you uninstall a plugin, you need to restart the backend.

## Troubleshooting

| Symptom                                                       | What to do                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| You cannot select a package in the preview                    | Read the error next to it. Usually a capability it depends on is not provided by any plugin, or it needs a newer Covel version          |
| The getting-ready screen says the world is missing a plugin   | You can start without installing it, but the gameplay that plugin provides will not work                                                |
| The getting-ready screen says no plugin provides a capability | You can start with that feature (for example, dice checks) missing. To add it, install and enable a plugin that provides the capability |
| A plugin is installed but does not run                        | Check in order: whether you restarted the backend, whether you enabled it in this game, and whether you authorized it                   |
| The download fails                                            | Set up a proxy under **Settings → Desktop → Network Proxy**. Downloads follow the settings there                                        |

## Learn more

- [Plugin catalog and install reference](../reference/plugin-installation.md)
- [World package install reference](../reference/world-installation.md)
- [Publish a world and the plugins it needs together: collections](../ship/collections.md)

## Next step

[Data, backup, and upgrades](./data-and-upgrade.md)

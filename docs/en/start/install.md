# Install and first launch

This page walks you through installing the desktop app and opening it. When you finish, you will see four bundled worlds on the world selection page.

## Before you start

- macOS: Apple Silicon chip, macOS 13.5 or later.
- Windows: x64.
- Other systems do not have an installer yet. You can [run from source](./run-from-source.md).

## 1. Download

Open the [Releases page](https://github.com/ackness/covel/releases/latest) and download the installer for your system. On macOS it is a `.dmg`. On Windows, use the recommended installer whose name ends in `-win-x64.exe`, or choose the Windows `.zip` if you do not want to install. A single-file self-extracting `portable.exe` is also available.

Every release includes `SHA256SUMS.txt`. You can use it to check the files you downloaded.

## 2. Install and open

The installer is not signed yet, so your system blocks it the first time you open it. This is expected. Follow the steps below once.

### macOS

Drag Covel into "Applications". If opening it says "is damaged and can't be opened", the app is not actually damaged. The installer is not signed or notarized, so macOS blocks an app downloaded through a browser. Click "Cancel", run the line below in Terminal, and then open the app again:

```bash
xattr -dr com.apple.quarantine /Applications/Covel.app
```

### Windows

Run the installer. If it says "Windows protected your PC", click "More info", and then click "Run anyway". If the browser blocked the download, first choose "Keep" in the download list.

For the no-install ZIP, right-click and choose “Extract All”, then run `Covel.exe` from the extracted folder. Do not launch it inside the ZIP window or move only the EXE. On later launches, open the program in that folder directly; it does not extract again.

The single-file `portable.exe` extracts again on every launch, shows a static preparation notice, and removes its extraction folder on exit. For frequent use without installation, prefer ZIP. System security scanning may happen before the notice appears. All three downloads use the same [data directories](./data-and-upgrade.md); saves do not move beside the EXE.

## 3. See the world selection page

The first time you open Covel, a getting-started guide appears. You can follow it, or click "Browse worlds first" to skip it. You can reopen it any time from the world selection page with the "Getting started guide" button.

After you close the guide, you see the list of worlds. It has four bundled worlds:

| World                                                | Style                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| 雾港・裂潮纪 (Mistport: The Riftide Chronicle)       | A dark-fantasy investigation in the traditional narrative style              |
| 遥风学园 (Harukaze Academy · Spring Mint)            | A campus ensemble story in stage mode                                        |
| Emberback Relay                                      | Frontier science-fiction mystery, written in English, with a Chinese edition |
| 提灯古冢・初次远征 (Lantern Barrow: The First Delve) | A classic tabletop dungeon crawl, with starting stats and dice checks        |

When you see this list, the installation is complete.

> [!NOTE]
> You can browse worlds now. Generating the story needs a working model; the next page explains how to connect one. Starting without a key prompts you to add it, or choose “Start anyway” and configure it later.

## Problems

| Symptom                                                | What to do                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS says "is damaged"                                | Follow the steps above and run the `xattr` command                                                                                           |
| Windows says "Windows protected your PC"               | "More info" → "Run anyway"                                                                                                                   |
| The window stays blank or keeps loading after it opens | Check the logs `~/.covel/data/logs/desktop.log` and `server.log`. For their location, see [data, backup, and upgrade](./data-and-upgrade.md) |
| Opening it again does not show a second window         | This is normal. Covel runs only one instance, and opening it again focuses the existing window                                               |

## Next step

[Connect a model](./models.md)

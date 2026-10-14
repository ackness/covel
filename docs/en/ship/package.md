# Package and trial-install

During development, your plugin stays in its own plugin folder. Other people receive an install package. This page teaches you to build a package, then install it the way a stranger would, use it once, and uninstall it.

Many problems only show up this way: a file is missing from the package, data is lost after a restart, or the game throws errors after an uninstall.

## Before you start

- Your plugin has passed [testing](./test.md).
- Covel is running.

## 1. Add the version and notes

Other people need to know three things: which version this is, what it does, and which version of Covel it needs.

The scaffold starts `PLUGIN.md` and `package.json` at `0.1.0`. Check the version before publishing, and update both when releasing a new version:

```yaml
id: "tavern-rumors"
kind: plugin
version: 0.1.0
covel: ">=0.0.51"
```

- `version` is the version of your plugin. `version` in `package.json` must match it.
- `covel` is the Covel version it needs. The scaffold already filled in the version from when it was created.

If the two version numbers do not match, validation tells you directly:

```text
✗ .../tavern-rumors: PLUGIN.md version 0.2.0 differs from package.json version 0.1.0
```

Then update `README.md`, and at least make these points clear:

- What it does, and what the player will see.
- Which settings can be adjusted.
- How to confirm that it is working.

If you want players to know who made it, add `author`, `license`, and `homepage` to `PLUGIN.md`. For the format, see [author information](../reference/plugins.md#author-information).

## 2. Pack it as a ZIP

Go into the plugin folder and pack its contents. Pack the **contents** of the folder, not the folder itself wrapped in another folder:

```bash
cd ~/.covel/plugins/tavern-rumors
zip -r ~/tavern-rumors.zip . -x "node_modules/*" ".*"
```

Open the ZIP. At the top level, you should see `PLUGIN.md` and `package.json`.

> [!IMPORTANT]
> When installing, Covel does not install dependencies for you, and it does not run any build commands. The code in the package must be ready to run as it is. Covel provides the plugin SDK `@covel/plugin-handlers-utils` and `zod`: `import` them directly, without bundling them.

## 3. Move the development copy out of the way

You want to test the installed package, so first move the original copy out of the plugin folder. Otherwise the install fails because it "already exists":

```bash
mv ~/.covel/plugins/tavern-rumors ~/tavern-rumors-dev
```

Then restart Covel.

## 4. Install it, use it once, then uninstall it

Open **Settings → Install & manage**, and import the ZIP you just made. Follow the table below step by step. Each step should show the result on the right:

| What to do                                           | What you should see                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Import the ZIP and confirm the risk notice           | Installation succeeds, and a notice says a restart is needed                                  |
| Import the same ZIP again                            | It is rejected, saying it already exists. The copy that was already installed does not change |
| Restart the backend                                  | The plugin appears in the installed list                                                      |
| Start a game, select it, but do not authorize it yet | It does not run, and the rest of the game works as usual                                      |
| Authorize it                                         | It starts working, and records appear in its panel                                            |
| Restart the backend again, and return to this game   | The earlier records are still there. It asks for authorization once more                      |
| Uninstall, then restart the backend                  | It disappears from the list, and the game carries on as usual                                 |

When all seven steps match, the package is ready to give to others.

> [!NOTE]
> Uninstalling deletes only the plugin's files. Data it stored in saves is not deleted.

## 5. Put the development copy back

```bash
mv ~/tavern-rumors-dev ~/.covel/plugins/tavern-rumors
```

## When it does not work as expected

| Symptom                                               | Cause and fix                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Import says `PLUGIN.md` cannot be found               | The ZIP has an extra layer of folder. Pack it again, and make sure `PLUGIN.md` is at the top level           |
| Import says it already exists                         | A folder with the same name is in the plugin directory. Move it away or uninstall it first                   |
| Import says the version does not match                | Your Covel version is not in the range written in `covel`                                                    |
| Installed, but at runtime it reports a missing module | The code uses a dependency that was not packed. Put the code it uses into the package too                    |
| Records are gone after a restart                      | The data was not really saved. Go back to [testing a plugin](./test.md), and add a case that checks the data |

## World packs work the same way

Packing a world package works the same way: go into the world folder, pack its contents as a ZIP, and `world.yaml` must be at the top level. Import it on the same page. It is ready to use once installed, and it needs no restart and no authorization.

## Next step

[Publish and update](./publish.md)

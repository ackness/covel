# Create a Covel extension with a development agent

This is for an agent that helps write plugins or world packages in a code workspace. This page uses the interfaces that already exist,
and it does not require a special skill to be installed. First read the `AGENTS.md` that applies to the workspace, then choose a task entry from this page.

## 1. Write down the deliverable

First record what the player should be able to do, the inputs and results, and the target framework version of the package.
For example: "After installing the community plugin, assign attributes with a number form. An invalid assignment is not written. Character data still exists after a restart."
Write down the rules, how they are saved, and the verification results. Avoid a broad goal such as "add tabletop features."

## 2. Choose the boundary and the material

| Need                                                       | Read first                                                                         | Where it is delivered                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Setting, characters, resources, and starting data          | [World data](./reference/world-data.md)                                            | A separate world package                                                                       |
| Reusable gameplay, narrative, tools, or interface          | [Plugin author guide](./plugins/essentials.md)                                     | A separate plugin package                                                                      |
| Adjust which plugins a world uses, or their defaults       | [World data](./reference/world-data.md), [plugin contract](./reference/plugins.md) | The world's `pluginPolicy` / `pluginSettings`                                                  |
| A general capability the current interfaces cannot express | [Design principles](./internals/design-principles.md), and the matching reference  | First describe the missing shared contract, then change the framework and its regression tests |

You do not need to read the whole repository. First read the tutorial and the matching field reference for the task. When they contradict each other, check the schemas, types, implementation, and tests that the [code search map](../README.md#search-map) points to, and fix the documentation to match.

## 3. Build the smallest package that runs

A plugin starts from the [directory, validation, and loading loop](./plugins/essentials.md#the-minimal-loop).
Run the commands from the root of the Covel repository by default:

```bash
pnpm create-plugin session-notes
pnpm test:runtime -- session-notes --pretty
```

This creates a plugin with mock cases in the user plugin directory. When you use a custom target directory, follow the author guide and set `--target` and the test's `--plugins-dir` to match.
Write logic must use the public tools or the plugin data interface, and must not call the framework's private store write interface.
Plain JSON output from the model cannot replace a tool call that needs to be completed.

A world package starts from the [WorldData specification and examples](./reference/world-data.md). First validate the setting without media,
the characters, and the plugin combination. Then add portraits, scenes, and localization. Do not guess at a CLI that does not exist from the name of a tutorial directory.

## 4. From deterministic checks to player actions

1. Validate the manifest, the data, and the key rules by following the [plugin testing guide](./plugins/testing.md). Cover invalid input and failure paths.
2. Pack it as a separate community ZIP, and verify installation, reinstallation, authorization, the actual calls, restart, and uninstall. Do not test only the loading of bundled repository content.
3. When the work involves a model or an interface, complete the [player flow acceptance](./internals/e2e-testing.md#player-flow-acceptance-before-a-release). A real model run should record failures, retries, and the final stored result. Explain any skipped items separately.
4. Run remote CI or release verification only after the local checks pass. Use an isolated save. Handle real model costs and external publishing according to the task's authorization.

## 5. Hand it over to the next user

- The package includes usage instructions, the required version, configuration, permissions, and the install and uninstall steps.
- Explain how to observe a successful result, how to reproduce the verification, and which platforms were actually covered and which limits remain.
- Plugins and world packages can be versioned independently. When a change affects a shared contract, update the reference and note the breaking change in the changelog.
- Do not put keys, private saves, logs, or the author's machine paths into examples or distribution packages.

Later development skills will reuse this workflow and the task-specific tutorials. This page does not change what permissions the in-game agent has.

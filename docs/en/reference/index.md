# Reference

The reference pages answer "what are the exact rules?" They give each field's type, default value, allowed options and error messages. If a tutorial and these pages disagree, go with these pages.

The tutorials are in the earlier chapters: [Create a world](../worlds/index.md), [Develop plugins](../plugins/index.md), and [Validate and distribute](../ship/index.md).

## Worlds

| Page                                                     | Contents                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [World manifest field table](./schema/world-manifest.md) | All fields of `world.yaml`                                                      |
| [World data](./world-data.md)                            | Import rules for data files, content that can be seeded in advance, hidden data |
| [World model](./world-model.md)                          | Data structures for characters, character attributes and the lorebook           |
| [Dynamic dimensions](./dynamic-dimensions.md)            | World state that changes during play                                            |
| [World time](./world-time.md)                            | Calendars, phases, and time advancement                                         |
| [World package installation](./world-installation.md)    | Install, update and uninstall                                                   |

## Plugins

| Page                                                          | Contents                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Plugin contract](./plugins.md)                               | The fields of `PLUGIN.md` and `RUNTIME.md`, and an overview of the built-in plugins |
| [Plugin manifest field table](./schema/plugin-manifest.md)    | All fields of the root manifest                                                     |
| [Runtime manifest field table](./schema/runtime-manifest.md)  | All fields of a runtime unit                                                        |
| [Tools](./tools.md)                                           | Built-in tools, proposal types, approval policy                                     |
| [Hooks](./hooks.md)                                           | Lifecycle events, payloads, and what a handler can return                           |
| [Extension points](./extension-points.md)                     | Extension points the kernel opens up                                                |
| [Plugin extensions and communication](./plugin-extensions.md) | Services, events, and passing results between plugins                               |
| [Prompt structure](./prompt-structure.md)                     | Which sections make up one model request                                            |
| [Plugin catalogue and installation](./plugin-installation.md) | Install, update, uninstall and trust                                                |

## Interface

| Page                                       | Contents                                                 |
| ------------------------------------------ | -------------------------------------------------------- |
| [Panels](./ui-panels.md)                   | Tabs and data sources of the right-side panels           |
| [Interface components](./ui-components.md) | Components available to declarative interfaces           |
| [Theme packages](./theme-packages.md)      | The format of theme packages                             |
| [i18n](./i18n.md)                          | Multilingual rules for the interface, plugins and worlds |

## Models and Media

| Page                                      | Contents                                       |
| ----------------------------------------- | ---------------------------------------------- |
| [Model roles](./slots.md)                 | Roles, providers, protocols and fallback rules |
| [Evaluation models](./evaluation.md)      | Models used for judging and classifying        |
| [Image generation](./image-generation.md) | How image generation is connected              |
| [Media store](./media-store.md)           | How images and audio are saved and referenced  |

## API and Storage

| Page                                         | Contents                                                     |
| -------------------------------------------- | ------------------------------------------------------------ |
| [HTTP API](./api.md)                         | All endpoints of the backend                                 |
| [SSE protocol](./protocol.md)                | Events pushed to the interface while a turn is running       |
| [Transactions](./transactions.md)            | How the writes of a turn are committed                       |
| [Settings store](./settings-store.md)        | The save format of interface settings, and conflict handling |
| [Environment variables](./env-registry.md)   | All environment variables                                    |
| [Desktop configuration](./desktop-config.md) | The desktop app's configuration files and data folder        |
| [Glossary](./glossary.md)                    | The definition of each term used in the docs                 |

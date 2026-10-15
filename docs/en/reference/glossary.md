# Glossary

This page defines the words used in the Covel docs, the code, and the UI. When the same thing is named differently in different places (for example, the UI says "model role" while the code says slot), this page is the reference: change the other places, not this one.

Entries are in English alphabetical order. Each entry first says what the term is in one or two sentences, and then gives a detailed page.

## Terms in Chinese

Each English term has only one Chinese term. The Chinese docs, the UI text, and the Chinese prompts (`*.zh.md`) all use the terms in this table.

<!-- prettier-ignore -->
| Term | Chinese | Notes |
| --- | --- | --- |
| Alias | 别名 | Another name for the same character (`aliases`). It is not a compatibility name for a field or ID. |
| Binding | 绑定 |  |
| Bundled plugin | 内置插件 | A plugin that ships with Covel. Not the same as `kind: core`. |
| Capability | 能力标签 | The `tag` of a model route (`text`, `image`, and so on). Plugins are found by **Contract**, not by capability tag. |
| Collection | 合集 |  |
| Contract | 契约 | A versioned ID, for example `narrative-engine@1`. |
| Credits | 作者信息 | The `author`, `license`, and `homepage` fields of a package. |
| Deployment form | 部署形态 | The desktop app, the self-hosted web app, the official web app. Not `DEPLOYMENT_TIER`. |
| Edition | 语言版本 | One language of a world: `defaultLocale`, and the language of each `world.<locale>.yaml` or `WORLD.<locale>.md` at the root. |
| Kernel | 内核 |  |
| Official web app | 官方网页版 |  |
| Pack | 玩法包 |  |
| PluginType | 插件类型 |  |
| Preset | 预设 |  |
| Proposal | 提案 |  |
| Provider | 提供商 |  |
| Runtime | runtime | Kept in English. It means one execution unit in a manifest, not the general word "runtime". |
| Runtime manifest | runtime 清单 |  |
| Segment | 提示词段 |  |
| Server-scoped setting | 服务端设置 | A setting with `scope: "server"`. All other settings are per-device settings. |
| Session | 会话 |  |
| Slot | 槽位 | In the settings UI it is called "model role". |
| Trigger mode | 触发模式 |  |
| Turn | 回合 | "This turn" is 本回合 in Chinese. |
| World | 世界 | A world's installation package is called a "world package". |

## Prompt vocabulary

These are the words used in prompt bodies to describe what a runtime reads and writes. Use one word for each thing: once you use `turn`, do not write `round`, and once you use `record`, do not write `row`. For how to write prompts, see [prompt style](../plugins/prompt-style.md).

<!-- prettier-ignore -->
| Term | Chinese | Meaning | Do not use these words for it |
| --- | --- | --- | --- |
| turn | 回合 | One message from the player, and everything each runtime does for it | round |
| narrative | 叙事 | The story text that the narrative runtime writes in this turn | story text, prose, the output |
| player | 玩家 | The person who plays the game | user |
| player character | 玩家角色 | The character the player controls | protagonist, hero, PC |
| NPC | NPC | A character that the player does not control |  |
| character | 角色 | A player character or an NPC |  |
| tool | 工具 | A function that a runtime can call | function, API |
| call | 调用 | Use a tool once | invoke, run, trigger |
| record | 记录 | One item stored in plugin data | row, object |
| entry | 条目 | An item in a list that the player reads, for example a codex entry | item (item means an object in the inventory) |
| item | 物品 | Something a character carries |  |
| dimension | 维度 | A piece of world state that the world defines and that changes with the story | attribute (attribute is for characters) |
| attribute | 属性 | A numeric or text field of a character | stat |
| world rule | 世界规则 | A world rule included in the prompt | lore entry |
| quest | 任务 | A goal that the story gives the player | mission, task |
| event | 事件 | Something that happens in the narrative, or a signal passed between runtimes |  |
| check | 判定 | Roll dice against a difficulty | test, roll (roll means throwing one die) |
| scene | 场景 | The place and time where the narrative is now |  |
| inject | 注入 | The framework puts a piece of data into the prompt | insert, provide |
| block | 区块 | A tagged section of the prompt, for example `<existing-quests>` | section (section means a heading subsection) |

## Alias

Another name for the same character: a nickname, a title that refers to one particular person, or a name written in another script. A character record puts these in `aliases`, next to `name`.

In one game, a name or alias refers to only one character. `resolveCharacter` can resolve an ID, a name, or an alias to a character. If two characters use the same name, it reports the ambiguity.

See: [World model](./world-model.md#aliases-and-name-resolution).

## Binding

A data path: a runtime says "I want to read another runtime's result". It is written in `io.inputs.<name>`.

- Inside the same package, the upstream runtime is found by runtime ID. Across packages, it is found by a versioned contract.
- A JSON Pointer (RFC 6901) can take only part of the result.
- The value taken is checked against `accepts`, and then it is passed to `ctx.inputs` or to the agent's prompt, together with its source.
- With `scope: committed`, it reads a result that an earlier execution has already saved, not the result of this execution.

See: [plugin field reference](./plugins.md), [turn pipeline](../internals/flow.md), `packages/shared/src/types/runtime-scheduling.ts`.

## Bundled plugin

A bundled plugin ships with Covel and lives under `plugins/`. Its source is `builtin`, so its code runs without player approval; a community plugin's code needs the player's approval. The bundled plugins are demos, not part of the framework: the framework must keep working when any one of them is removed. A bundled plugin is not the same thing as a `kind: core` plugin: `kind` decides whether a plugin is added to every game by default.

See: [built-in plugins and features](../builtin/index.md), [plugin field reference](./plugins.md).

## Collection

A list (`covel-collection.yaml`) of worlds and plugins to install together. It can also include packages from other repositories that are pinned to a commit.

It only matters at install time. What gets installed is still ordinary plugins and worlds, and each is updated and uninstalled on its own. It is different from a **Pack**. A Pack is a choice among plugins that are already installed.

See: [collections](../ship/collections.md), [plugin installation](./plugin-installation.md).

## Contract

A versioned ID, such as `narrative-engine@1`, that says what ability a plugin provides or needs.

- The root `PLUGIN.md` lists contracts with `provides`, `requires`, `optional`, and `conflicts`.
- A runtime publishes a contract with `io.output.contract`, and reads one with `from: { contract }`.
- The kernel finds providers by contract and never hard-codes a plugin ID. So plugins that provide the same contract can replace each other.
- Only the current version is supported. An incompatible change gets a new ID (`@2`).

See: [plugin field reference](./plugins.md), and the "Framework ↔ Plugin Isolation Rule" in the root `AGENTS.md`.

## Credits

The optional `author`, `license`, and `homepage` fields in a plugin, world, or collection manifest: who made the package and where to find them. The author information can also include a short text (`about`) and a few named `https` links.

It is for display only, and it is shown before the game starts. The framework makes no decisions based on it. A link opens only after the player confirms the third-party link warning.

See: [author information](./plugins.md#author-information), [security boundaries](../internals/security.md#package-credits-and-author-links).

## Deployment form

Covel runs in three deployment forms: the desktop app, the self-hosted web app, and the official web app. The first two are supported now; the official web app is not supported yet. Each one stores data in its own way. The commercial edition is not built yet, and this repository does not maintain it.

It is not the same thing as the deployment tier (`DEPLOYMENT_TIER`): the tier decides how strict authentication and the security checks are. See [Security boundaries](../internals/security.md).

See: [storage](../internals/storage.md).

## Extension point

A versioned connection point defined by the kernel, which plugins implement, for example `prompt.segment@1` or `ui.slot@1`.

A plugin declares which one it implements in `contributes.extensions`, and then registers it with `covel.provideExtension()`. When an extension point has several implementations, the mode decides how they are combined: `single` (take only one), `collect` (collect all of them), or `pipeline` (process them in turn).

It is different from a plugin's **Contract**. A Contract is defined by a plugin for other plugins to use.

See: [extension points](./extension-points.md), [plugin extensions and communication](./plugin-extensions.md).

## Kernel

The core of the framework. It schedules turns, assembles prompts, drives the model to call tools, validates proposals, and saves the results. All code outside the `plugins/` directory (`packages/`, `apps/server/src/`, `apps/web/src/`) belongs to the kernel.

See: [turn pipeline](../internals/flow.md).

## Narrator-only

The part of `WORLD.md` between the two lines `<!-- narrator-only -->` and `<!-- /narrator-only -->`. The model reads it. The "World" tab, the session-prep screen, and the world details page do not show it.

Its purpose is to avoid spoiling the story for the player. It is not secret: the world record and the files in the package both store the full text. Content that is revealed only when a condition is met uses a different mechanism, called hidden data (`visibility: hidden`).

See: [world data](./world-data.md).

## Official web app

The official web app is the web app that the Covel project plans to deploy for everyone to use. It is not supported yet. By design, the copy in the player's browser is the save (storage profile `browser-private`), and nothing is written to a database on the server.

See: [storage](../internals/storage.md), [storage mode notes](./api.md#storage-mode-notes).

## Pack

A named group of plugins (two sets, `requested` and `recommended`, plus tags) that together make up a way of playing, for example `traditional-story` or `dialogue-mode`.

When a player picks a gameplay pack on the session-prep screen, it replaces the plugins brought in by the previous pack in one step. Plugins the world itself requires, and plugins the player picked by hand, stay the same. A world sets its default gameplay pack with `pluginPolicy.preset` and adds the plugins it wants with `pluginPolicy.plus`. The packs are the built-in ones only (`packs/builtin.yaml`); a world does not define packs of its own.

It is different from a **Preset**. A Preset packages a model choice, not plugins.

See: `packs/builtin.yaml`, `apps/server/src/config/plugin-packs.ts`, [plugin field reference](./plugins.md), [world data](./world-data.md).

## Plugin kind and source

There are two separate ways to describe a plugin.

- **kind**: a field in the root `PLUGIN.md`, with two values. A `core` plugin is added to every game unless the player excludes it explicitly. A `plugin` is enabled only when it is selected. The loader compiles this into the internal `pluginType` (`core-plugin` or `plugin`).
- **Source** (`builtin` or `community`): decided by the directory the plugin is in. It does not depend on the manifest or the name. It decides whether the plugin loads automatically, how its tools are approved, and whether its server code needs player authorization.

A plugin maintained by the project but installed from outside the repository still has the source `community`.

See: [plugin field reference](./plugins.md), [plugin installation](./plugin-installation.md), [tools](./tools.md).

## Preset

An internal model plan. It holds the provider, the endpoint, the protocol, and a model ID that is passed through unchanged.

The settings UI shows a more intuitive "provider → model" hierarchy. The models defined in the UI are compiled into presets only when a request is sent. Users do not manage presets directly.

See: `packages/settings/src/`.

## Proposal

A request from a plugin to write something. The kernel writes it only after validation passes. A plugin never writes to the database directly.

The proposal types are defined in one place: `ProposalPayloadMap` (`packages/shared/src/types/proposal.ts`). They are currently: `narrative.append`, `state.patch`, `event.emit`, `interaction.request`, `ui.render`, `asset.generate`, `plugin.data`, `plugin.data.batch`, `plugin.data.delete`, `character.upsert`, `character.schema.set`, `dimension.initialize`, `dimension.update`, and `lorebook.upsert`.

See: [transactions](./transactions.md), [turn pipeline](../internals/flow.md).

## Provider

A specific model service: text, image, or vector (OpenAI, Anthropic, DeepSeek, Alibaba Cloud Bailian, and so on). Which provider is used is decided by the routing of a slot. It is called through the AI gateway. Plugin code never calls it directly.

See: `packages/ai-provider/`, [plugin field reference](./plugins.md).

## Runtime

The unit inside a plugin that actually runs. There are two kinds:

- `agent`: driven by the model. The body of `RUNTIME.md` (or the runtime inlined in the root manifest) is used as the system prompt.
- `function`: a pure JavaScript handler function.

A plugin package can have several runtimes. Each has its own trigger, stage, and dependencies.

See: [rules to know when writing plugins](../plugins/essentials.md), [plugin field reference](./plugins.md).

## Runtime manifest

The internal execution structure that the loader compiles from a runtime the author wrote. The runtime the author writes can be a `runtime` inlined in the root `PLUGIN.md`, or `runtimes/<id>/RUNTIME.md`.

- The author writes grouped fields: `type`, `schedule`, `io`, `agent`, `function`, `guard`, `effects`, and `permissions`.
- The compiled `RuntimeManifest` has `pluginId`, `name` (the runtimeId), `trigger`, scheduling information (`stage`, `needs`, `after`, `inputs`), `outputKind`, `outputContract`, `model`, and `permissions`.

Internal fields are not the author format. They cannot be copied into `PLUGIN.md`.

See: [plugin field reference](./plugins.md), [rules to know when writing plugins](../plugins/essentials.md).

## Segment

One section of an assembled prompt. The prompt-structure spec divides the prompt into 10 segments. Segments relate to caching: stable segments (world setting, plugin prompts) carry a `cache_control` marker, so the provider's prompt cache can be reused across turns.

See: [prompt structure](./prompt-structure.md).

## Server-scoped setting

A player setting that the server itself applies, for example how long diagnostic records are kept. A setting declares `scope: "server"` when it is registered. The server stores the value in its own database. All browsers on the same installation share one value, and only a `self` deployment lets the player change it.

All other settings are client-side: they are preferences of one device.

See: [settings store](./settings-store.md).

## Session

One game that a player is playing. Its ID has the form `{worldId}-{uuid8}`. It belongs to one world, and it has its own turn count, enabled plugins, snapshots, and events.

See: [HTTP API](./api.md), [transactions](./transactions.md).

## Slot

A named routing key used to choose a model (`story`, `plugin`, `memory`, `image`, and so on). In the settings UI it is called **model role**.

A plugin manifest writes only the slot's name. `llm.toml`, or the "provider/model" setting that was saved, binds it to a specific model. Fallback models are chosen only within the same kind of output: an image request never falls back to a text model.

See: [model roles](./slots.md), `llm.toml.example`.

## Trigger mode

How a runtime decides whether it runs in this turn: `auto` (the default), `manual`, or `event`. There are only these three. Any other value in a manifest is rejected when it loads.

It works together with two things:

- `stage`: the stage that an `auto` runtime belongs to. `event` / `manual` runtimes do not set a stage.
- The cadence of `auto`: `schedule.every` (run every how many turns), and `cooldownTurns`, `maxTriggerCount` and `startTurn` under `schedule.trigger`.

See: [plugin field reference](./plugins.md).

## Turn

One loop of the session: the player's input → decide which runtimes to trigger → run by stage (the next stage starts only after the current one is fully done; inside a stage, runtimes run in dependency order) → validate proposals → commit → push to the interface over SSE.

Each execution has an opaque `turnId`. A committed player turn advances `completedPlayerTurns`, a count that only goes up, at most once per logical turn. Which group of stages runs is decided by `session.phase`: `setup` runs the setup stage, and `playing` runs `pre-turn → narrative → post-turn → audit`.

See: [turn pipeline](../internals/flow.md), [SSE protocol](./protocol.md).

## World

A content package (`worlds/<id>/`) that contains `world.yaml`, `WORLD.md`, and optional data at the convention paths (such as `data/dimensions.yaml` and `data/rules/`). It provides dimensions, character settings, rules, scenes, and a media index.

The server loads worlds at startup from two places: the built-in directory `COVEL_WORLDS_DIR`, and the user worlds directory (`COVEL_USER_WORLDS_DIR`, which defaults to `<COVEL_HOME>/worlds` when not set; the default home is `~/.covel`). One world can have many games. For the loading process, see [startup loading and reconciliation](./world-data.md#loading-at-startup-and-reconciling-seed--reconcile).

See: [world data](./world-data.md).

## Related

- **The difference between pluginId and runtimeId**: see "Identity model" in the root `AGENTS.md`.
- **Plugin source**: see "Plugin kind and source" above, and [tools](./tools.md).
- **Terms not listed here**: `Branch`, `Snapshot`, `PluginData`, `CharacterRecord`, and `Lorebook` are covered in [transactions](./transactions.md).

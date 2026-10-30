# Glossary

This page defines the words used in the Covel docs, the code, and the UI. When the same thing is named differently in different places (for example, the UI says "model role" while the code says slot), this page is the reference: change the other places, not this one.

Entries are in English alphabetical order. Each entry first says what the term is in one or two sentences, and then gives a detailed page.

## Terms in Chinese

Each English term has only one Chinese term. The Chinese docs, the UI text, and the Chinese prompts (`*.zh.md`) all use the terms in this table.

<!-- prettier-ignore -->
| Term | Chinese | Notes |
| --- | --- | --- |
| Action | 行动 | One item of a player's submission: from which seat, as which character, what kind of thing (`submit_actions`). |
| Action kind | 行动类型 | A kind of action: the kernel's `say`, `act` and so on, or a plugin's `<pluginId>/<name>`. |
| Alias | 别名 | Another name for the same character (`aliases`). It is not a compatibility name for a field or ID. |
| Binding | 绑定 | An `io.inputs` connection that supplies an upstream value and its provenance to a runtime. |
| Bundled plugin | 内置插件 | A plugin that ships with Covel. Not the same as `kind: core`. |
| Capability | 能力标签 | The `tag` of a model route (`text`, `image`, and so on). Plugins are found by **Contract**, not by capability tag. |
| Capability snapshot | 能力快照 | The declaration bounds in an install receipt; see [trusted sources](./plugin-installation.md#trusted-sources). |
| Collection | 合集 | An install manifest that distributes worlds and plugins together; distinct from a Pack used during play. |
| Contract | 契约 | A versioned ID, for example `narrative-engine@2`. |
| Credits | 作者信息 | The `author`, `license`, and `homepage` fields of a package. |
| Dataset | 数据集 | Typed plugin data a plugin declares (`contributes.datasets`). Not the install-time **Collection**. |
| Deployment form | 部署形态 | The desktop app, the self-hosted web app, the official web app. Not `DEPLOYMENT_TIER`. |
| Edition | 语言版本 | One language of a world: `defaultLocale`, and the language of each `world.<locale>.yaml` or `WORLD.<locale>.md` at the root. |
| Execution | 执行 | One scheduled run and its commit plan; player turns, manual calls and background jobs can each start one. |
| Fault latch | 熔断 | A session-local pause after consecutive self-caused auxiliary plugin faults, cleared by the player or a process restart. See the [protocol](./protocol.md#plugin-fault-latch). |
| Finalizer step | 收尾步骤 | The one request, after an agent runs out of steps, that turns tools off and asks for the answer now. |
| Kernel | 内核 | The framework core that schedules work, assembles context, runs tools, validates proposals and commits writes. |
| Local model relay | 本地模型中继 | On a shared form, the server reaches a model on the player's computer or local network through the player's browser. See [Security boundaries](../internals/security.md#local-model-relay). |
| Official web app | 官方网页版 | A hosted product that is not yet supported; browser-private infrastructure alone is not the complete product. |
| Operation-based write | 操作式写入 | Submitting a list of operations (`plugin.data.update`) instead of a computed whole value. |
| Pack | 玩法包 | A player-selectable set of installed plugins, not an installer. |
| Perspective | 视角 | Whose point of view the narration takes: character-centred first, second or third person, an omniscient narrator, or a game master. |
| Plugin kind | 插件类型 | The package's `kind` controls default selection; distinct from runtime type and discovery source. |
| Presence record | 在场记录 | The IDs of the characters present, recorded on a story message (`presentCharacterIds`). |
| Preset | 预设 | An internal model connection plan containing the provider, endpoint, protocol and model ID. |
| Proposal | 提案 | A runtime’s request to write data, persisted only after kernel validation. |
| Provider | 提供商 | The model service selected through slot routing. |
| Recursive call | 嵌套调用 | A same-package runtime call whose writes commit with its parent; distinct from a read-only sub-agent. |
| Roleplay notes | 扮演说明 | What the world author writes in the `blueprint` field of a character record to tell the narrative how to play the character; read by Character Profiles. Not the character itself. |
| Runtime | runtime | Kept in English. It means one execution unit in a manifest, not the general word "runtime". |
| Runtime manifest | runtime 清单 | The internal execution structure compiled from an author’s manifest, not the authoring format. |
| Seat | 座位 | Who plays in a session, in which role, and which characters they control (`session.seats`). |
| Segment | 提示词段 | One section of an assembled prompt. A part of a story is a **Story segment**. |
| Server-scoped setting | 服务端设置 | A setting with `scope: "server"`. All other settings are per-device settings. |
| Session | 会话 | One game played in a world, with its own characters, plugin data and progress. |
| Slot | 槽位 | In the settings UI it is called "model role". |
| Stop reason | 结束原因 | How an agent tool loop ended (`RuntimeResult.stop.reason`). |
| Story segment | 故事段落 | One part of a story output: narration, dialogue or action. Called just "segment" (段落) when the context is clear. |
| Sub-agent | 子 agent | An agent runtime another runtime runs inside its own execution, returning output only. |
| Tool result | 工具结果 | Code-facing content and model-facing feedback have different shapes; success does not confirm persistence. |
| Trigger mode | 触发模式 | How a runtime is triggered: `auto`, `manual` or `event`. |
| Trusted source | 可信来源 | A GitHub source chosen by the instance owner or operator to reduce approval prompts. |
| Turn | 回合 | "This turn" is 本回合 in Chinese. |
| World | 世界 | A world's installation package is called a "world package". |

## Prompt vocabulary

These are the words used in prompt bodies to describe what a runtime reads and writes. Use one word for each thing: once you use `turn`, do not write `round`, and once you use `record`, do not write `row`. For how to write prompts, see [prompt style](../plugins/prompt-style.md).

<!-- prettier-ignore -->
| Term | Chinese | Meaning | Do not use these words for it |
| --- | --- | --- | --- |
| turn | 回合 | One player action submission and the pipeline each runtime runs for it | round |
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

## Action

One item of a player's submission. It says which seat it is submitted from (`seatId`), as which character (`actorId`), what kind of action it is (`kind`), and its text or structured fields. Answers to forms and choices are actions too. The server checks each action against the seat's role, then renders the actions into the `playerMessage` the model reads; function runtimes read them from `ctx.playerActions`.

See: [HTTP API: submit_actions](./api.md#submit_actions).

## Action kind

A kind of action. The kernel has six base kinds: `say`, `act`, `narrate` (narration), `direct` (a director's instruction), `advance`, and `command` (a slash command). A plugin declares its own kinds in `contributes.actionKinds`, written `<pluginId>/<name>` on the wire. The seat's role decides which kinds it may submit.

See: [Plugin field reference: action kinds](./plugins.md#action-kinds-contributesactionkinds), [World model: seats](./world-model.md#seats).

## Alias

Another name for the same character: a nickname, a title that refers to one particular person, or a name written in another script. A character record puts these in `aliases`, next to `name`.

In one game, a name or alias refers to only one character. `resolveCharacter` can resolve an ID, a name, or an alias to a character. If two characters use the same name, it reports the ambiguity.

See: [World model](./world-model.md#aliases-and-name-resolution).

## Binding

A data path: a runtime says "I want to read another runtime's result". It is written in `io.inputs.<name>`.

- Inside the same package, the upstream runtime is found by runtime ID. Across packages, it is found by a versioned contract.
- A JSON Pointer (RFC 6901) can take only part of the result.
- The value taken is checked against `accepts`, and then it is passed to `ctx.inputs` or to the agent's prompt, together with its source.
- With `scope: committed`, it reads a result saved by an earlier execution rather than this one. This scope cannot be combined with `select`.

See: [plugin field reference](./plugins.md), [turn pipeline](../internals/flow.md), `packages/shared/src/types/runtime-scheduling.ts`.

## Bundled plugin

A bundled plugin ships with Covel and lives under `plugins/`. Its source is `builtin`, so its code runs without player approval; community code follows the [approval and trusted-source rules](./plugin-installation.md#trusted-sources). The bundled plugins are demos, not part of the framework: the framework must keep working when any one of them is removed. A bundled plugin is not the same thing as a `kind: core` plugin: `kind` decides whether a plugin is added to every game by default.

See: [built-in plugins and features](../builtin/index.md), [plugin field reference](./plugins.md).

## Collection

A list (`covel-collection.yaml`) of worlds and plugins to install together. It can also include packages from other repositories that are pinned to a commit.

It only matters at install time. What gets installed is still ordinary plugins and worlds, and each is updated and uninstalled on its own. It is different from a **Pack**. A Pack is a choice among plugins that are already installed. It is also not a **Dataset**: a dataset is typed plugin data that a plugin declares.

See: [collections](../ship/collections.md), [plugin installation](./plugin-installation.md).

## Contract

A versioned ID, such as `narrative-engine@2`, that says what ability a plugin provides or needs.

- The root `PLUGIN.md` lists the contracts it needs and cannot coexist with in `requires` and `conflicts`, and the contracts no runtime outputs in `provides`.
- A runtime publishes a contract with `io.output.contract`, and reads one with `from: { contract }`.
- The kernel finds providers by contract and never hard-codes a plugin ID. So plugins that provide the same contract can replace each other.
- Only the current version is supported. An incompatible change gets a new ID (`@2`).

See: [plugin field reference](./plugins.md), and the "Framework ↔ Plugin Isolation Rule" in the root `AGENTS.md`.

## Credits

The optional `author`, `license`, and `homepage` fields in a plugin, world, or collection manifest: who made the package and where to find them. The author information can also include a short text (`about`) and a few named `https` links.

It is for display only, and it is shown before the game starts. The framework makes no decisions based on it. A link opens only after the player confirms the third-party link warning.

See: [author information](./plugins.md#author-information), [security boundaries](../internals/security.md#package-credits-and-author-links).

## Dataset

A dataset is a typed kind of plugin data that a plugin declares with `contributes.datasets`. Its name is the plugin-data namespace, every record must satisfy one JSON Schema, and it can name a key field and the operation kinds it allows.

It has nothing to do with a **Collection**, which is an install-time manifest (`covel-collection.yaml`). At commit, every proposal a plugin writes into its own dataset is checked against the declared operation kinds and schema.

See: [Datasets](./plugins.md#datasets-contributesdatasets), [world data](./world-data.md).

## Deployment form

Covel runs in three deployment forms: the desktop app, the self-hosted web app, and the official web app. The first two are supported now; the official web app is not supported yet. Each one stores data in its own way. The commercial edition is not built yet, and this repository does not maintain it.

It is not the same thing as the deployment tier (`DEPLOYMENT_TIER`): the tier decides how strict authentication and the security checks are. See [Security boundaries](../internals/security.md).

See: [storage](../internals/storage.md).

## Execution

One invocation of the execution pipeline, with an identity, a frozen registry and read baseline, runtime results, and a commit plan. Its `execution.origin` records why it started, such as a player action, a manual call, a background job, or a recursive call. Resume continues the suspended logical work with a new `executionId` and `origin: "resume"`, while retaining `logicalTurnId` and the counting responsibility.

`executionId` identifies a pipeline dispatch, `turnId` groups turn artifacts, and `runId` identifies one runtime attempt. Resume retains the source `turnId`, so it cannot distinguish individual resume dispatches. None of these IDs is the logical turn number. Setup, the opening and manual or background work do not advance `completedPlayerTurns`; a committed player turn advances it at most once.

See: [Turn pipeline](../internals/flow.md), [execution and commit](./protocol.md#execution-and-commit-are-two-steps).

## Extension point

A versioned connection point defined by the kernel, which plugins implement, for example `prompt.segment@1` or `ui.slot@1`.

A plugin declares which one it implements in `contributes.extensions`, and then registers it with `covel.provideExtension()`. When an extension point has several implementations, the mode decides how they are combined: `single` (take only one), `collect` (collect all of them), or `pipeline` (process them in turn).

It is different from a plugin's **Contract**. A Contract is defined by a plugin for other plugins to use.

See: [extension points](./extension-points.md), [plugin extensions and communication](./plugin-extensions.md).

## Finalizer step

The one more model request the kernel sends after an agent runtime runs out of steps: tools off, asking the model for its final answer from what it already has.

Running out of steps is not a success by itself. The runtime succeeds only when the finalizer step writes the answer, and its result's `stop.finalizer` is `true`. No finalizer is sent when the output is handed over by a completing tool, or when a completion condition is still unmet.

See: [the protocol reference's stop reasons](./protocol.md#stop-reasons).

## Kernel

The core of the framework. It schedules turns, assembles prompts, drives the model to call tools, validates proposals, and saves the results. All code outside the `plugins/` directory (`packages/`, `apps/server/src/`, `apps/web/src/`) belongs to the kernel.

See: [turn pipeline](../internals/flow.md).

## Narrator-only

The part of `WORLD.md` between the two lines `<!-- narrator-only -->` and `<!-- /narrator-only -->`. The model reads it. The "World" tab, the session-prep screen, and the world details page do not show it.

Its purpose is to avoid spoiling the story for the player. It is not secret: the world record and the files in the package both store the full text. Content that is revealed only when a condition is met uses a different mechanism, called hidden data (`visibility: hidden`).

See: [world data](./world-data.md).

## Official web app

The official web app is the web app that the Covel project plans to deploy for everyone to use. It is not supported yet. By design, the copy in the player's browser is the save (storage profile `browser-private`), and nothing is written to a database on the server. Public trial instances already run in this form; their limits are in [Play on a public trial](../start/hosted-trial.md).

See: [storage](../internals/storage.md), [storage mode notes](./api.md#storage-mode-notes).

## Operation-based write

An operation-based write submits a list of operations (`inc`, `upsertItem` and so on) against one plugin-data key, instead of reading the value, computing it and writing the whole value back. A plugin submits it with `ctx.pluginData.update` or a `plugin.data.update` proposal; the kernel applies the operations to the latest stored value inside the commit transaction. So two simultaneous "gold +1" both take effect.

See: [Transactions · Operation-based writes](./transactions.md#operation-based-writes-plugindataupdate).

## Pack

A named group of plugins (two sets, `requested` and `recommended`, plus tags) that together make up a way of playing, for example `traditional-story` or `dialogue-mode`.

When a player picks a gameplay pack on the session-prep screen, it replaces the plugins brought in by the previous pack in one step. Plugins the world itself requires, and plugins the player picked by hand, stay the same. A world sets its default gameplay pack with `pluginPolicy.preset` and adds the plugins it wants with `pluginPolicy.plus`. The packs are the built-in ones only (`packs/builtin.yaml`); a world does not define packs of its own.

It is different from a **Preset**. A Preset packages a model choice, not plugins.

See: `packs/builtin.yaml`, `apps/server/src/config/plugin-packs.ts`, [plugin field reference](./plugins.md), [world data](./world-data.md).

## Perspective

Whose point of view the narration takes. The bundled narrators' "Perspective" setting has five values. `character-first`, `character-second` (the default) and `character-third` centre on the player character and refer to them as "I", "you" or by name. `omniscient` is an all-knowing third-person narrator with no line reserved for the player. `dm` is a game master speaking to the players. Dialogue keeps each speaker's own person.

See: [Built-in plugins: story](../builtin/story.md).

## Plugin kind and source

There are two separate ways to describe a plugin.

- **kind**: a field in the root `PLUGIN.md`, with two values. A `core` plugin is added to every game unless the player excludes it explicitly. A `plugin` is enabled only when it is selected. Loaded package manifests and plugin summaries keep `kind`; compiled runtimes do not repeat it.
- **Source** (`builtin` or `community`): decided by the directory the plugin is in. It does not depend on the manifest or the name. It decides whether the plugin loads automatically, how its tools are approved, and whether its server code needs player authorization.

A plugin maintained by the project but installed from outside the repository still has the source `community`.

See: [plugin field reference](./plugins.md), [plugin installation](./plugin-installation.md), [tools](./tools.md).

## Presence record

Who was present in a story message: the speakers resolved at commit plus the characters in `cues.present`, stored in order of first mention as `presentCharacterIds`. It is only stored for now, ready for per-character history later.

See: [plugin contracts: story output](./plugins.md#story-output).

## Preset

An internal model plan. It holds the provider, the endpoint, the protocol, and a model ID that is passed through unchanged.

The settings UI shows a more intuitive "provider → model" hierarchy. The models defined in the UI are compiled into presets only when a request is sent. Users do not manage presets directly.

See: `packages/settings/src/`.

## Proposal

A request from a plugin to write something. The kernel writes it only after validation passes. A plugin never writes to the database directly.

The proposal types are defined in one place: `ProposalPayloadMap` (`packages/shared/src/types/proposal.ts`). They are currently: `narrative.append`, `event.emit`, `interaction.request`, `ui.render`, `asset.generate`, `plugin.data`, `plugin.data.batch`, `plugin.data.delete`, `plugin.data.update`, `character.upsert`, `character.schema.set`, `dimension.initialize`, `dimension.update`, and `lorebook.upsert`.

See: [transactions](./transactions.md), [turn pipeline](../internals/flow.md).

## Provider

A specific model service: text, image, or vector (OpenAI, Anthropic, DeepSeek, Alibaba Cloud Bailian, and so on). Which provider is used is decided by the routing of a slot. It is called through the AI gateway. Plugin code never calls it directly.

See: `packages/ai-provider/`, [plugin field reference](./plugins.md).

## Recursive call

A runtime call within the caller's own plugin, made through `ctx.recursiveCall`. It can produce domain writes. The nested results and their parent form one commit unit; a parent failure discards the nested writes too. It is different from a sub-agent, which returns output only and can be selected across packages by contract.

See: [Nested calls](./plugins.md#nested-calls-ctxrecursivecall), [sub-agents](./plugins.md#sub-agents).

## Runtime

The unit inside a plugin that actually runs. There are two kinds:

- `agent`: driven by the model. The body of `RUNTIME.md` (or the runtime inlined in the root manifest) is used as the system prompt.
- `function`: executed by a JavaScript handler, which may call tools, services or models when needed.

A plugin package can have several runtimes. Each has its own trigger, stage, and dependencies.

See: [rules to know when writing plugins](../plugins/essentials.md), [plugin field reference](./plugins.md).

## Runtime manifest

The internal execution structure that the loader compiles from a runtime the author wrote. The runtime the author writes can be a `runtime` inlined in the root `PLUGIN.md`, or `runtimes/<id>/RUNTIME.md`.

- The author writes grouped fields: `type`, `schedule`, `io`, `agent`, `function`, `guard`, `effects`, and `permissions`.
- The compiled `RuntimeManifest` has `pluginId`, `name` (the runtimeId), `trigger`, scheduling information (`stage`, `needs`, `after`, `inputs`), `outputKind`, `outputContract`, `model`, and `permissions`.

Internal fields are not the author format. They cannot be copied into `PLUGIN.md`.

See: [plugin field reference](./plugins.md), [rules to know when writing plugins](../plugins/essentials.md).

## Seat

A place in a session: who sits there (a human or nobody), in which role (player, host or spectator), which characters they control, and which one they play now. Seats are stored in the session record's `seats`. A new session has one human player seat that binds every character of type `player`. The story follows the current character of the primary seat.

See: [World Model: seats](./world-model.md#seats), [HTTP API](./api.md#session-seats).

## Segment

One section of an assembled prompt. The prompt-structure spec divides the prompt into 10 segments. Segments relate to caching: stable segments (world setting, plugin prompts) carry a `cache_control` marker, so the provider's prompt cache can be reused across turns. The parts of a story output are something else; see [Story segment](#story-segment).

See: [prompt structure](./prompt-structure.md).

## Server-scoped setting

A player setting that the server itself applies, for example how long diagnostic records are kept. A setting declares `scope: "server"` when it is registered. The server stores the value in its own database. All browsers on the same installation share one value, and only a `self` deployment lets the player change it.

All other settings are client-side: they are preferences of one device.

See: [settings store](./settings-store.md).

## Session

One game in progress. Its ID has the form `{worldId}-{uuid8}`. It belongs to one world, and it has its own turn count, enabled plugins, snapshots, and events.

See: [HTTP API](./api.md), [transactions](./transactions.md).

## Slot

A named routing key used to choose a model (`story`, `plugin`, `memory`, `image`, and so on). In the settings UI it is called **model role**.

A plugin manifest writes only the slot's name. `llm.toml`, or the "provider/model" setting that was saved, binds it to a specific model. Fallback models are chosen only within the same kind of output: an image request never falls back to a text model.

See: [model roles](./slots.md), `llm.toml.example`.

## Stop reason

How an agent runtime's tool loop ended, for example `completed` (the model gave its final reply), `max-steps` (the steps ran out) or `cancelled` (it was cancelled). There are ten identifiers.

It is written to `RuntimeResult.stop` and to the `stopReason` of the runtime lifecycle events. Function runtimes have no stop reason.

See: [the protocol reference's stop reasons](./protocol.md#stop-reasons), [turn pipeline](../internals/flow.md).

## Story segment

One part of a `narrative-engine@2` story output. Its `kind` is `narration`, `dialogue` or `action`; it may name its speaker in `speaker`, and its text is `text`. Each segment is one paragraph the player sees; the segment texts joined by blank lines form `narrativeOutput`.

See: [plugin contracts: story output](./plugins.md#story-output).

## Sub-agent

An agent runtime that another runtime runs inside its own execution: a function with `ctx.agents.run`, an agent with the `delegate` tool. It runs with the caller's brief, its own transcript and its own budget, and returns output only: it writes no data, emits no events and forms no commit unit. The provider sets `schedule.subagentOnly: true`, and the scheduler never runs it on its own.

See: [Plugin reference · Sub-agents](./plugins.md#sub-agents), [the delegate tool](./tools.md#sub-agents-delegate).

## Tool result

The result of one tool call. Plugin code can return business content directly or use the SDK's `covel.tool-result` to separate content, model feedback and staged effects. The executor formats model feedback as a success envelope or an `error` envelope. A staged write can still be rejected at commit.

See: [Tool result contract](./tools.md#results-and-writes).

## Trigger mode

How a runtime decides whether it runs in this turn: `auto` (the default), `manual`, or `event`. There are only these three. Any other value in a manifest is rejected when it loads.

It works together with two things:

- `stage`: the stage that an `auto` runtime belongs to. `event` / `manual` runtimes do not set a stage.
- The cadence of `auto`: `schedule.every` (run every how many turns), and `cooldownTurns`, `maxTriggerCount` and `startTurn` under `schedule.trigger`.

See: [plugin field reference](./plugins.md).

## Turn

One loop of the session: the player's input → decide which runtimes to trigger → run by stage (the next stage starts only after the current one is fully done; inside a stage, runtimes run in dependency order) → validate proposals → commit → push to the interface over SSE.

Execution artifacts carry an opaque `turnId`. Resume retains the source `turnId` and uses a new `executionId` for its dispatch. A committed player turn advances `completedPlayerTurns`, a count that only goes up, at most once per logical turn. Which group of stages runs is decided by `session.phase`: `setup` runs the setup stage, and `playing` runs `pre-turn → narrative → post-turn → audit`.

See: [turn pipeline](../internals/flow.md), [SSE protocol](./protocol.md).

## World

A content package (`worlds/<id>/`) that contains `world.yaml`, `WORLD.md`, and optional data at the convention paths (such as `data/dimensions.yaml` and `data/rules/`). It provides dimensions, character settings, rules, scenes, and a media index.

The server loads worlds at startup from two places: the built-in directory `COVEL_WORLDS_DIR`, and the user worlds directory (`COVEL_USER_WORLDS_DIR`, which defaults to `<COVEL_HOME>/worlds` when not set; the default home is `~/.covel`). One world can have many games. For the loading process, see [startup loading and reconciliation](./world-data.md#loading-at-startup-and-reconciling-seed--reconcile).

See: [world data](./world-data.md).

## Related

- **The difference between pluginId and runtimeId**: see [Runtime manifest](#runtime-manifest): `pluginId` identifies the package and its isolation and write ownership; `name` is the runtimeId used for scheduling and tracing.
- **Plugin source**: see "Plugin kind and source" above, and [tools](./tools.md).
- **Terms not listed here**: `Branch`, `Snapshot`, `PluginData`, `CharacterRecord`, and `Lorebook` are covered in [transactions](./transactions.md).

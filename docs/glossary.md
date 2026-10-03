# Covel Glossary

A canonical definition for the vocabulary used across Covel docs, code, and UI copy. When terms diverge between surfaces (e.g. a tooltip says "preset" but the code says "slot"), this page is the tiebreaker — align the other surface, not this one.

Terms are ordered alphabetically. Each entry includes a 1–2 sentence definition and a link to the authoritative doc.

## Terms in Chinese

One English term has one Chinese term. Chinese docs, UI copy and the Chinese prompt variants (`*.zh.md`) use the term in this table.

| Term             | 中文         | Note                                                                |
| ---------------- | ------------ | ------------------------------------------------------------------- |
| Binding          | 绑定         |                                                                     |
| Capability       | 能力标签     |                                                                     |
| Collection       | 合集         |                                                                     |
| Kernel           | 内核         |                                                                     |
| Pack             | 玩法包       |                                                                     |
| PluginType       | 插件类型     |                                                                     |
| Preset           | 预设         |                                                                     |
| Proposal         | 提案         |                                                                     |
| Provider         | 提供商       |                                                                     |
| Runtime          | runtime      | Kept in English: it names a manifest unit, not "运行时" in general. |
| Runtime manifest | runtime 清单 |                                                                     |
| Segment          | 提示词段     |                                                                     |
| Session          | 会话         |                                                                     |
| Slot             | 槽位         |                                                                     |
| Trigger mode     | 触发模式     |                                                                     |
| Turn             | 回合         | "This turn" is 本回合.                                              |
| World            | 世界         | A world package is 世界包.                                          |

## Prompt vocabulary

The words a prompt body uses for what a runtime reads and writes. A body uses one word for one thing: after `turn`, never `round`; after `record`, never `row`. See [prompt style](./guide/prompt-style.md).

| Term             | 中文     | Means                                                                   | Do not use for it                      |
| ---------------- | -------- | ----------------------------------------------------------------------- | -------------------------------------- |
| turn             | 回合     | One player message and everything the runtimes do for it.               | round                                  |
| narrative        | 叙事     | The story text that the narrative runtime wrote this turn.              | story text, prose, the output          |
| player           | 玩家     | The person who plays.                                                   | user                                   |
| player character | 玩家角色 | The character the player controls.                                      | protagonist, hero, PC                  |
| NPC              | NPC      | A character the player does not control.                                |                                        |
| character        | 角色     | The player character or an NPC.                                         |                                        |
| tool             | 工具     | A function the runtime can call.                                        | function, API                          |
| call             | 调用     | To use a tool one time.                                                 | invoke, run, trigger                   |
| record           | 记录     | One stored item of plugin data.                                         | row, object                            |
| entry            | 条目     | One item of a list the player reads: a codex entry.                     | item (an item is an inventory object)  |
| item             | 物品     | An object a character carries.                                          |                                        |
| dimension        | 维度     | A piece of world state that the world defines and the story changes.    | attribute (a character has attributes) |
| attribute        | 属性     | A numeric or text field of a character.                                 | stat                                   |
| world rule       | 世界规则 | A rule of the world that the prompt carries.                            | lore entry                             |
| quest            | 任务     | A goal the story gave the player.                                       | mission, task                          |
| event            | 事件     | Something that happened in the narrative, or a signal between runtimes. |                                        |
| check            | 判定     | A roll of dice against a difficulty.                                    | test, roll (a roll is one die)         |
| scene            | 场景     | The place and time the narrative is in.                                 |                                        |
| inject           | 注入     | The framework puts a block of data into the prompt.                     | insert, provide                        |
| block            | 区块     | A tagged part of the prompt: `<existing-quests>`.                       | section (a section is a heading)       |

## Binding

A typed data-flow edge declared in `inputs.<name>` between a producer runtime and a consumer runtime in the same execution. The kernel resolves the producer by runtime ID or capability, optionally selects a value with an RFC 6901 JSON Pointer, validates it against `accepts`, and exposes a provenance-wrapped value through `ctx.inputs` or the agent prompt.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/architecture/flow.md](./architecture/flow.md), `packages/shared/src/types/runtime-scheduling.ts`.

## Capability

A string tag on a runtime manifest that advertises what the runtime _does_ (e.g. `narrative`, `world-data-provider`, `image-generation`). Framework code discovers plugins by capability, never by hardcoded plugin ID.

See: [docs/reference/plugins.md](./reference/plugins.md), AGENTS.md "Framework ↔ Plugin Isolation Rule".

## Collection

A manifest (`covel-collection.yaml`) that lists worlds and plugins to install together, including packages pinned by commit in other repositories. It is a pointer list used at install time: what it installs are ordinary plugins and ordinary worlds, each updated and removed on its own. Distinct from **Pack**, which selects among plugins that are already installed.

See: [docs/guide/collections.md](./guide/collections.md), [docs/reference/plugin-installation.md](./reference/plugin-installation.md).

## Kernel

The framework runtime that schedules turns, assembles context, drives LLM tool-calls, validates proposals, and commits writes. Everything outside the `plugins/` directory (`packages/`, `apps/server/src/`, `apps/web/src/`) is kernel code.

See: [docs/architecture/flow.md](./architecture/flow.md).

## Pack

A named bundle of plugins (`requested` and `recommended` sets, plus tags) that assembles one coherent gameplay style — e.g. `traditional-story`, `dialogue-mode`. Players pick a pack on the session-prep screen to swap the whole plugin set at once; a world can default to one via `pluginPolicy.presetId`. Distinct from **Preset**, which bundles model/slot routing, not plugins.

See: `apps/web/src/lib/session-plugin-selection.ts`, [docs/reference/plugins.md](./reference/plugins.md), [docs/reference/world-data.md](./reference/world-data.md).

## PluginType

Two separate axes describe a plugin's provenance. `pluginType` is a manifest field with two values — `core-plugin` (bundled, non-disableable) or `plugin` (optional, disableable) — and only gates core-vs-third-party dispatch. Plugin source (`builtin` or `community`, derived from load path, not the name) governs auto-load and tool-approval policy.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/reference/tools.md](./reference/tools.md).

## Preset

An internal compiled model plan containing a provider, endpoint, protocol, and one opaque model ID. The settings UI exposes the clearer provider/model hierarchy and compiles browser-defined models into presets only at the request boundary; users do not manage presets directly.

See: `packages/settings/src/`.

## Proposal

A kernel-validated write envelope emitted by a plugin (never a direct DB write). Types are derived from the single source of truth `ProposalPayloadMap` (`packages/shared/src/types/proposal.ts`): `narrative.append`, `state.patch`, `event.emit`, `interaction.request`, `ui.render`, `asset.generate`, `plugin.data`, `plugin.data.batch`, `plugin.data.delete`, `character.upsert`, `character.schema.set`, `lorebook.upsert`.

See: [docs/reference/transactions.md](./reference/transactions.md), [docs/architecture/flow.md](./architecture/flow.md).

## Provider

A concrete LLM / image / embedding backend (OpenAI, Anthropic, DeepSeek, Aliyun DashScope, …). Providers are selected via slot routing and invoked through the AI gateway, never by plugin code directly.

See: `packages/ai-provider/`, [docs/reference/plugins.md](./reference/plugins.md).

## Runtime

The actual executable unit inside a plugin — either an `agent` (LLM-driven, loads `RUNTIME.md` (or root inline runtime) as system prompt) or a `function` (pure JS handler). One plugin package may export multiple runtimes with different triggers, stages, and dependency edges.

See: [docs/guide/plugin-authoring.md](./guide/plugin-authoring.md), [docs/reference/plugins.md](./reference/plugins.md).

## Runtime manifest

The parsed YAML frontmatter of a `PLUGIN.md`, plus derived fields. Carries the `pluginId`, `name` (runtimeId), `trigger`, the scheduling surface (`stage`, `needs`, `after`, `inputs`), `outputKind`, `capabilities`, `model`, `permissions`, and UI spec references.

See: [docs/reference/plugins.md](./reference/plugins.md), [docs/guide/plugin-authoring.md](./guide/plugin-authoring.md).

## Segment

A narrative slice inside the assembled prompt (one of the 10 slices in the prompt-structure spec). Segments are cache-aware: stable segments (world lore, plugin prompt) get `cache_control` markers so provider-side prompt caching can reuse them across turns.

See: [docs/reference/prompt-structure.md](./reference/prompt-structure.md).

## Session

A single player's ongoing playthrough. Identified by `{worldId}-{uuid8}`, pinned to one world, and owns its own turn counter, plugin scope, snapshots, and events.

See: [docs/reference/api.md](./reference/api.md), [docs/reference/transactions.md](./reference/transactions.md).

## Slot

A named routing key for model selection (`story`, `plugin`, `memory`, `image`, …), labelled **Model Role** in the settings UI. Plugin manifests declare a slot by name; `llm.toml` or persisted provider/model settings bind it to a concrete model; tag-aware fallback stays within the same modality.

See: [docs/reference/plugins.md](./reference/plugins.md), `llm.toml.example`.

## Trigger mode

How a runtime decides it should run on a given turn: `auto`, `scheduled`, `manual`, or `event` — the enum is closed, and a manifest declaring anything else is rejected at load. Combined with `stage` (which band an `auto` / `scheduled` runtime belongs to; `event` / `manual` runtimes declare no stage) and the `scheduled` sub-fields (`interval` / `cooldownTurns` / `maxTriggerCount` / `startTurn`).

See: [docs/reference/plugins.md](./reference/plugins.md).

## Turn

One tick of the session loop: player input → trigger routing → per-stage DAG execution (strict barrier between stages, dependency-ordered within a stage) → proposal validation → commit → SSE broadcast. Each execution has an opaque `turnId`; committed player turns advance the monotonic `completedPlayerTurns` clock at most once per logical turn. The band is selected by `session.phase` (`setup` runs the setup stage, `playing` runs `pre-turn → narrative → post-turn → audit`).

See: [docs/architecture/flow.md](./architecture/flow.md), [docs/reference/protocol.md](./reference/protocol.md).

## World

A bundled content package (`worlds/<id>/`) containing `world.yaml`, `WORLD.md`, and optional `data/world.data.yaml` sources for dimensions, character blueprints, rules, scene templates, and media indexes. Loaded at server boot from the bundled `COVEL_WORLDS_DIR` and the user world directory (`COVEL_USER_WORLDS_DIR`, otherwise `<COVEL_HOME>/worlds`, with `~/.covel` as the default home); one world powers many sessions. See [world loading](./reference/world-data.md#启动加载与收敛seed--reconcile).

See: [docs/reference/world-data.md](./reference/world-data.md).

## Related

- **pluginId vs runtimeId** — see AGENTS.md "Identity model".
- **Plugin sources** — see `pluginType` above and [docs/reference/tools.md](./reference/tools.md).
- **Outside scope here**: `Branch`, `Snapshot`, `PluginData`, `CharacterRecord`, `Lorebook` — see [docs/reference/transactions.md](./reference/transactions.md).

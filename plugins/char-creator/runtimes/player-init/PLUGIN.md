---
name: char-creator/player-init
description:
  zh: 开局引导你填写主角信息，并把主角加入故事。
  en: Guides you through creating your hero at the start and brings them into the story.
pluginType: core-plugin
stage: setup
outputKind: system
model: plugin
timeoutMs: 180000
maxSteps: 2
maxRetries: 0
callTimeoutMs: 60000
requireToolUse: true
tags:
  - role:pre-game
  - role:character
  - data:world-data
  - data:characters
  - cost:llm
  - ui:right-panel
guard: ./guard.js
trigger:
  type: auto
completeAfterTools: [create-form]
# Turn-scoped needs order player-init AFTER pregame and world-init/schema-gen in
# the same setup pass (the DAG edge) and gate it same-turn (the upstream gate):
# without a successful pregame there is no world summary to seed the opening form
# on, and schema-gen's set-world-schema tool populates `plugin_data.schema`, read
# here as `{{ world.schema }}`. A late-enabled setup plugin reuses the done-set
# fallback, so the gate is satisfied cross-execution too.
needs:
  - pregame
  - world-init/schema-gen
input:
  inject:
    # Pre-Game band: narrator is NOT scheduled in turn 0, so we inject
    # the deterministic opening text produced by pregame (priority 10)
    # instead. narrator only comes online in turn 1+ and is consumed
    # by main-loop plugins (guide, codex, character-tracker, etc.).
    - kind: runtime
      from: pregame
      field: narrativeOutput
      as: "<pregame-opening>"
    # world-init's schema write is a proposal and is intentionally uncommitted
    # until the setup execution finalizes. Carry the same value explicitly so
    # this downstream runtime never relies on a cross-runtime Store read.
    - kind: runtime
      from: world-init/schema-gen
      field: worldSchema
      as: "<same-turn-world-schema>"
tools:
  builtin:
    - create-form
dataSchemas:
  characters:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/characters.schema.json
    description: Importable session character records for the character panel.
ui:
  right:
    - ../../ui/character-panel.json
postHistory:
  role: system
  content: |
    本 runtime 工作流：
    - 调用一次 `create-form` 生成开场角色表单；工具成功后框架自动结束
    - `preGameDone: false`（玩家未提交 → Pre-Game 仍未结束）
    - 角色落库由 guard.js 在玩家提交下一轮时自动完成，**不要自行尝试创建角色**
---

你是玩家角色创建 agent。唯一任务是生成一次开场角色表单；角色落库由框架在玩家提交表单后完成。

开场摘要位于 prompt 末尾的 `<pregame-opening>` 块。

## 世界摘要

<world-summary>
名称：{{ world.name }}
简介：{{ world.description }}
开场：{{ world.openingScenario }}
</world-summary>

## 角色属性 Schema

优先使用 prompt 末尾的 `<same-turn-world-schema>`；它不存在时回退到：

<committed-world-schema>
{{ world.schema }}
</committed-world-schema>

---

## 工作流

1. 依据 `<pregame-opening>` 写 150-250 字、第二人称的角色诞生短叙事。
2. 调用 `create-form` 一次；工具成功后框架自动结束，不要输出额外文本。

表单规则：

- `characterName` 必须是 `required: true` 的 text 字段。
- 从 Schema 的 `character-attributes.attributes` 最多选 3 个字段，优先 `bio`、其次 `abilities`；不要选择数值型 `stats`。字段 `name` 必须严格等于属性 `id`，其余字段均为可选。
- 类型映射：`enum` → `select`，`string` → `text`，`number` → 3-5 个合理的 select 选项，`array` → 逗号分隔的 text。
- 需要解释 select 选项时使用 `{ value, label }`；`value` 保持适合嵌入叙事的短词。被 `narrativeTemplate` 引用的可选字段必须有自然的 `defaultValue`，select 默认值必须等于某个 option value。
- 固定传入 `formId: "char-creation"` 和 `submitBehavior: { "echoFilledNarrative": true, "immediate": true }`，加上合适的标题、提交文案、字段以及含字段占位符的 `narrativeTemplate`。
- 总字段数不超过 4。只调用一次 `create-form`，不要调用 `runtime-done`。

# World Data

`worldData` 是 world 包的统一数据入口。它把世界维度、角色卡、规则、场景模板和媒体索引声明成 source，再由服务器在 world load 或 session 创建阶段导入到现有 store。第三方插件也可以用同一套 descriptor 让 world 包携带插件数据。

## World Package

推荐结构：

```text
worlds/my-world/
├── world.yaml
├── WORLD.md
├── data/
│   ├── world.data.yaml
│   ├── dimensions.yaml
│   └── characters/cast.json
└── media/
    └── portraits/
```

`world.yaml`：

```yaml
schemaVersion: "1.0"
id: my-world
name: 我的世界
summary: 一个示例世界。
defaultLocale: zh-CN
requiredPlugins:
  - pregame
  - world-init
  - char-creator
recommendedPlugins:
  - character-blueprint
pluginPolicy:
  preset: traditional-story
  preferTags:
    - mode:traditional-story
  avoidTags:
    - mode:dialogue
worldData: data/world.data.yaml
```

`worldData` path 相对 world root。

> **@deprecated 顶层 `requiredPlugins` / `recommendedPlugins` / `excludedPlugins`**：仍可用（向后兼容），但**请改用 `pluginPolicy` 下的同名字段**。加载时框架会把顶层这三个字段**折叠进 `pluginPolicy`（去重合并）**，`WorldRecord.metadata` 只保留 `pluginPolicy` 作为插件选择的唯一来源。`pluginPolicy` 还能表达 `preset` / `packs` / `preferTags` 等场景意图，顶层字段无法表达。

`pluginPolicy` 字段：

| 字段                  | 说明                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `preset`              | 前端内置组合包 ID：`traditional-story`、`dialogue-mode`、`low-cost`。                                                        |
| `preferTags`          | 默认选中匹配这些插件 `tags` 的插件。                                                                                         |
| `avoidTags`           | 默认关闭匹配这些插件 `tags` 的插件。                                                                                         |
| `requireCapabilities` | 要求启用的机器能力标签。                                                                                                     |
| `requiredPlugins`     | 额外锁定启用的插件。                                                                                                         |
| `recommendedPlugins`  | 额外默认启用的插件。                                                                                                         |
| `excludedPlugins`     | 额外默认关闭的插件。                                                                                                         |
| `packs`               | 自定义组合包列表，每项可含 `id`、`label`、`description`、`plugins`、`optionalPlugins`、`excludedPlugins`、`tags`、`reason`。 |

### 启动加载与收敛（seed & reconcile）

服务器启动时按目录顺序 seed 世界：先 bundled（`COVEL_WORLDS_DIR`，默认仓库 `worlds/`），再 user（桌面版 `COVEL_USER_WORLDS_DIR=<data_root>/worlds`）。seed 是 **idempotent upsert**——每个世界包的 `WorldRecord` 写入 DB，`metadata.source = "file"`。

seed 本身**只新增/更新、从不删除**，所以一个曾经内建、后被归档（从包里移除）的世界会**残留在所有老用户的 DB 里**并继续出现在世界列表。为此 seed 完所有目录后会跑一次 **收敛（reconcile）**，删除"已不在任何世界源里"的陈旧 seed 记录。三重安全栏，确保只清死 seed、绝不误删用户数据：

1. **来源闸门**：仅 `metadata.source === "file"`（纯文件 seed）的世界可被清理。AI 生成的世界（`generated` / `generated-file`）及其它任何来源**永不触碰**，即便它不在当前世界源里。
2. **存档保护**：陈旧世界若仍有存档（session），**保留不删**并打 `warn` 日志；删除带存档的世界属于显式操作，不会由启动时的静默收敛执行。
3. **空集护栏**：本次一个世界都没 seed 成功时，**整体跳过收敛**——避免 seed 路径瞬时故障把 DB 里的世界一扫而空。

> 想清掉一个**仍有存档**的内建世界（收敛会因安全栏保留它），需显式删除其世界记录与关联 session。

### 插件配置默认值（`pluginSettings`）

`world.yaml` 顶层（与 `pluginPolicy` 平级）可声明 `pluginSettings`，为插件 `userSettings` 预置**世界默认值**，键为 `pluginId → settingKey → value`：

```yaml
pluginSettings:
  cost-gate:
    softTokens: 120000
    hardTokens: 160000
  chat-mode-narrator:
    dialogueRatio: 70
```

它是配置解析链的中间层：**玩家覆盖（`X-Plugin-User-Settings` header）→ 世界默认（`pluginSettings`）→ manifest 默认（`userSettings[].default`）**。玩家仍可在设置里覆盖每个值；未声明的 key 无害——runtime 只读插件真正声明过的 key。加载后写入 `WorldRecord.metadata.pluginSettings`，并在 `/api/actions` 回合边界与玩家 header 合并后注入 `TurnInput.userSettings`（供 agent 的 `{{ userSettings.* }}`、guard、hook 共用）。`pluginSettings` 只设默认值，不影响[插件选择](#world-package)（选择仍由 `pluginPolicy` 决定）。

### 世界记忆块（`memoryBlocks`）

`world.yaml` 顶层可声明 `memoryBlocks`，让世界添加**题材特有的核心记忆维度**（如侦探世界的 `clues` / `suspects`），无需 fork 插件。字段形状与插件 `PLUGIN.md` 的 `memoryBlocks` 完全一致（`label` / `displayName` / `extractionHint` / `icon?` / `maxChars?`）：

```yaml
memoryBlocks:
  - label: clues
    displayName: { zh-CN: 线索, en-US: Clues }
    extractionHint:
      zh-CN: 已发现的线索、物证及其与嫌疑人的关联。
      en-US: Discovered clues, evidence, and links to suspects.
    icon: Search
  - label: suspects
    displayName: { zh-CN: 嫌疑人, en-US: Suspects }
    extractionHint:
      zh-CN: 已知嫌疑人、动机与可信度变化。
      en-US: Known suspects, their motives, and credibility shifts.
```

加载后写入 `WorldRecord.metadata.memoryBlocks`。记忆系统**按 session 解析**块 schema：把该 session 所属世界的块**合并到**全局插件块之上——基础块（插件 / 框架默认）在标签冲突时优先（builtin 默认受保护），世界只**新增**未占用的标签。这样侦探世界的会话才会出现 `clues` / `suspects`，其它题材的会话不受影响。完整块字段见 [plugins.md #memoryblocks核心记忆块](plugins.md#memoryblocks核心记忆块)。

## Descriptor

`data/world.data.yaml` 使用 `sources` map：

```yaml
schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    schema: covel://world/dimensions
    to: world:metadata.dimensions

  cast:
    kind: json
    path: data/characters/cast.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
    after: dimensions
```

字段：

| 字段      | 必填 | 可选值 / 格式                                                                          | 说明                                                                                      |
| --------- | ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kind`    | yes  | `yaml`、`json`、`markdown`、`text`、`media`                                            | source 读取器类型。                                                                       |
| `path`    | yes  | 非空字符串                                                                             | 相对 descriptor root 的文件或目录。world 包相对 world root；override 相对 override root。 |
| `schema`  | no   | `covel://world/dimensions`、`plugin://<pluginId>/<namespace>`、或本地 JSON Schema path | 校验用 schema。`plugin://...` 是 schema URI。                                             |
| `to`      | yes  | 见 [Target URI](#target-uri)                                                           | 写入目标 URI。`plugin:<id>/<namespace>` 是 target URI。                                   |
| `key`     | no   | 简单字段名，例如 `id`、`characterId`、`filename`                                       | 批量 source 的稳定 key。media 常用 `filename`。                                           |
| `indexTo` | no   | `plugin:<id>/<namespace>`                                                              | 仅 media source 使用，把媒体索引写入插件数据。                                            |
| `effects` | no   | `characters`                                                                           | 额外投影；当前 `characters` 会把角色蓝图或简洁角色记录实例化为角色。                      |
| `after`   | no   | source id 或 source id 数组                                                            | source 顺序依赖。source id 必须先声明且满足命名规则。                                     |
| `enabled` | no   | boolean                                                                                | `false` 会跳过该 source。                                                                 |
| `locale`  | no   | 长度至少 2 的字符串                                                                    | source 对应的内容语言。                                                                   |
| `merge`   | no   | `replace`、`skipExisting`                                                              | 写入冲突策略。                                                                            |

### Locale 变体解析（`<name>.<lang>.<ext>`）

导入器按**会话 locale** 解析 source 文件，沿用 `WORLD.md` / 外部 dimension 的双语约定：对每个 source 的 `path`，先尝试 `<name>.<lang>.<ext>`（`lang` 为 locale 主子标签，`en-US` → `en`），命中则用之，否则回退到声明的 `path`。

```
characters/main-cast.json      # 默认（作者语言）
characters/main-cast.en.json   # en 会话自动选用
data/rules/tide-mystery.yaml
data/rules/tide-mystery.en.yaml
```

- locale 来自 session（创建时确定）；`importWorldDataForSession` / `syncWorldDataForSession` / `preflightWorldDataForSession` 的 `locale` 选项透传，缺省时回退到 `session.locale`。
- 对**任意** source kind 生效（`json` / `yaml` / `text` / `markdown` / `media` 目录）——变体不存在即回退，是纯 opt-in、非破坏。
- import ledger / `sync-data` 记录并比对被选中的变体文件摘要，故不同 locale 的会话各自独立、互不污染。
- 与 source 的 `locale` 字段无关：那是 source 内容语言的元数据；本机制是「按会话 locale 选文件」。

`source id` 必须匹配 `^[a-z][a-zA-Z0-9_-]{0,63}$`。descriptor 顶层目前只接受 `schemaVersion: 1` 和 `sources`。

## Target URI

当前支持：

| URI                                | 阶段           | 说明                                                                                       |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `world:metadata.<path>`            | world load     | 写入 `WorldRecord.metadata` 子路径；当前 world-load MVP 只投影 `world:metadata.dimensions` |
| `plugin:<id>/<namespace>`          | session create | 写入目标插件的 `plugin_data`                                                               |
| `plugin:<id>/<namespace>+lorebook` | session create | 写入 `plugin_data`，并同步生成 session lorebook row                                        |
| `lorebook`                         | session create | 直接写入 session lorebook                                                                  |
| `characters`                       | session create | 直接 upsert session character                                                              |
| `media` + `indexTo`                | session create | 导入媒体并把索引写入 `plugin_data`                                                         |

URI grammar：

| Syntax                                   | 用途       | 规则                                                                                                                                |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `plugin:<pluginId>/<namespace>`          | target URI | `pluginId` 匹配 `^[a-z][a-z0-9-]*$`；`namespace` 匹配 `^[a-z][a-zA-Z0-9_-]{0,63}$`。                                                |
| `plugin:<pluginId>/<namespace>+lorebook` | target URI | 同时写 `plugin_data` 和 lorebook。                                                                                                  |
| `plugin://<pluginId>/<namespace>`        | schema URI | 用于 `schema` 字段，指向插件 `dataSchemas.<namespace>`。                                                                            |
| `covel://world/dimensions`               | schema URI | 内置 world dimensions schema。                                                                                                      |
| `world:metadata.<path>`                  | target URI | path 只允许字母、数字、`_`、`.`、`-`；禁止 `__proto__`、`constructor`、`prototype`；当前拒绝 `world:metadata.characterBlueprints`。 |

`plugin://...` 和 `plugin:...` 的用途不同：`schema` 说明“用哪个 schema 校验”，`to` 说明“写到哪里”。因此同一个 source 通常同时写：

```yaml
schema: plugin://character-blueprint/blueprints
to: plugin:character-blueprint/blueprints
```

`plugin:*/*` 与 `indexTo` 都会做 preflight：

- 目标插件已注册。
- 目标插件在本 session 最终启用插件列表中。
- 目标 namespace 在插件 `dataSchemas` 中声明。
- `acceptsWorldData: true`。
- `schema` 为 `plugin://<id>/<namespace>` 时必须和 `to: plugin:<id>/<namespace>` 兼容。
- 插件包内 JSON Schema、world/override 本地 JSON Schema 或内置 schema 校验通过。

world load 阶段只强校验内置 schema 和本地 schema；`plugin://...` schema 在 session import/preflight 阶段结合当前启用插件严格校验。

## World-Init Schema Fast Path

`world-init` 的 guard（LLM 调用前的纯函数）按优先级决定角色属性 schema，命中即跳过 LLM。完整优先级见 [plugins.md #world-initschema-gen](plugins.md#world-initschema-gen)，要点：

1. 当前 session 已有数据 → 复用。
2. **世界声明的 `characterAttributes`（权威）** → 原样写入。
3. 同世界历史 session → 跨 session 复用。
4. 有 dimensions、无声明 → `deriveSchema(dimensions)` 推导通用属性（生命值、体力、货币、声望、能力阶层等）。
5. 都没有 → 才由 `schema-gen` agent 用 LLM 生成。

### 在 `world.yaml` 声明 `characterAttributes`（推荐）

高设定密度世界应**显式声明**角色属性，把世界独特机制写成稳定字段，而不是依赖 dimensions 推导或 LLM 临场生成。在 `world.yaml` 顶层（与 `pluginPolicy` 平级）声明 `characterAttributes` 数组（形状镜像 `AttributeDefinition`）：

```yaml
characterAttributes:
  - id: affection # CharacterRecord.fields 的机器键，需与角色卡 attributes 的键一致
    name: # 显示名，支持 I18nText（字符串或 { "zh-CN": …, "en-US": … }）
      zh-CN: 好感度
      en-US: Affection
    type: number # string | number | boolean | enum | array | object | map
    min: 0
    max: 100
    defaultValue: 0
    category: social # stats | bio | abilities | equipment | social
    description: # 可选，同样支持 I18nText
      zh-CN: 对玩家的好感
      en-US: Affection toward the player
```

- 加载后写入 `WorldRecord.metadata.characterAttributes`（兼容旧字段名 `metadata.schemas`）。
- guard 把它**原样**写成 session 的 `(world-init, schema, character-attributes)`，**优先于跨 session 复用**——因此编辑 `characterAttributes` 会在**新 session** 生效（已开局的旧 session 在 Pre-Game 时已锁定 schema，不会回溯更新）。
- `name` / `description` 的 `I18nText` 由框架按 locale 解析：右栏 `CharacterFieldsView` 按当前界面语言显示，注入 prompt 的 `<world-schema>` 也会先解析成单一语言。
- `id` 必须与角色卡（`character-blueprint`）`attributes` 里的键一致，否则字段会落到右栏的「其他」分组里显示原始键名。

自带世界 `mistport` / `haruka-academy` 已按此声明（见各自 `world.yaml`），可作模板。

## Character Blueprint Import

角色卡 source 示例：

```yaml
sources:
  cast:
    kind: json
    path: data/characters/cast.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
```

`cast.json` 可以是一张角色卡对象，也可以是角色卡数组。创建 session 时，服务器会：

- 写入 `plugin_data[character-blueprint][blueprints]`
- 根据 `effects: [characters]` 写入 `characters`
- 镜像到当前 session 已启用、且声明 `dataSchemas.characters.acceptsWorldData: true` 的插件

角色面板类第三方插件可以接收同一份角色记录。插件只要声明 `characters` namespace，并在 session 插件列表中启用，就会收到由 world data 实例化出的 CharacterRecord。

`effects: [characters]` 也接受简洁角色记录，例如 `{ "id": "mio", "name": "Mio", "type": "npc" }`。这种记录会直接生成 session character，并镜像到当前启用且声明 `dataSchemas.characters.acceptsWorldData: true` 的插件。

## Character Presence Portraits

给角色配头像 / 立绘并在 `character-presence` 面板与对话中显示，world 包用两条 source 交付：

```yaml
sources:
  portraits:
    kind: media
    path: media/portraits # 一层目录，放 <id>.png
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
    after: cast
  presence:
    kind: json
    path: media/presence.json
    schema: plugin://character-presence/presence
    to: plugin:character-presence/presence
    key: characterId
    after: portraits
```

- `media` source 把 `media/portraits/` 下的图导入媒体库，按 **`sha256(内容)`** 寻址（与 `@covel/store` media-store 的 `sha256(bytes)` 一致），并把索引写进 `plugin_data[character-presence][assets]`。
- `presence.json` 是 presence 记录数组，每条把 `characterId`（对上角色卡 `instantiate.characterId`，如 `npc-<id>`）的 `avatar` / `sprite` 指向那张图：

```json
[
  {
    "schemaVersion": 1,
    "characterId": "npc-kamishiro-mio",
    "displayName": "神代澪",
    "avatar": { "id": "<sha256-of-png>", "mime": "image/png", "size": 2155557 },
    "sprite": { "id": "<sha256-of-png>", "mime": "image/png", "size": 2155557 }
  }
]
```

`mediaRef.id` 必须是该图内容的 **64 位小写 sha256**——media source 导入后媒体库以同一 sha256 寻址，二者相等才能解析到资产。手算易错，仓库提供 `scripts/emit-presence.mjs <world>`，从 `media/portraits/` 自动生成 `presence.json`（**重生成立绘后必须重跑刷新哈希**）。

preflight 要求：`character-presence` 在 session 最终启用插件列表中（放进 `recommendedPlugins`），其 `assets` / `presence` namespace 已声明 `acceptsWorldData: true`（builtin 默认满足）。媒体受 v1 限制：单文件 ≤ 20 MB、单 source ≤ 100 MB、扩展名 allowlist（含 `.png` / `.webp`）。

实际范例见 `worlds/mistport` 与 `worlds/haruka-academy`（`data/world.data.yaml` + `media/`），提示词与生成流程见 `worlds/PORTRAITS.md`。

## Third-Party Extension

第三方库可以以 world 包或 override 包交付数据。插件作者推荐把数据契约写成 `plugin://<pluginId>/<namespace>` schema URI，再在 world 包里引用这个 schema。

独立 world 包：

```text
worlds/my-world-extra/
├── world.yaml
└── data/
    ├── world.data.yaml
    ├── characters/cast.json
    └── dimensions.yaml
```

给已有 world 增加本地覆盖：

```text
~/.covel/world-overrides/<world-id>/
├── world.data.override.yaml
└── data/
    └── characters/cast-extra.json
```

`world.data.override.yaml`：

```yaml
schemaVersion: 1
sources:
  cast-extra:
    kind: json
    path: data/characters/cast-extra.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
    after: cast
```

override path 相对 `~/.covel/world-overrides/<world-id>/`，并会做 realpath containment。

### 配套插件数据

插件可以为自己的 namespace 约定一个 schema URI：

```yaml
sources:
  social-links:
    kind: yaml
    path: data/social/links.yaml
    schema: plugin://social-sim/relationships
    to: plugin:social-sim/relationships
    key: id
    after:
      - cast
```

插件侧需要做到三件事：

1. 在 `PLUGIN.md` 写清楚 namespace、schema URI、数据形状和示例文件。
2. 在 runtime 或工具中读取 `plugin_data[<pluginId>][<namespace>]`。
3. 给 world 包作者提供最小可运行的 `data/world.data.yaml` 片段。

插件需要在 `PLUGIN.md` frontmatter 声明 `dataSchemas`：

```yaml
dataSchemas:
  relationships:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/relationships.schema.json
    description: Importable relationship records.
```

`schema` 是插件根目录相对路径，当前要求 JSON Schema 文件。多 runtime 插件可以在多个 runtime 的 `PLUGIN.md` 中声明同一 namespace；声明内容一致时会合并到 plugin-level registry，冲突时插件注册失败。session 自动导入会读取该 schema 并用 Ajv 校验每个 source item。

插件数据文件建议使用数组作为批量格式：

```yaml
- id: mio-rin
  from: kamishiro-mio
  to: asakura-rin
  type: clubmate
  score: 42
```

对应的 schema URI：

```yaml
schema: plugin://social-sim/relationships
to: plugin:social-sim/relationships
key: id
```

创建 session 时，框架会把每条实际提交的 `plugin_data`、`lorebook`、`character`、`media index` 写入 `world_data_import_ledger`，记录 `target`、`pluginId`、`namespace`、`key`、`sourceDigest`、`valueHash`、`schemaRef` 和 `sourceId`。session 创建会用 store transaction 包住 session、plugin-data、lorebook、characters 与 ledger 写入；导入失败时会回滚这些 store row。

### Preflight 与 Sync

开始游戏前可以调用：

```http
POST /api/worlds/<world-id>/world-data/preflight
```

请求传 `plugins` 时按当前插件选择预检；传 `sessionId` 时按已有 session 的 active plugins 预检。内置 Web UI 在开始游戏前会自动调用该接口，展示 planned writes、目标摘要和 diagnostics。

已有 session 可以调用：

```http
POST /api/worlds/<world-id>/sync-data
```

默认 dry-run，返回 `upserted`、`deleted`、`unchanged` 和 `conflicts`。传 `dryRun:false` 才写入。同步规则：

1. 只处理 ledger 中 `managed=true` 且 `sourceWorldId` 匹配当前 world 的 row。
2. 当前目标 row 的 hash 与 ledger `valueHash` 一致时才自动覆盖或删除。
3. 目标 row 被玩家或插件改动时返回 `conflicts.reason = "modified"`。
4. planned write 仍存在但目标 row 缺失时返回 `conflicts.reason = "missing"`。
5. source 已移除且目标 row 也已缺失时，只清理 stale ledger，不报告 conflict。
6. 传 `force:true` 时允许覆盖 modified/missing 冲突。

media index 同步删除只移除当前 session 的 media ref。只有 asset owner 是当前 session 且没有其他 refs 时，服务器才会删除底层 content-addressed media asset。

### World 包与插件包的边界

插件包放执行逻辑、UI、schema 文档和默认示例。world 包放具体世界数据和媒体资源。第三方库同时交付插件与世界数据时，推荐结构如下：

```text
my-covel-pack/
├── plugins/
│   └── social-sim/
│       ├── PLUGIN.md
│       └── handler.js
└── worlds/
    └── haruka-social-extra/
        ├── world.yaml
        ├── WORLD.md
        └── data/
            ├── world.data.yaml
            └── social/links.yaml
```

`world.yaml` 用 `requiredPlugins`、`recommendedPlugins` 或 `pluginPolicy` 声明插件关系：

```yaml
recommendedPlugins:
  - social-sim
pluginPolicy:
  recommendedPlugins:
    - social-sim
worldData: data/world.data.yaml
```

### Override 发布方式

给已有世界追加插件数据时，发布 override 包。安装器把文件放入：

```text
~/.covel/world-overrides/haruka-academy/
├── world.data.override.yaml
└── data/social/links.yaml
```

override descriptor 可以新增 source，也可以覆盖已有 source 的 `path`、`enabled`、`merge` 等字段：

```yaml
schemaVersion: 1
sources:
  social-links:
    kind: yaml
    path: data/social/links.yaml
    schema: plugin://social-sim/relationships
    to: plugin:social-sim/relationships
    key: id
    merge: skipExisting
```

### 开发检查清单

- source id 使用短名，例如 `cast`、`social-links`、`portraits`。
- `path` 放在 `data/` 或 `media/` 下。
- `schema` 使用稳定 URI，插件升级时保持兼容。
- `to` 指向插件自己的 namespace。
- `key` 指向数据对象中的稳定 id 字段。
- 大文本放 markdown/text source，大结构化数据放 yaml/json source，多媒体放 media source。
- world 包和 override 包都通过 containment 校验，路径保持在各自根目录内。

## Current Limits

- v1 source 只读取本地 `yaml`、`json`、`markdown`、`text`、`media`。
- media source 只扫描一层目录，使用 v1 扩展名 allowlist 和大小限制。
- `merge` 只支持 `replace` 与 `skipExisting`。
- `key` 只支持简单字段名、markdown/text literal key、media `filename`。
- remote、SQLite source、CUE、RO-Crate、复杂 JSON Patch override 属于后续阶段。

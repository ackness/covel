# World Data

`worldData` 是 world 包的统一数据入口。它把世界维度、角色卡、规则、场景模板和媒体索引声明成 source，再由服务器在 world load 或 session 创建阶段导入到现有 store。第三方插件也可以用同一套 descriptor 让 world 包携带插件数据。

## World Package

推荐结构：

```text
worlds/my-world/
├── world.yaml
├── WORLD.md                         # 默认世界观；也可用 WORLD.zh.md / WORLD.en.md
├── data/
│   ├── world.data.yaml
│   ├── dimensions.yaml
│   └── rules/                       # 可选：题材规则，导入 living-world-rules
├── characters/
│   └── main-cast.json
└── media/
    ├── portraits.json               # 可选：立绘生成清单
    ├── portraits/                   # 可选：角色立绘
    ├── presence.json                # 可选：角色与立绘的内容寻址映射
    ├── scenes.json                  # 可选：场景图生成清单
    ├── scenes/                      # 可选：日 / 夜场景图
    └── scenes.registry.json         # 可选：scene-stage 场景注册表
```

`world.yaml`：

```yaml
schemaVersion: "1.0"
id: my-world
name: 我的世界
summary: 一个示例世界。
defaultLocale: zh-CN
pluginPolicy:
  preset: traditional-story
  requiredPlugins:
    - pregame
    - world-init
    - char-creator
  recommendedPlugins:
    - character-blueprint
  preferTags:
    - mode:traditional-story
  avoidTags:
    - mode:dialogue
worldData: data/world.data.yaml
defaultViewMode: stage
```

`worldData` path 相对 world root。

### AI 生成包的便携文本回退

AI 创建器可按创作简报生成 `characters/main-cast.json` 与 `data/lorebook.yaml`，并和 dimensions 一起写入 `data/world.data.yaml`。文件型世界在创建 session 时始终按 descriptor 导入。

`server-store` 与浏览器本地世界没有可长期读取的包目录。生成接口在临时目录完成同样的解析和校验后，把角色放入 `WorldRecord.metadata.characterBlueprints`，把资料库与规则放入 `WorldRecord.metadata.embeddedLorebook`。session 创建仅在没有导入文件 worldData 时使用这份回退；因此同一世界不会重复导入。便携回退只承载文本内容，图片仍必须使用 media source、真实文件和内容寻址索引。

### 两种完整内置示例

世界包不必启用所有能力；应让题材决定插件组合与数据层。仓库内两个中文世界展示了两条互补路线：

| 示例                    | 玩家体验                             | 主要能力                                                                                                                                                         | 适合参考的文件                                                                                                                    |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `worlds/mistport`       | 黑暗奇幻调查，行动与环境叙事为主     | 基于传统叙事的自定义 `mistport-investigation` 组合、按 locale 选择的世界观 / 角色 / 规则 / presence、题材记忆块、角色属性 schema、角色蓝图、立绘、潮汐与势力规则 | `world.yaml`、`WORLD.zh.md` / `WORLD.en.md`、`data/dimensions.yaml`、`data/rules/`、`characters/`、`media/`                       |
| `worlds/haruka-academy` | 校园群像恋爱，对话与视觉小说舞台为主 | `dialogue-mode` 策略、`defaultViewMode: stage`、关系数值、题材记忆块、角色蓝图、透明立绘 presence、地点对应的日 / 夜场景注册表、校园日程规则                     | `world.yaml`、`WORLD.md`、`data/dimensions.yaml`、`data/rules/`、`characters/`、`media/scenes.json`、`media/scenes.registry.json` |

两者都把内容通过 `data/world.data.yaml` 接入同一导入协议，但不会为了展示能力而加入与题材无关的插件。开发新世界时，先复制更接近目标交互模式的结构，再按后文各 source 契约增减角色、规则或媒体层。

`defaultViewMode`（可选）：会话首次进入 Playing 时的默认呈现模式。目前仅 `stage`（全屏舞台模式，见 [ui-panels.md](./ui-panels.md#舞台模式stage-view)）有效，其他值按 `parsed` 处理。它经 `world-seed-loader` 拼进 `WorldRecord.metadata.defaultViewMode`，前端仅在会话首挂载时用作初值——玩家在头部切换视图后即以玩家选择为准。

> **请把 `requiredPlugins` / `recommendedPlugins` / `excludedPlugins` 写在 `pluginPolicy` 下**。写在顶层同样被接受，加载时**折叠进 `pluginPolicy`（去重合并）**，`WorldRecord.metadata` 只保留 `pluginPolicy` 作为插件选择的唯一来源；但顶层无法表达 `preset` / `packs` / `preferTags` 等场景意图。

`pluginPolicy` 字段：

| 字段                  | 说明                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `preset`              | 默认选中的组合包 ID；可引用同一策略内的自定义 `packs[].id`，或内置的 `traditional-story`、`dialogue-mode`、`low-cost`。      |
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
    path: characters/main-cast.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
    after: dimensions
```

字段：

| 字段      | 必填 | 可选值 / 格式                                                                                                 | 说明                                                                                      |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kind`    | yes  | `yaml`、`json`、`markdown`、`text`、`media`                                                                   | source 读取器类型。                                                                       |
| `path`    | yes  | 非空字符串                                                                                                    | 相对 descriptor root 的文件或目录。world 包相对 world root；override 相对 override root。 |
| `schema`  | no   | `covel://world/dimensions`、`covel://world/ir/v1`、`plugin://<pluginId>/<namespace>`、或本地 JSON Schema path | 校验用 schema。`plugin://...` 是 schema URI。                                             |
| `to`      | yes  | 见 [Target URI](#target-uri)                                                                                  | 写入目标 URI。`plugin:<id>/<namespace>` 是 target URI。                                   |
| `key`     | no   | 简单字段名，例如 `id`、`characterId`、`filename`                                                              | 批量 source 的稳定 key。media 常用 `filename`。                                           |
| `indexTo` | no\* | `plugin:<id>/<namespace>`                                                                                     | 仅 media source 使用，把媒体索引写入插件数据。**对 media source 实为必需**——见下。        |
| `effects` | no   | `characters`、`projections`                                                                                   | 额外投影；`characters` 实例化角色，`projections` 调用已启用插件声明的纯投影。             |
| `after`   | no   | source id 或 source id 数组                                                                                   | source 顺序依赖。source id 必须先声明且满足命名规则。                                     |
| `enabled` | no   | boolean                                                                                                       | `false` 会跳过该 source。                                                                 |
| `locale`  | no   | 长度至少 2 的字符串                                                                                           | source 对应的内容语言。                                                                   |
| `merge`   | no   | `replace`、`skipExisting`                                                                                     | 写入冲突策略。                                                                            |

> **media source 必须同时声明 `key` 和 `indexTo`**，否则整条 source 静默失效：
>
> - 缺 `key` → 每个文件产出一条 error 诊断（`media source "<id>" needs key: filename or a literal key`）并被跳过。
> - 缺 `indexTo` → 规划阶段不产出任何 `media-index` write；而**媒体字节的落库正是挂在这种 write 上**（`session-import/media-handling.ts` 只对 `kind: "media-index"` 调 `mediaStore.put()`）。结果是字节从不进 MediaStore，后续按 sha256 引用它的 `MediaRef` 全部解析失败。
>
> 声明的 `indexTo` 插件未被玩家启用是另一回事：那属于 warning 级降级，字节照常导入、只跳过索引写入。

### Locale 变体解析（`<name>.<locale>.<ext>`）

导入器按**会话 locale** 解析 source 文件，沿用 `WORLD.md` / 外部 dimension 约定：对每个 source 的 `path`，依次尝试 `<name>.<exact-locale>.<ext>`、script 兼容的 `<name>.<primary-language>.<ext>`，命中则用之，否则回退到声明的 `path`。例如 `ru-RU` 依次尝试 `main-cast.ru-RU.json`、`main-cast.ru.json`、`main-cast.json`；`zh-Hant-TW` 不会尝试默认推断为 Hans 的 `main-cast.zh.json`。

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

### Lorebook 按玩家消息选择性注入

`to: lorebook` 会在创建 session 时把 source 的每个值写成 lorebook 记录。适合大型世界设定的最小 descriptor：

```yaml
# world.yaml
worldData: data/world.data.yaml
```

```yaml
# data/world.data.yaml
schemaVersion: 1
sources:
  lore:
    kind: yaml
    path: data/lorebook.yaml
    to: lorebook
    key: id
```

```yaml
# data/lorebook.yaml
- id: dragons
  content: 龙族是远古时代最强大的种族……
  strategy: selective
  keys: [龙族, 龙鳞, Drakon]

- id: core-rules
  content: 本世界的魔法必须遵守等价交换。
  strategy: constant
```

运行时边界：

- `strategy: selective`（或 `kind: triggered`）只检查**当前玩家消息**；消息包含任一 `keys` 项时激活，大小写不敏感，按子串匹配。
- `selective` 记录没有非空 `keys` 时不会激活。`constant` 每轮注入，不依赖 `keys`；省略 `strategy` / `kind` 时默认 `constant`。
- 可选字段还包括 `position`、`insertionOrder`、`enabled` 和 `extra`。默认 `position` 是 `after_plugin`，默认 `enabled` 是 `true`。
- `PLUGIN.md` 中的 Markdown 链接不会触发文件加载；`references/*.md` 及其自定义 `keywords` frontmatter 不是插件运行时契约。

World Data 在 session 创建阶段导入。已有 session 需要通过本页的 `sync-data` 接口同步；先调用 `preflight` 可在写入前查看诊断。

URI grammar：

| Syntax                                   | 用途       | 规则                                                                                                                                |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `plugin:<pluginId>/<namespace>`          | target URI | `pluginId` 匹配 `^[a-z][a-z0-9-]*$`；`namespace` 匹配 `^[a-z][a-zA-Z0-9_-]{0,63}$`。                                                |
| `plugin:<pluginId>/<namespace>+lorebook` | target URI | 同时写 `plugin_data` 和 lorebook。                                                                                                  |
| `plugin://<pluginId>/<namespace>`        | schema URI | 用于 `schema` 字段，指向插件 `dataSchemas.<namespace>`。                                                                            |
| `covel://world/dimensions`               | schema URI | 内置 world dimensions schema。                                                                                                      |
| `covel://world/ir/v1`                    | schema URI | 内置、严格、版本化的插件中立 WorldIR envelope。                                                                                     |
| `world:metadata.<path>`                  | target URI | path 只允许字母、数字、`_`、`.`、`-`；禁止 `__proto__`、`constructor`、`prototype`；当前拒绝 `world:metadata.characterBlueprints`。 |

`plugin://...` 和 `plugin:...` 的用途不同：`schema` 说明“用哪个 schema 校验”，`to` 说明“写到哪里”。因此同一个 source 通常同时写：

```yaml
schema: plugin://character-blueprint/blueprints
to: plugin:character-blueprint/blueprints
```

`plugin:*/*` 与 `indexTo` 都会做 preflight：

- 目标插件已注册。
- 目标 namespace 在插件 `dataSchemas` 中声明。
- `acceptsWorldData: true`。
- `schema` 为 `plugin://<id>/<namespace>` 时必须和 `to: plugin:<id>/<namespace>` 兼容。
- 插件包内 JSON Schema、world/override 本地 JSON Schema 或内置 schema 校验通过。

以上为 **error 级**（作者错误，阻断导入）。**目标插件是否在本 session 最终启用插件列表中**是玩家选择的结果，不算作者错误：`to: plugin:*` 目标未激活时该 source 整体跳过（warning 级诊断）；`indexTo` 目标未激活时媒体字节照常导入，仅跳过索引写入（warning 级）。世界给可选插件携带数据因此是安全的——玩家取消勾选对应插件不会导致建会话失败。

world load 阶段只强校验内置 schema 和本地 schema；`plugin://...` schema 在 session import/preflight 阶段结合当前启用插件严格校验。

## WorldIR 与插件投影

`covel://world/ir/v1` 是插件中立的中间表示。它让 world 作者或上游抽取器只维护一份世界事实，再由各插件把相同输入转换成自己的 `dataSchemas` 记录。v1 envelope 顶层和每类记录都拒绝未知字段；插件专用扩展只能放在 `attributes` 中：

```yaml
schemaVersion: 1
summary: 海滨校园中的人物、事件与规则。
entities: []
relations: []
events: []
statements:
  - id: school-closing-time
    type: rule
    content: 学校每天十八点闭校。
    attributes:
      title: 闭校时间
      kind: constant
```

四个数组始终存在：

| 数组         | 必要字段                   | 用途                                                                       |
| ------------ | -------------------------- | -------------------------------------------------------------------------- |
| `entities`   | `id`、`type`               | 人物、地点、组织、物品等稳定实体，可带 `name`、`description`、`attributes` |
| `relations`  | `id`、`type`、`from`、`to` | 实体间有向关系，可带 `description`、`attributes`                           |
| `events`     | `id`、`type`               | 事件，可带 `participantIds`、`time`、`description`、`attributes`           |
| `statements` | `id`、`type`、`content`    | 事实、规则、目标、任务或注释，可带 `subjectIds`、`attributes`              |

source 只有显式声明 `effects: [projections]` 才运行插件投影：

```yaml
sources:
  worldIr:
    kind: yaml
    path: data/world.ir.yaml
    schema: covel://world/ir/v1
    to: world:metadata.worldIr
    effects:
      - projections
```

导入器从 session 的最终启用插件中发现 `worldProjections`，按 `pluginId/projectionId` 稳定排序，并只执行 `from` 与 source schema 完全相同的声明。handler 接收：

```ts
{
  value: WorldIRV1;
  context: {
    sessionId: string;
    worldId: string;
    sourceId: string;
    locale?: string;
    now: string;
  };
}
```

handler 必须返回以声明的 output id 为 key 的对象；每个 output 值可以是一条记录或记录数组。框架拒绝额外 output、缺失 key 字段、越界 handler 路径以及不符合目标 `dataSchemas` JSON Schema 的结果。每条投影记录仍走普通 planned write、事务、ledger 和 `sync-data`，并记录 `projection:<pluginId>/<projectionId>` provenance。没有匹配的已启用 projection 时，source 产生零条投影写入，不视为错误。

执行边界：

- `preflight` 只校验 source、声明、目标和 schema，**不 import 或执行 handler**；projection 的实际 output key 只能在 import/sync 后确定。
- import/sync 只运行当前 session 已启用插件的匹配声明；单个 projection 失败只产生 warning，不阻断 canonical source 写入或其他插件的 projection。
- 每个声明的 output 是独立一致性单元：任一 item 的 key/schema 无效时整组 output 延迟，不写入半新半旧的混合代次。sync 会保留该 output 上一次成功的 row 与 ledger；只有 handler 成功返回 `[]` 才表示权威空结果并允许删除旧 row。
- builtin handler 可直接运行；community handler 需要该 session 的显式 server-code grant。会话创建前无法授予这项权限，因此 community projection 应在建会话后调用插件 enable（已在 active 列表也可重复调用）触发 `covel:plugin-server-code` 的 session-scope 审批，再通过 `sync-data` 补跑；未获 grant 时 importer 只发 warning，不会偷偷执行代码。
- 每次调用使用独立 Worker 和结构化克隆输入，超时 1 秒，V8 old/young generation 上限分别为 128/32 MiB，stack 上限 4 MiB，JSON 输出上限 1 MiB，每个 output 上限 1000 条，每个 source 最多执行稳定排序后的前 32 个 projection。Worker 隔离用于限制状态串扰与资源滥用，**不是安全沙箱**；已批准代码仍可能访问 Node/网络能力。
- handler 文件 digest、projection/output 身份与实际 item 都进入 ledger 的 source digest；只改 handler 不改 world source 时，下一次 sync 仍会识别变化。执行前后 digest 不一致时会丢弃该次结果，避免热更新竞态写入错误 provenance。
- session 创建会先在锁和数据库事务之外读取 source、运行 projection 并生成不可变 plan，再在事务内原子应用，避免插件工作占用事务。sync 同样在 session mutation lock 外完成 plan 和 projection Worker；dry-run 不取写锁，实际写入只在短锁内重新校验 world、locale、active plugin 与审批 scope，然后完成冲突扫描和事务应用。

开发工具和 Agent 可通过 `GET /api/framework/capabilities` 发现 `projections` effect、WorldIR URI 及其规范 JSON Schema 文档，再通过 `GET /api/plugins/:id` 读取每个插件聚合后的 `worldProjections`。公开 discovery 只返回声明元数据，不暴露插件根路径或 handler 路径，也不能直接调用 handler。

静态 world-data projection 与实时 story 管线使用同一 `covel://world/ir/v1` 数据契约，但执行机制不同：静态数据走上面的纯函数 handler；实时回合由 `world-ir` agent 把 `narrative-engine` 输出抽取一次，`codex`、`core-quest`、`affinity`、`inventory` 和 `npc-graph/extractor` 再通过 typed input 并行消费。共享抽取失败时，下游按 DAG gate 跳过，不影响本轮叙事成功提交。

## World-Init Schema Fast Path

`world-init` 的 guard（LLM 调用前的纯函数）按优先级决定角色属性 schema，命中即跳过 LLM。完整优先级见 [plugins.md #world-initschema-gen](plugins.md#world-initschema-gen)，要点：

1. 当前 session 已有数据 → 复用。
2. **世界声明的 `characterAttributes`（权威）** → 原样写入。
3. 有 dimensions、无声明 → `deriveSchema(dimensions)` 推导通用属性（生命值、体力、货币、声望、能力阶层等）。
4. 都没有 → 才由 `schema-gen` agent 用 LLM 生成。

> **快路径不跨 session 复制**：guard 只看当前 session、世界声明与世界 dimensions，绝不从同世界的其他 session 拷贝 `schema` / `entries`。session plugin-data 不是可信来源：通用 `PUT /plugin-data` 允许会话持有者写任意已激活插件的 namespace，来源 session 可能携带玩家自造的值；在 hosted 层级这些 session 还可能属于**其他用户**，复制即同时构成泄露与投毒。代价是「既无声明属性、又无 dimensions」的世界每个 session 多一次 schema-gen 调用。

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

- 加载后写入 `WorldRecord.metadata.characterAttributes`（读取时也接受同义键 `metadata.schemas`）。
- guard 把它**原样**写成 session 的 `(world-init, schema, character-attributes)`，**权威优先**——因此编辑 `characterAttributes` 会在**新 session** 生效（已开局的旧 session 在 Pre-Game 时已锁定 schema，不会回溯更新）。
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
- `presence.json` 是 presence 记录数组，每条把 `characterId` 对应角色的 `avatar` / `sprite` 指向那张图。前端按实例化 `CharacterRecord.id` 的精确值或 `-<characterId>` 后缀匹配：角色卡声明 `instantiate.characterId` 时应使用该值（如 `npc-<id>`）；未声明时可使用角色卡 `id`（`emberback` 即采用此形式）：

```json
[
  {
    "schemaVersion": 1,
    "characterId": "npc-kamishiro-mio",
    "displayName": "神代澪",
    "avatar": { "id": "<sha256-of-png>", "mime": "image/png", "size": 2155557 },
    "sprite": { "id": "<sha256-of-png>", "mime": "image/png", "size": 2155557 },
    "visuals": {
      "defaultVariant": "uniform-neutral",
      "variants": [
        {
          "id": "uniform-neutral",
          "outfit": "uniform",
          "expression": "neutral",
          "pose": "default",
          "sprite": {
            "id": "<sha256-of-png>",
            "mime": "image/png",
            "size": 2155557
          },
          "stage": { "scale": 1, "offsetX": 0, "offsetY": 0 }
        }
      ]
    }
  }
]
```

`visuals` 是 schema v1 的可选增量字段，旧的 `avatar` / `sprite` 仍保持兼容。每个 variant 必须有唯一 `id` 和 `sprite`，可用安全键标注 `outfit`、`expression`、`pose`；`stage.scale`（0.5–2）和 `offsetX/offsetY`（-100–100，百分比）用于校正不同裁切源图的屏幕大小和基线。舞台按精确 variant id、语义组合、目录默认、旧 sprite/avatar 的顺序回退，所以剧情请求了尚未制作的表情时仍会显示角色，不会空白。`scripts/emit-presence.mjs` 默认给每个角色生成一个 `default/default/neutral/default` 变体；作者可在生成结果上继续添加服装和表情图。

`mediaRef.id` 必须是该图内容的 **64 位小写 sha256**——media source 导入后媒体库以同一 sha256 寻址，二者相等才能解析到资产。手算易错，仓库提供 `scripts/emit-presence.mjs <world>`，从 `media/portraits/` 自动生成 `presence.json`（**重生成立绘后必须重跑刷新哈希**）。

preflight 要求：`character-presence` 的 `assets` / `presence` namespace 已声明 `acceptsWorldData: true`（builtin 默认满足）。要让立绘数据实际生效，把 `character-presence` 放进世界的 `recommendedPlugins`——若玩家取消勾选，presence source 跳过、媒体照常导入但索引写入跳过（warning，不阻断建会话）。媒体受 v1 限制：单文件 ≤ 20 MB、单 source ≤ 100 MB、扩展名 allowlist（含 `.png` / `.webp`）。

实际范例见 `worlds/mistport` 与 `worlds/haruka-academy`（`data/world.data.yaml` + `media/`），提示词与生成流程见 [角色立绘生成指南](../guide/world-portraits.md)。

## Scene Backgrounds

场景背景（教室、社团楼、海堤这类地点插画，日/夜各一张）与立绘同一套图片管线，但清单结构不同：作者手编 `media/scenes.json`，脚本按清单批量生成 PNG、再由 `scripts/emit-scenes.mjs` 生成内容寻址的 `scenes.registry.json`。

`media/scenes.json` 字段：

| 字段           | 说明                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`           | 场景机器键，也是文件名前缀（`<id>-day.png` / `<id>-night.png`）。                                                       |
| `name`         | 场景显示名。                                                                                                            |
| `locationRef`  | 对应 `dimensions.yaml` 里 `geography.regions[].name` 或其 `landmarks[].name`（dimensions 数据模型无 id，name 即身份）。 |
| `subject`      | 英文画面描述（日图），composes 为 `style.prefix + subject + style.suffix`。                                             |
| `subjectNight` | 可选，夜图专用画面描述；留空则夜图回退用 `subject`（配合 `style.nightSuffix`）。                                        |

world 包用一条 media source 把生成好的 PNG 导入媒体库（沿用 portraits 的 `kind: media` 机制，按 sha256 内容寻址），再用第二条 json source 导入注册表。**两条都不可省**，且 media source 必须带 `key` + `indexTo`（否则字节不落库，见上方 media source 说明）：

```yaml
sources:
  scenes:
    kind: media
    path: media/scenes
    to: media
    indexTo: plugin:scene-stage/assets
    key: filename
    after: dimensions
  scenesRegistry:
    kind: json
    path: media/scenes.registry.json
    schema: plugin://scene-stage/scenes
    to: plugin:scene-stage/scenes
    key: registryId
    after: dimensions
```

与 portraits 的差别只在于**注册表另走一条 source**：portraits 把每张图的索引直接喂给 `character-presence/assets`，而场景图除了 `scene-stage/assets` 的字节索引外，还需要 `scenes.registry.json` 整份导入 `scene-stage/scenes` 供解析 runtime 一次读全（`schemaVersion` 仍为 1：纯增字段，向后兼容）。实际写法见 `worlds/haruka-academy/data/world.data.yaml`。

`scenes.registry.json`（`scripts/emit-scenes.mjs` 自动生成，`{schemaVersion, registryId, style, scenes:[{sceneId,name,locationRef?,day,night}]}`，`day`/`night` 是 sha256 `MediaRef`）整份文档作为**一行** plugin_data 导入：`registryId: "scene-registry"` 是自描述常量字段，同时充当 `key`——scene-stage 的解析 runtime 读一行即得 `style`（增量生成用的画风 prompt 片段）与 `scenes[]` 全量，不需要按条目遍历。`scenes.registry.json` 是生成产物，不要手编，重新生成场景图后必须重跑 `emit-scenes.mjs` 刷新哈希与 `style` 块。

**未出图时的空 registry 兜底**：`media/scenes.registry.json` 不存在会导致 world-data 校验失败（source 引用了不存在的文件）。作者还没准备场景图时，对空的 `media/scenes/` 目录跑一次 `emit-scenes.mjs` 即可产出合法的空 registry（`{schemaVersion: 1, registryId: "scene-registry", style: {...}, scenes: []}`），先提交进世界包占位；scene-stage 侧空 `scenes[]` 时一律走"未命中注册表"分支（`autoGenerateScenes` 门控 → 增量生成或 `source: "none"`），不是错误状态。出图后重跑 `emit-scenes.mjs` 覆盖即可，无需改 world.data.yaml。

清单润色规范、参数表、日/夜缺图回退语义、作者四步工作流见 [场景背景生成指南](../guide/world-scenes.md)。

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

#### 内置 RPG 玩法种子（quests / items / affinity）

三个内置 RPG 插件接受世界包预置数据（完整成品示例见 `worlds/emberback/data/`）：

| 插件         | schema URI                   | to                         | 记录形状                                                                                     |
| ------------ | ---------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `core-quest` | `plugin://core-quest/quests` | `plugin:core-quest/quests` | `{ id, name, description, status?, objectives?: [{id?, text, done?}], giver?, reward? }`     |
| `inventory`  | `plugin://inventory/items`   | `plugin:inventory/items`   | `{ id, name, quantity, description?, tags?: string[], equipped?: boolean }`                  |
| `affinity`   | `plugin://affinity/affinity` | `plugin:affinity/affinity` | `{ id, name, score (int -100..100), notes? }`（tier/history 等派生字段由工具首次写入时补齐） |

三者都用 `key: id`。任务预置后由 `core-quest` agent 只推进不重建；任务目标建议填写任务内稳定的 `id`，让后续推进即使略微改写 `text` 也能勾选同一目标。物品预置即开局行囊；好感预置给关键 NPC 一个非零起点（正负皆可）。

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

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
│   ├── memory-blocks.json            # 可选：题材记忆定义
│   └── rules/                       # 可选：题材规则，导入 living-world-rules
├── characters/
│   ├── main-cast.json                # 可选：character.blueprints@1 插件内容
│   └── characters.json               # 通用领域角色记录
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
  presetId: traditional-story
  requested:
    - pregame
    - world-init
    - char-creator
  recommended:
    - character-blueprint
  preferredTags:
    - mode:traditional-story
  avoidedTags:
    - mode:dialogue
worldData: data/world.data.yaml
defaultViewMode: stage
```

`worldData` path 相对 world root。

### AI 生成包的便携文本回退

AI 创建器可按创作简报生成 `characters/main-cast.json` 与 `data/lorebook.yaml`，并和 dimensions 一起写入 `data/world.data.yaml`。文件型世界在创建 session 时始终按 descriptor 导入。

`server-store` 与浏览器本地世界没有可长期读取的包目录。生成接口在临时目录完成同样的解析和校验后，把通用领域角色放入 `WorldRecord.metadata.embeddedCharacters`，把资料库与规则放入 `WorldRecord.metadata.embeddedLorebook`。session 创建仅在没有导入文件 worldData 时使用这份回退；因此同一世界不会重复导入。便携回退只承载文本内容，图片仍必须使用 media source、真实文件和内容寻址索引。

### 三个完整内置示例

世界包不必启用所有能力；应让题材决定插件组合与数据层。仓库内三个世界展示了不同的数据组合：

| 示例                    | 玩家体验                                 | 主要能力                                                                                                                                                         | 适合参考的文件                                                                                                                    |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `worlds/mistport`       | 黑暗奇幻调查，行动与环境叙事为主         | 基于传统叙事的自定义 `mistport-investigation` 组合、按 locale 选择的世界观 / 角色 / 规则 / presence、题材记忆块、角色属性 schema、角色蓝图、立绘、潮汐与势力规则 | `world.yaml`、`WORLD.zh.md` / `WORLD.en.md`、`data/dimensions.yaml`、`data/rules/`、`characters/`、`media/`                       |
| `worlds/haruka-academy` | 校园群像恋爱，对话与视觉小说舞台为主     | `dialogue-mode` 策略、`defaultViewMode: stage`、关系数值、题材记忆块、角色蓝图、透明立绘 presence、地点对应的日 / 夜场景注册表、校园日程规则                     | `world.yaml`、`WORLD.md`、`data/dimensions.yaml`、`data/rules/`、`characters/`、`media/scenes.json`、`media/scenes.registry.json` |
| `worlds/emberback`      | 太阳风暴中的协作救援，RPG 资源与任务推进 | 领域角色、插件角色卡、记忆定义、规则、任务、物品和好感种子                                                                                                       | `data/quests.yaml`、`data/items.yaml`、`data/affinity.yaml`、`characters/characters.json`                                         |

三者都把内容通过 `data/world.data.yaml` 接入同一导入协议，但不会为了展示能力而加入与题材无关的插件。开发新世界时，先复制更接近目标交互模式的结构，再按后文各 source 契约增减角色、规则或媒体层。

`defaultViewMode`（可选）：会话首次进入 Playing 时的默认呈现模式。接受 `stage`（全屏舞台模式，见 [ui-panels.md](./ui-panels.md#舞台模式stage-view)）或 `parsed`。它经 `world-seed-loader` 拼进 `WorldRecord.metadata.defaultViewMode`，前端仅在会话首挂载时用作初值——玩家在头部切换视图后即以玩家选择为准。

`pluginPolicy` 只描述选择意图，不锁死核心插件。会话解析器依据插件包公开的 `provides/requires/optional/conflicts` contract 和授权状态生成最终激活集。

| 字段                            | 说明                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `presetId`                      | 默认组合包 ID，可引用 `packs[].id` 或内置 preset                                        |
| `preferredTags` / `avoidedTags` | 插件标签偏好                                                                            |
| `requested`                     | 世界建议作为初始选择的插件 ID                                                           |
| `recommended`                   | 额外推荐插件 ID                                                                         |
| `packs`                         | 自定义组合包，每项包含 `id/label`，可选 `description/requested/recommended/tags/reason` |

世界清单采用严格的当前 schema；不接受旧选择字段，也不会把顶层字段折叠为另一套格式。

### 启动加载与收敛（seed & reconcile）

服务器启动时按目录顺序 seed 世界：先 bundled（`COVEL_WORLDS_DIR`，源码默认仓库 `worlds/`），再 user（`COVEL_USER_WORLDS_DIR`，否则 `$COVEL_HOME/worlds`，未设置 home 时为 `~/.covel/worlds`；桌面由 shell 注入 `<data_root>/worlds`）。seed 是 **idempotent upsert**——每个世界包的 `WorldRecord` 写入 DB，`metadata.source = "file"`。

seed 本身**只新增/更新、从不删除**，所以一个曾经内建、后被归档（从包里移除）的世界会**残留在所有老用户的 DB 里**并继续出现在世界列表。为此 seed 完所有目录后会跑一次 **收敛（reconcile）**，删除"已不在任何世界源里"的陈旧 seed 记录。三重安全栏，确保只清死 seed、绝不误删用户数据：

1. **来源闸门**：仅 `metadata.source === "file"`（纯文件 seed）的世界可被清理。AI 生成的世界（`generated` / `generated-file`）及其它任何来源**永不触碰**，即便它不在当前世界源里。
2. **存档保护**：陈旧世界若仍有存档（session），**保留不删**并打 `warn` 日志；删除带存档的世界属于显式操作，不会由启动时的静默收敛执行。
3. **完整扫描护栏**：任一世界源目录无法扫描、任一已发现世界包读取/解析/校验失败，或本次没有成功加载任何世界时，**整体跳过收敛**。健康世界仍可更新；部分成功不构成删除其它世界的依据。

> 想清掉一个**仍有存档**的内建世界（收敛会因安全栏保留它），需显式删除其世界记录与关联 session。

### 文件更新与安装

世界包安装与 AI 生成的 `server-file` 目标写入用户世界目录，不回写内置资源。安装接口成功激活后返回 `restartRequired: false`，立即可从世界列表查询；激活失败只移除本次新建目录，允许重试。

server 使用 Node 26 的递归 `fs.watch` 监听内置与用户世界目录，包含 Linux。已有世界的 YAML / Markdown 文件变化会按物理目录延迟 500ms 合并后重读，读取后使用清单的 `id` 查询、更新世界并通知会话（目录名无需与 `id` 相同）；**仅维度发生变化时**更新存储，并向使用该世界的 session 发出 `world.dimensions.changed`。它不是完整世界包或插件的热重载：直接放入一个新世界目录需重启 seed 或走安装入口，其他世界内容更新也应重启加载。

若文件系统不支持监听，启动会记录 warning；维度也可通过 `POST /api/worlds/:id/dimensions/import` 导入。插件安装后仍需重启服务。实现见 `apps/server/src/world-file-watcher.ts`，安装响应见 [API 参考](./api.md#installed-resource-storage-and-vector-configuration)。

`dimensionSources` 声明的文件必须全部读取并校验成功；缺失、不可读、YAML 错误或维度校验失败时，整个世界加载失败，保留存储中的上一份完整记录，不发出维度变更通知，也不执行基于该次不完整清单的过期世界清理。文件修复后可继续热更新。热更新与启动加载都保留已有世界的 `metadata.source`、`metadata.storage` 和 `createdAt`，生成世界不会因重新加载而变为不可删除的内置世界。

会话创建、预检和数据同步通过清单 `id` 定位世界包，支持目录名与 ID 不同；多个世界根目录仍按后者优先，同一根目录内出现重复 ID 会报错。查找只扫描直接子目录，不跟随世界包或清单符号链接。

删除 `generated-file` 世界时，先在已配置目录中核对 `metadata.storage.path`，再按清单 ID 定位该目录内的唯一世界包。旧记录没有存储绑定时，必须在所有配置目录中唯一匹配。绑定失效、包缺失或有歧义时返回 `409 world_package_unresolved`，文件和数据库记录均不删除；不会回退删除其他目录中的同名包。

文件删除先将包移入同一根目录下的临时容器，再删除数据库记录；数据库失败时恢复原目录，支持重试。提交成功后的临时文件清理失败只记录日志，容器不会作为世界重新加载。这是进程内失败恢复，不提供文件系统与数据库跨进程崩溃的原子提交。

热更新与 worldData 查找共用根目录优先级；被高优先级同 ID 包覆盖的目录不会改写世界记录或通知会话。

启动加载先处理高优先级根目录，再加载未被覆盖的世界。同一根目录的重复 ID 不写入数据库；高优先级清单或维度加载不完整时，保留已有记录并跳过过期清理，不用低优先级内容替换上一份完整状态。启动加载同样拒绝清单符号链接，忽略隐藏临时目录。

世界的 `metadata.source` 和 `metadata.storage` 在普通 PATCH 中保持原值，防止编辑或浏览器同步改变文件归属。存储以 `metadata.dimensions` 为规范值；顶层 `dimensions` 是一致的读取投影。仅提供顶层维度时写入规范字段，替换或清空规范字段时同步更新投影，Memory、SQLite 和 PostgreSQL 行为相同。

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

它是配置解析链的中间层：**玩家覆盖（`X-Plugin-User-Settings` header）→ 世界默认（`pluginSettings`）→ manifest 默认（`contributes.settings[].default`）**。玩家仍可在设置里覆盖每个值；未声明的 key 无害——runtime 只读插件真正声明过的 key。加载后写入 `WorldRecord.metadata.pluginSettings`，并在 `/api/actions` 回合边界与玩家 header 合并后注入 `TurnInput.userSettings`（供 agent 的 `{{ userSettings.* }}`、guard、hook 共用）。`pluginSettings` 只设默认值，不影响[插件选择](#world-package)（选择仍由 `pluginPolicy` 决定）。

### 世界记忆定义（`memory.blocks@1`）

记忆定义通过普通 world-data contract 导入。`data/memory-blocks.json` 保存一个对象，`id` 固定为 `world`，不是裸数组：

```json
{
  "id": "world",
  "blocks": [
    {
      "label": "clues",
      "displayName": { "zh-CN": "线索", "en-US": "Clues" },
      "extractionHint": {
        "zh-CN": "记录已发现的线索及关联。",
        "en-US": "Track discovered clues and their connections."
      },
      "icon": "Search",
      "maxChars": 1200
    }
  ]
}
```

对应 descriptor：

```yaml
schemaVersion: 1
sources:
  memory-definitions:
    kind: json
    path: data/memory-blocks.json
    schema: contract:memory.blocks@1
    to: contract:memory.blocks@1
    key: id
```

`memory` 插件在 `contributes.data.definitions.accepts` 声明 `memory.blocks@1`，因此该对象导入其自身 `definitions/world` 记录。世界清单与世界 metadata 不承载记忆定义专用字段。提取结果保存在该插件的 `blocks` namespace，并经 `prompt.segment@1` 注入提示词。

标签必须符合 `^[a-z][a-z0-9_]*$`，`displayName/extractionHint` 支持 I18nText，`maxChars` 为正整数。插件先加载固定的基础定义，再加载活跃插件的 `memory.block-definitions@1` 服务，最后加载世界定义；已占用标签保留先前定义。三个内置世界均采用此文件与 contract 结构。

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
    schema: contract:character.blueprints@1
    to: contract:character.blueprints@1
    key: id
    after: dimensions

  characters:
    kind: json
    path: characters/characters.json
    to: characters
    key: id
    after: cast
```

字段：

| 字段      | 必填 | 可选值 / 格式                                                                | 说明                                                                                      |
| --------- | ---- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kind`    | yes  | `yaml`、`json`、`markdown`、`text`、`media`                                  | source 读取器类型。                                                                       |
| `path`    | yes  | 非空字符串                                                                   | 相对 descriptor root 的文件或目录。world 包相对 world root；override 相对 override root。 |
| `schema`  | no   | `covel://world/dimensions`、`contract:<contractId>`、或本地 JSON Schema path | 校验用 schema。contract 的 JSON Schema 由已注册包声明。                                   |
| `to`      | yes  | 见 [Target URI](#target-uri)                                                 | 写入目标 URI。contract target 解析为活跃接收方。                                          |
| `key`     | no   | 简单字段名，例如 `id`、`characterId`、`filename`                             | 批量 source 的稳定 key。media 常用 `filename`。                                           |
| `indexTo` | no\* | `contract:<contractId>`                                                      | 仅 media source 使用，把媒体索引写入插件数据。**对 media source 实为必需**——见下。        |
| `effects` | no   | `characters`、`projections`                                                  | 额外投影；`characters` 实例化角色，`projections` 调用已启用插件声明的纯投影。             |
| `after`   | no   | source id 或 source id 数组                                                  | source 顺序依赖。source id 必须先声明且满足命名规则。                                     |
| `enabled` | no   | boolean                                                                      | `false` 会跳过该 source。                                                                 |
| `locale`  | no   | 长度至少 2 的字符串                                                          | source 对应的内容语言。                                                                   |
| `merge`   | no   | `replace`、`skipExisting`                                                    | 写入冲突策略。                                                                            |

media source 应同时声明 `key: filename` 和 `indexTo: contract:<contractId>`。缺 key 会产生 error；缺 indexTo 无法生成媒体索引写入。当前媒体字节持久化随有效 media-index write 执行，因此没有活跃索引接收方时不会导入该 source 的字节。此时产生 warning，不阻断其他数据与投影；启用接收插件后可通过 sync 补导入。

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

| URI                              | 阶段           | 说明                                                                                       |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `world:metadata.<path>`          | world load     | 写入 `WorldRecord.metadata` 子路径；当前 world-load MVP 只投影 `world:metadata.dimensions` |
| `contract:<contractId>`          | session create | 写入所有活跃接收方声明的自身 namespace                                                     |
| `contract:<contractId>+lorebook` | session create | 写入 `plugin_data`，并同步生成 session lorebook row                                        |
| `lorebook`                       | session create | 直接写入 session lorebook                                                                  |
| `characters`                     | session create | 将通用角色记录写入会话 World Model                                                         |
| `media` + `indexTo`              | session create | 导入媒体并把索引写入 `plugin_data`                                                         |

### Lorebook 按玩家消息选择性注入

`to: lorebook` 会在创建 session 时把 source 的每个值写成 `{kind:"world"}` owner 的 lorebook 记录。身份键为 `(sessionId, owner, id)`，不会覆盖 player 或 plugin owner 的同名词条。适合大型世界设定的最小 descriptor：

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

### Contract 解析与预检

`contract:<contractId>` 同时可用于 schema、target 和 media index。contract ID 匹配 `^[a-z][a-z0-9.-]*@[1-9][0-9]*$`，例如 `character.blueprints@1`。`+lorebook` 只用于 target，同时生成一份 world owner 的 lorebook 记录；多个接收方不会重复生成该领域记录。

schema 引用从已注册插件根 `contracts.<id>.schema` 解析，文件位于该插件根内。target 则匹配根 `contributes.data.<namespace>.accepts`，稳定排序后写入每个活跃接收方。schema 与 target 是独立契约：源值先通过来源 schema，再通过每个接收 namespace 的 schema。

- 没有任何注册接收方属于作者错误，产生 error。
- 已注册但没有活跃接收方产生 warning，仅跳过该 contract 写入；其他领域 source 与独立 projection 继续处理。
- 多个活跃接收方允许 fan-out；数据不因包目录布局绑定具体插件 ID。
- 缺 schema、越界路径、文件读取失败或值校验失败产生 error，阻断导入。
- world load 校验内置与本地 schema；contract schema 在 session import/preflight 时结合 registry 校验。

`world:metadata.<path>` 拒绝原型污染路径段；当前 world-load 仅物化 `dimensions`，其他路径仅记录在 source summary。领域角色与 lorebook 使用专用 target。

## WorldIR 与插件投影

`contract:world-ir@1` 引用 `world-ir` 插件发布的中立中间表示 schema。它让 world 作者或上游抽取器只维护一份世界事实，再由各插件把相同输入转换成自己的 `contributes.data` 记录。v1 envelope 顶层和每类记录都拒绝未知字段；插件专用扩展只能放在 `attributes` 中：

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
    schema: contract:world-ir@1
    to: world:metadata.worldIr
    effects:
      - projections
```

导入器从 session 的最终启用插件中发现 `contributes.worldProjections`，按 `pluginId/projectionId` 稳定排序，并只执行 `from` 与 source schema 完全相同的声明。handler 接收：

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

handler 必须返回以声明的 output id 为 key 的对象；每个 output 值可以是一条记录或记录数组。框架拒绝额外 output、缺失 key 字段、越界 handler 路径以及不符合目标 `contributes.data` JSON Schema 的结果。每条投影记录仍走普通 planned write、事务、ledger 和 `sync-data`，并记录 `projection:<pluginId>/<projectionId>` provenance。没有匹配的已启用 projection 时，source 产生零条投影写入，不视为错误。

执行边界：

- `preflight` 只校验 source、声明、目标和 schema，**不 import 或执行 handler**；projection 的实际 output key 只能在 import/sync 后确定。
- import/sync 只运行当前 session 已启用插件的匹配声明；单个 projection 失败只产生 warning，不阻断 canonical source 写入或其他插件的 projection。
- 每个声明的 output 是独立一致性单元：任一 item 的 key/schema 无效时整组 output 延迟，不写入半新半旧的混合代次。sync 会保留该 output 上一次成功的 row 与 ledger；只有 handler 成功返回 `[]` 才表示权威空结果并允许删除旧 row。
- builtin handler 可直接运行；community handler 需要该 session 的显式 server-code grant。会话创建前无法授予这项权限，因此 community projection 应在建会话后调用插件 enable（已在 active 列表也可重复调用）触发 `covel:plugin-server-code` 的 session-scope 审批，再通过 `sync-data` 补跑；未获 grant 时 importer 只发 warning，不会偷偷执行代码。
- 每次调用使用独立 Worker 和结构化克隆输入，超时 1 秒，V8 old/young generation 上限分别为 128/32 MiB，stack 上限 4 MiB，JSON 输出上限 1 MiB，每个 output 上限 1000 条，每个 source 最多执行稳定排序后的前 32 个 projection。Worker 隔离用于限制状态串扰与资源滥用，**不是安全沙箱**；已批准代码仍可能访问 Node/网络能力。
- handler 文件 digest、projection/output 身份与实际 item 都进入 ledger 的 source digest；只改 handler 不改 world source 时，下一次 sync 仍会识别变化。执行前后 digest 不一致时会丢弃该次结果，避免热更新竞态写入错误 provenance。
- session 创建会先在锁和数据库事务之外读取 source、运行 projection 并生成不可变 plan，再在事务内原子应用，避免插件工作占用事务。sync 同样在 session mutation lock 外完成 plan 和 projection Worker；dry-run 不取写锁，实际写入只在短锁内重新校验 world、locale、active plugin 与审批 scope，然后完成冲突扫描和事务应用。

开发工具和 Agent 可通过 `GET /api/framework/capabilities` 发现 `projections` effect 和 contract URI 语法，再通过 `GET /api/plugins/:id` 读取每个插件聚合后的 `worldProjections`。公开 discovery 只返回声明元数据，不暴露插件根路径或 handler 路径，也不能直接调用 handler。

静态 world-data projection 与实时 story 管线使用同一 `contract:world-ir@1` 数据契约，但执行机制不同：静态数据走上面的纯函数 handler；实时回合由 `world-ir` agent 把 `narrative-engine@1` 输出抽取一次，`codex`、`core-quest`、`affinity`、`inventory` 和 `npc-graph/extractor` 再通过 typed input 并行消费。共享抽取失败时，下游按 DAG gate 跳过，不影响本轮叙事成功提交。

## 世界角色 Schema

`world.yaml` 顶层声明 `characterSchema`，包含 `types` 与 `attributes`。`player` 是保留类型，不放进 `types`；会话最多有一个 player。

```yaml
characterSchema:
  types: [npc, companion]
  attributes:
    - id: affection
      name: { zh-CN: 好感度, en-US: Affection }
      type: number
      min: 0
      max: 100
      defaultValue: 0
      category: social
```

清单保存在世界 metadata 的同名字段中，会话初始化将其写入领域 schema。`character.schema.set` proposal 使用 `{types,attributes}`，版本由内核递增。工具、`ctx.world` 和最终提交共用校验规则；角色 `fields` 必须符合 schema，非 player 类型必须在声明中。

`world-init` guard 依次使用当前会话已有 schema、世界声明的 schema、由 dimensions 推导的属性；均不可用时才调用模型生成。不会从其他会话或其他插件的私有 schema 数据复制。世界声明变更影响新会话，已有会话通过领域操作显式修改 schema。

## 领域角色与插件角色卡

三个内置世界把两类内容分别交付：`characters/main-cast.json` 是可选的插件角色卡；`characters/characters.json` 是通用领域记录。

```yaml
schemaVersion: 1
sources:
  cast:
    kind: json
    path: characters/main-cast.json
    schema: contract:character.blueprints@1
    to: contract:character.blueprints@1
    key: id
  characters:
    kind: json
    path: characters/characters.json
    to: characters
    key: id
    after: cast
```

领域文件示例：

```json
[
  {
    "id": "mio",
    "name": "Mio",
    "type": "npc",
    "description": "A fellow student.",
    "fields": { "affection": 20 }
  }
]
```

导入器为领域 ID 加上会话前缀，如 `<sessionId>-mio`，写入 `characters` 并校验会话 schema。角色读写不镜像到任何插件 namespace；面板和运行器通过 `ctx.world.characters` 或领域 API 获取同一份记录。关闭角色卡接收插件只跳过卡片数据，不影响独立的领域角色 source。

`effects: [characters]` 仍可把同一 source 的通用 `{id,name,type,description,fields}` 值投影为领域角色，但不会解释插件角色卡中的 `persona/attributes/instantiate` 语义。世界作者应优先使用独立的 `to: characters` source，明确提供要进入领域模型的字段。

## Character Presence Portraits

给角色配头像 / 立绘并在 `character-presence` 面板与对话中显示，world 包用两条 source 交付：

```yaml
sources:
  portraits:
    kind: media
    path: media/portraits # 一层目录，放 <id>.png
    to: media
    indexTo: contract:character.portrait-assets@1
    key: filename
    after: cast
  presence:
    kind: json
    path: media/presence.json
    schema: contract:character.portraits@1
    to: contract:character.portraits@1
    key: characterId
    after: portraits
```

- `media` source 把 `media/portraits/` 下的图导入媒体库，按 **`sha256(内容)`** 寻址（与 `@covel/store` media-store 的 `sha256(bytes)` 一致），并把索引写进 `plugin_data[character-presence][assets]`。
- `presence.json` 是 presence 记录数组，每条把 `characterId` 对应角色的 `avatar` / `sprite` 指向那张图。前端按实例化 `CharacterRecord.id` 的精确值或 `-<characterId>` 后缀匹配：使用 `characters/characters.json` 中的原始 `id`（如 `npc-kamishiro-mio`），它与导入后的会话前缀 ID 对应：

```json
[
  {
    "schemaVersion": 1,
    "characterId": "npc-kamishiro-mio",
    "displayName": "神代澪",
    "avatar": {
      "id": "0000000000000000000000000000000000000000000000000000000000000000",
      "mime": "image/png",
      "size": 2155557
    },
    "sprite": {
      "id": "0000000000000000000000000000000000000000000000000000000000000000",
      "mime": "image/png",
      "size": 2155557
    },
    "visuals": {
      "defaultVariant": "uniform-neutral",
      "variants": [
        {
          "id": "uniform-neutral",
          "outfit": "uniform",
          "expression": "neutral",
          "pose": "default",
          "sprite": {
            "id": "0000000000000000000000000000000000000000000000000000000000000000",
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

`visuals` 是可选的变体目录，`avatar` / `sprite` 是基础图像引用。每个 variant 必须有唯一 `id` 和 `sprite`，可用安全键标注 `outfit`、`expression`、`pose`；`stage.scale`（0.5–2）和 `offsetX/offsetY`（-100–100，百分比）用于校正不同裁切源图的屏幕大小和基线。舞台按精确 variant id、语义组合、目录默认、基础 sprite/avatar 的顺序回退，所以剧情请求了尚未制作的表情时仍会显示角色，不会空白。`scripts/emit-presence.mjs` 默认给每个角色生成一个 `default/default/neutral/default` 变体；作者可在生成结果上继续添加服装和表情图。

`mediaRef.id` 必须是该图内容的 **64 位小写 sha256**——media source 导入后媒体库以同一 sha256 寻址，二者相等才能解析到资产。手算易错，仓库提供 `scripts/emit-presence.mjs <world>`，从 `media/portraits/` 自动生成 `presence.json`（**重生成立绘后必须重跑刷新哈希**）。

preflight 要求对应 contract 的 schema 和接收声明已注册。`character-presence` 的 `assets/presence` 分别接受 `character.portrait-assets@1` 与 `character.portraits@1`。将接收插件放入 `pluginPolicy.recommended` 可供玩家选择；未启用时跳过其数据和媒体索引写入并产生 warning。媒体单文件上限 20 MB、单 source 上限 100 MB，扩展名使用 allowlist（含 `.png/.webp`）。

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
    indexTo: contract:stage.scene-assets@1
    key: filename
    after: dimensions
  scenesRegistry:
    kind: json
    path: media/scenes.registry.json
    schema: contract:stage.scenes@1
    to: contract:stage.scenes@1
    key: registryId
    after: dimensions
```

与 portraits 的差别只在于**注册表另走一条 source**：portraits 把每张图的索引直接喂给 `character-presence/assets`，而场景图除了 `scene-stage/assets` 的字节索引外，还需要 `scenes.registry.json` 整份导入 `scene-stage/scenes` 供解析 runtime 一次读全。实际写法见 `worlds/haruka-academy/data/world.data.yaml`。

`scenes.registry.json`（`scripts/emit-scenes.mjs` 自动生成，`{schemaVersion, registryId, style, scenes:[{sceneId,name,locationRef?,day,night}]}`，`day`/`night` 是 sha256 `MediaRef`）整份文档作为**一行** plugin_data 导入：`registryId: "scene-registry"` 是自描述常量字段，同时充当 `key`——scene-stage 的解析 runtime 读一行即得 `style`（增量生成用的画风 prompt 片段）与 `scenes[]` 全量，不需要按条目遍历。`scenes.registry.json` 是生成产物，不要手编，重新生成场景图后必须重跑 `emit-scenes.mjs` 刷新哈希与 `style` 块。

**未出图时的空 registry 兜底**：`media/scenes.registry.json` 不存在会导致 world-data 校验失败（source 引用了不存在的文件）。作者还没准备场景图时，对空的 `media/scenes/` 目录跑一次 `emit-scenes.mjs` 即可产出合法的空 registry（`{schemaVersion: 1, registryId: "scene-registry", style: {...}, scenes: []}`），先提交进世界包占位；scene-stage 侧空 `scenes[]` 时一律走"未命中注册表"分支（`autoGenerateScenes` 门控 → 增量生成或 `source: "none"`），不是错误状态。出图后重跑 `emit-scenes.mjs` 覆盖即可，无需改 world.data.yaml。

清单润色规范、参数表、日/夜缺图回退语义、作者四步工作流见 [场景背景生成指南](../guide/world-scenes.md)。

## Third-Party Extension

第三方库可以以 world 包或 override 包交付数据。插件作者应公开版本化 `contract:<contractId>` schema URI，再在 world 包里引用这个 schema。

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
    schema: contract:character.blueprints@1
    to: contract:character.blueprints@1
    key: id
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
    schema: contract:social.relationships@1
    to: contract:social.relationships@1
    key: id
    after:
      - cast
```

插件侧需要做到三件事：

1. 在 `PLUGIN.md` 写清楚 namespace、schema URI、数据形状和示例文件。
2. 在 runtime 或工具中读取 `plugin_data[<pluginId>][<namespace>]`。
3. 给 world 包作者提供最小可运行的 `data/world.data.yaml` 片段。

插件需要在根 `PLUGIN.md` 同时发布 schema 与接收声明：

```yaml
id: social-sim
kind: plugin
description: Import relationship records.
contracts:
  social.relationships@1:
    schema: ./schemas/relationships.schema.json
contributes:
  data:
    relationships:
      version: 1
      accepts: [social.relationships@1]
      schema: ./schemas/relationships.schema.json
```

schema 为插件根内的 JSON Schema 文件；接收声明只放在包根，不放进 `RUNTIME.md`。插件代码以 `ctx.pluginData.get(namespace,key)` / `list(namespace)` 读取自身数据，RPC 使用绑定当前会话和插件的 `ctx.store`。公共数据不依赖跨插件私有 store 访问。

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
schema: contract:social.relationships@1
to: contract:social.relationships@1
key: id
```

创建 session 时，框架会把每条实际提交的 `plugin_data`、`lorebook`、`character`、`media index` 写入 `world_data_import_ledger`，记录 `target`、`pluginId`、`namespace`、`key`、`sourceDigest`、`valueHash`、`schemaRef` 和 `sourceId`。session 创建会用 store transaction 包住 session、plugin-data、lorebook、characters 与 ledger 写入；导入失败时会回滚这些 store row。

#### 内置 RPG 玩法种子（quests / items / affinity）

三个内置 RPG 插件接受世界包预置数据（完整成品示例见 `worlds/emberback/data/`）：

| 插件         | schema URI                      | to                              | 记录形状                                                                                     |
| ------------ | ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `core-quest` | `contract:quests@1`             | `contract:quests@1`             | `{ id, name, description, status?, objectives?: [{id?, text, done?}], giver?, reward? }`     |
| `inventory`  | `contract:inventory.items@1`    | `contract:inventory.items@1`    | `{ id, name, quantity, description?, tags?: string[], equipped?: boolean }`                  |
| `affinity`   | `contract:character.affinity@1` | `contract:character.affinity@1` | `{ id, name, score (int -100..100), notes? }`（tier/history 等派生字段由工具首次写入时补齐） |

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

`world.yaml` 通过 `pluginPolicy` 表达推荐组合：

```yaml
pluginPolicy:
  recommended: [social-sim]
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
    schema: contract:social.relationships@1
    to: contract:social.relationships@1
    key: id
    merge: skipExisting
```

### 开发检查清单

- source id 使用短名，例如 `cast`、`social-links`、`portraits`。
- `path` 放在 `data/` 或 `media/` 下。
- `schema` 引用明确版本的 contract 或本地 JSON Schema。
- `to` 使用公开数据 contract 或领域 target；插件 namespace 由接收声明解析。
- `key` 指向数据对象中的稳定 id 字段。
- 大文本放 markdown/text source，大结构化数据放 yaml/json source，多媒体放 media source。
- world 包和 override 包都通过 containment 校验，路径保持在各自根目录内。

## Current Limits

- v1 source 只读取本地 `yaml`、`json`、`markdown`、`text`、`media`。
- media source 只扫描一层目录，使用 v1 扩展名 allowlist 和大小限制。
- `merge` 只支持 `replace` 与 `skipExisting`。
- `key` 只支持简单字段名、markdown/text literal key、media `filename`。
- remote、SQLite source、CUE、RO-Crate、复杂 JSON Patch override 属于后续阶段。

世界时间由插件拥有的 `world.time-definition@1` 数据契约承载，记录为 `{ id: world, definition }`，通过 `schema` 与 `to` 的同名契约导入。它不属于世界维度。AI 生成的通用 `contractData` 记录在文件、服务端存储和浏览器私有世界中保留相同契约身份；便携记录要求 `key === value.id`。字段、倒流/随机规则及会话快照语义见 [World time](./world-time.md)。

GitHub 世界包目录、多世界选择、代理下载和更新流程见 [世界目录与安装](./world-installation.md)。

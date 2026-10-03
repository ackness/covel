# World Data

`worldData` 是 world 包的统一数据入口。它把世界维度、角色卡、规则、场景模板和媒体索引声明成 source，再由服务器在 world load 或 session 创建阶段导入到现有 store。第三方插件也可以用同一套 descriptor 让 world 包携带插件数据。

## World Package

推荐结构：

```text
worlds/my-world/
├── world.yaml
├── WORLD.md                         # 默认世界观（所有语言的兜底）；可加 WORLD.en.md 等语言版本
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

`worldData` path 相对 world root。`world.yaml` 的全部字段见生成的 [World manifest 字段表](schema/world-manifest.md)，外置维度文件见 [World dimensions 字段表](schema/world-dimensions.md)。

### 动态世界维度（dimensions）

`dimensions` 是世界作者声明的开放 map，不是固定的九类设定枚举。`geography`、`factions`、`powerSystem` 等只作为内容示例；金钱、声望、城墙、图鉴等可以使用作者自己的 ID 和数据结构。声明属于世界包，当前值属于会话：同一世界的两个会话独立演化，不回写包中的初值。

#### 声明格式

```yaml
# world.yaml
dimensions:
  reputation:
    name: 声望 # 译文写在 world.en-US.yaml 的同一路径下
    description: 主角在当地的公开声望。
    schema:
      type: integer
      minimum: 0
      maximum: 100
    initialValue: 0
    updateRule: 完成居民委托后增加 5；只计已完成的委托，不计承诺。
  discoveries:
    name: 已知地点
    schema:
      type: object
      additionalProperties:
        type: object
        properties:
          description: { type: string }
          visited: { type: boolean }
        required: [description, visited]
        additionalProperties: false
    initialValue: {}
    updateRule: 明确发现具名地点时增加条目，亲自抵达后将 visited 设为 true。
```

| 字段           | 必填 | 说明                                                                  |
| -------------- | ---- | --------------------------------------------------------------------- |
| `name`         | yes  | 显示名称，支持 `I18nText`                                             |
| `description`  | no   | 含义说明，支持 `I18nText`                                             |
| `schema`       | yes  | 当前支持的 JSON Schema 子集，见下表                                   |
| `initialValue` | yes  | 满足 schema 的 JSON 初值；`null` 是值，不是删除                       |
| `updateRule`   | no   | 自然语言更新规则，支持 `I18nText`；有效 locale 下非空时才启用自动维护 |

ID 必须匹配 `^[a-z][a-zA-Z0-9_-]{0,63}$`，且不能是 `__proto__`、`prototype`、`constructor`。每项 definition 拒绝未知顶层字段。标量表示单例，嵌套对象表示复合状态，数组的 object items 表示行集，`additionalProperties` schema 表示动态命名记录；无需另一套 table/singleton 格式。玩家可修改值及 schema 允许的行，但不能在会话内新建 definition 或修改其结构。

#### 值校验与本地化

这里使用明确、封闭的 JSON Schema 子集，不是完整 JSON Schema 实现：

| 类别   | 支持的关键字                                                                                |
| ------ | ------------------------------------------------------------------------------------------- |
| 类型   | `type`：`string/number/integer/boolean/null/object/array`，也可用类型数组表示可空等联合类型 |
| 公共   | `title`、`description`、`enum`、`const`                                                     |
| 数值   | `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`                                |
| 文本   | `minLength`、`maxLength`                                                                    |
| 数组   | 单一 `items` schema、`minItems`、`maxItems`                                                 |
| 对象   | `properties`、`required`、`additionalProperties`（boolean 或 schema）                       |
| 本地化 | `x-i18n: true`；`title` 可写 `I18nText`；`x-enumLabels` 为标量枚举成员提供显示名            |

不支持的关键字（包括 `$ref`、远程 schema、表达式与代码）直接拒绝，不会忽略。初值、玩家修改和自动提交共用校验，不做类型强转或默认值填充。共享 JSON 边界限制深度 32、节点数 10,000、UTF-8 序列化体积 256 KiB；维度 map 与 schema 同样接受边界校验，不仅检查单个字段。

名称和说明是面板标签，按界面语言从 `I18nText` 解析；普通值不经过猜测式深度翻译。只有 schema 明确标记 `x-i18n: true` 的节点可以翻译。主文件写默认语言的文本，译文写在[语言文件](#语言文件namelocaleext)里；这些节点和 `updateRule` 在导入会话时按会话的内容语言解析成普通字符串，会话里不保存 locale map（见 [Dynamic Dimensions](./dynamic-dimensions.md)）。例如：

```yaml
# data/dimensions.yaml
harborRumor:
  name: 港口传闻
  schema: { type: string, x-i18n: true }
  initialValue: 灯塔有人守夜。

# data/dimensions.en-US.yaml
harborRumor:
  name: Harbor Rumor
  initialValue: Someone keeps watch at the lighthouse.
```

`title` 与 `x-enumLabels` 只影响面板显示：值仍是稳定的枚举 ID（模型、规则和校验都使用 ID），`x-enumLabels` 的键必须是该节点 `enum` 中的标量成员：

```yaml
# 主文件
schema:
  type: string
  title: 状态
  enum: [unverified, corroborated]
  x-enumLabels:
    unverified: 未核实
    corroborated: 已佐证

# 语言文件：同样的路径，只有文本
schema:
  title: Status
  x-enumLabels:
    unverified: Unverified
    corroborated: Corroborated
```

公共快照保留原始值；展示投影或查询可按注解本地化。正常 JSON `{zh: 1, en: 2}` 不会被当成翻译，ID、属性名和枚举成员不翻译。

#### 三种作者入口

三种入口使用相同 definition 格式：

1. `world.yaml` 内联 `dimensions` map。
2. `dimensionSources`：每个合法 dimension ID 指向一个相对 world root 的 YAML/JSON 文件，文件内容为**单项 definition**。
3. `worldData` descriptor：`schema: covel://world/dimensions`、`to: world:metadata.dimensions`，文件内容为**完整 definition map**，见 [Descriptor](#descriptor)。

```yaml
# world.yaml；data/reputation.yaml 的内容为上例 reputation 下的 definition
dimensionSources:
  reputation: data/reputation.yaml
```

外部单项覆盖同 ID 的内联声明；descriptor 中写向 `world:metadata.dimensions` 的 source 按加载顺序替换有效 map。只有最终有效声明进入会话，不分别初始化被覆盖的来源。外部文件沿用 locale 变体与 containment 校验；任何声明读取或校验失败保留上一份完整世界。

#### 初始化、演化与公共读取

会话导入器通过 `world.dimensions@1` 发现唯一活跃提供者，将最终声明、初值和 provenance ledger 一起导入；内联、外部文件以及没有 `worldData` 的存储型世界也进入账本。捆绑的 `world-init` 负责初始化与持续维护，不在框架中按插件 ID 选择属主。

- `dimension-context` 是不调用模型的 pre-turn function，发布已提交快照。
- `dimension-tracker` 在 post-turn 按规则与本轮叙事结算；已激活的 WorldIR 可作为共享辅证，不强制启用抽取器。没有有效更新规则时跳过维护模型调用。
- 规则判断交给模型，结构和范围由提交边界校验；这不是确定性公式或周期结算引擎。
- 当前值通过 `ctx.world.dimensions.<id>.value`、`{{ world.dimensions.<id>.value }}` 与 session snapshot 的 `dimensions.<id>.value` 公共读取。公共项包含名称、说明、schema、值、版本，不包含更新规则或初值。
- 提示词使用有预算的当前值投影，较大的值通过 builtin `world-dimension-list/get` 按需查询；维度不再双写为 constant lorebook。

数值更新需要 `expectedVersion` 并整批原子提交。无变化也有显式回执；维护失败、未运行或冲突保留 `pending-settlement`，下次叙事前需重试、人工确认或明确跳过。玩家编辑走受信恢复元数据指定的 manual runtime RPC，不使用通用 plugin-data 写入。快照时序、五种回执状态与读写边界见 [World Model](world-model.md#动态维度快照)，调用示例见 [API](api.md#维度编辑与待结算恢复)。

角色、背包、好感和时间仍由各自领域属主维护，本期没有把它们复制成另一份 dimension 权威。状态条件事件、隐藏载荷注入与触发调度（#97）不属于本能力，不能把不公开更新规则理解为事件载荷保密机制。

> **BREAKING CHANGE**：旧九类 raw dimension 数据不再合法，每项都必须改成 definition 格式。旧 `entries`/constant lorebook 维度副本不是当前值来源；需要重建受影响的开发世界、会话与快照。不提供旧格式读取、双写或自动迁移。

### AI 生成结果与文件导出

`@covel/create` 的 `createWorld({ llm, concept, ... })` 生成并验证内容，成功时返回 `id`、`manifest`、`lore`、`locale`、`packageContent` 与 `warnings`（数量低于简报目标的内容、被丢弃的无效维度）；失败时返回 `success: false` 和 `errors`。返回的 manifest 是 schema 校验后的规范值，包含 locale 的规范形式和 `characterSchema.types` 等默认值；三种保存目标消费同一份规范值。生成过程不写世界包，也不接收 `outputDir`。生成 manifest 必须包含内联数据，不能引用尚未生成的 `worldData` 或 `dimensionSources` 文件。 简报生成的 `memoryDefinitions` 在规范化时转换成 `packageContent.contractData` 中的 `memory.blocks@1/world` 记录；文件与非文件模式消费同一份合同数据，同一目标重复声明会被拒绝。

需要文件包时显式调用 `await writeWorldPackage(outputDir, result)`。导出返回相对文件路径，在独立副本中把内联数据转换为文件引用，保留原生成结果；已有同名包会被拒绝，并发发布只允许一个完整包成功。

AI 创建器可按创作简报生成 `characters/main-cast.json` 与 `data/lorebook.yaml`，并和 dimensions 一起写入 `data/world.data.yaml`。文件型世界在创建 session 时始终按 descriptor 导入。

插件内容由创作简报的 `contracts` 指定：生成器只为被选中的数据契约生成记录，每个契约的 schema、写作提示和示例取自接收插件的 `authoring` 声明（需声明 `generate`），接收插件会被加入 `pluginPolicy.requested`。未选中的契约不会进入提示词；模型为未选中的契约输出记录，或漏掉被选中的契约，都会让本次尝试失败并重试。每条记录写成 `data/contract-<n>.json`，接收方声明了 lorebook 投影时目标为 `contract:<id>+lorebook`。

`server-store` 与浏览器本地世界没有可长期读取的包目录。生成接口直接使用经过校验的生成结果，把通用领域角色放入 `WorldRecord.metadata.embeddedCharacters`，把资料库与规则放入 `WorldRecord.metadata.embeddedLorebook`。session 创建仅在没有导入文件 worldData 时使用这份回退；因此同一世界不会重复导入。便携回退只承载文本内容，图片仍必须使用 media source、真实文件和内容寻址索引。

### 三个完整内置示例

世界包不必启用所有能力；应让题材决定插件组合与数据层。仓库内三个世界展示了不同的数据组合：

| 示例                    | 玩家体验                                    | 主要能力                                                                                                                                                                                                                                            | 适合参考的文件                                                                                                                     |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `worlds/mistport`       | 黑暗奇幻调查，面向重剧情玩家                | `mistport-investigation` 组合；演化维度「案情板 / 四方立场 / 深退潮 / 钥匙碎片」；`visibility: hidden` 的隐藏事件（`story-events`）；按 locale 选择的世界观、角色、规则与 presence；角色属性 schema、立绘、潮汐与势力规则                           | `world.yaml`、`WORLD.zh.md` / `WORLD.en.md`、`data/dimensions.yaml`、`data/rules/`、`characters/`、`media/`                        |
| `worlds/haruka-academy` | 校园群像恋爱（GalGame），对话与视觉小说舞台 | `haruka-galgame` 组合（舞台、多回复、好感）；`defaultViewMode: stage`；好感种子与演化维度「心之路线 / 学园祭筹备 / 文艺部存续审查 / 约定 / 校园传闻」；隐藏个人线事件及其后续；透明立绘与日 / 夜场景注册表                                          | `world.yaml`、`WORLD.md`、`data/dimensions.yaml`、`data/affinity.yaml`、`data/rules/`、`characters/`、`media/scenes.registry.json` |
| `worlds/emberback`      | 英文科幻救援，RPG 资源与任务推进            | `emberback-rescue` 组合；骰子判定、任务、物品与好感种子；演化维度「Crownfire Countdown / Relay Grid / Signal Log / Medical Convoy」；隐藏事件及事件链                                                                                               | `data/dimensions.yaml`、`data/quests.yaml`、`data/items.yaml`、`data/affinity.yaml`、`characters/`                                 |
| `worlds/lantern-barrow` | 经典跑团地城探索（中英双语）                | `classic-tabletop` 组合；`tabletop-rules` 开局配点（`contract:tabletop-rules.rules.initial@1`）与表单检定、`dice-check` 骰池；任务 / 物品 / 好感的 `.en` 变体；演化维度「古冢地图 / 古冢警戒 / 古冢之灯 / 名望」；隐藏遭遇及事件链（含 `.en` 变体） | `world.yaml`、`WORLD.md` / `WORLD.en.md`、`data/tabletop-rules.json`、`data/*.en.yaml`、`characters/*.en.json`                     |

四个世界都把内容通过 `data/world.data.yaml` 接入同一导入协议，但不会为了展示能力而加入与题材无关的插件。四个世界都启用 `story-events`。雾港、Emberback 与提灯古冢另外以 `pluginSettings.story-events.planner: true` 开启剧情策划：作者预设的隐藏事件之外，它会根据游玩中留下的线索追加只触发一次的后续事件。遥风学园的恋爱路线由作者逐条编排，不开启剧情策划。开发新世界时，先复制更接近目标交互模式的结构，再按后文各 source 契约增减角色、规则或媒体层。

`defaultViewMode`（可选）：会话首次进入 Playing 时的默认呈现模式。接受 `stage`（全屏舞台模式，见 [ui-panels.md](./ui-panels.md#舞台模式stage-view)）或 `parsed`。它经 `world-seed-loader` 拼进 `WorldRecord.metadata.defaultViewMode`，前端仅在会话首挂载时用作初值——玩家在头部切换视图后即以玩家选择为准。

`pluginPolicy` 只描述选择意图，不锁死核心插件。会话解析器依据插件包公开的 `provides/requires/optional/conflicts` contract 和授权状态生成最终激活集。

| 字段                            | 说明                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `presetId`                      | 默认组合包 ID，可引用 `packs[].id` 或内置 preset                                        |
| `preferredTags` / `avoidedTags` | 插件标签偏好                                                                            |
| `requires`                      | 世界必需的契约 ID（如 `action-check@1`），任何提供该契约的已安装插件都能满足            |
| `requested`                     | 世界建议作为初始选择的插件 ID                                                           |
| `recommended`                   | 额外推荐插件 ID                                                                         |
| `packs`                         | 自定义组合包，每项包含 `id/label`，可选 `description/requested/recommended/tags/reason` |

`requires` 表达"这个世界离不开什么能力"，写契约而不是插件：

```yaml
pluginPolicy:
  requires:
    - action-check@1 # 行动判定；内置的 dice-check 提供它，换一个判定插件也可以
  requested:
    - dice-check # 可选：初始选择，同时在有多个提供者时指定用哪一个
```

只有一个已安装的提供者时它会被自动启用。没有提供者，或有多个而世界与玩家都没有选定，准备页说明原因并禁用开始。玩家仍可主动关掉提供者：这是玩家的选择，会话照常开始，准备页给出提示。`requires` 只接受 `名字@版本` 形式的契约 ID，写成插件 ID 会在加载世界时报错。

`requested` 写的是插件 ID，玩家的宿主不一定装了它。`GET /api/worlds/:id/plugin-plan` 会把未安装的 ID 从世界策略和各组合包的 `requested` 中剔除，改列在 `missing`（组合包请求的带 `packId`）。准备页据此提示缺少哪些插件，会话仍可创建，只是这些插件提供的玩法不会生效。`recommended` 不参与默认选择，原样返回。

世界清单采用严格的当前 schema；不接受旧选择字段，也不会把顶层字段折叠为另一套格式。

### 启动加载与收敛（seed & reconcile）

服务器启动时按目录顺序 seed 世界：先 bundled（`COVEL_WORLDS_DIR`，源码默认仓库 `worlds/`），再 user（`COVEL_USER_WORLDS_DIR`，否则 `$COVEL_HOME/worlds`，未设置 home 时为 `~/.covel/worlds`；桌面由 shell 注入 `<data_root>/worlds`）。seed 是 **idempotent upsert**——每个世界包的 `WorldRecord` 写入 DB，`metadata.source = "file"`。

浏览器私有存储首次初始化空库时，从 `GET /api/worlds` 导入完整目录，保留清单 ID、世界观、维度、角色与包元数据，并将副本标注为浏览器 IndexedDB。目录请求失败不会写入初始化标记，可以重试；成功的空目录也是有效结果。初始化完成后，浏览器保存的世界始终由本地编辑和删除管理，后续启动不请求或自动覆盖目录，支持离线读取。已有本地世界也不会被初始化覆盖。服务端目录后续变化不自动更新这些副本；旧开发库中的简化样例需按需重新创建浏览器库。

seed 本身**只新增/更新、从不删除**，所以一个曾经内建、后被归档（从包里移除）的世界会**残留在所有老用户的 DB 里**并继续出现在世界列表。为此 seed 完所有目录后会跑一次 **收敛（reconcile）**，删除"已不在任何世界源里"的陈旧 seed 记录。三重安全栏，确保只清死 seed、绝不误删用户数据：

1. **来源闸门**：仅 `metadata.source === "file"`（纯文件 seed）的世界可被清理。AI 生成的世界（`generated` / `generated-file`）及其它任何来源**永不触碰**，即便它不在当前世界源里。
2. **存档保护**：陈旧世界若仍有存档（session），**保留不删**并打 `warn` 日志；删除带存档的世界属于显式操作，不会由启动时的静默收敛执行。
3. **完整扫描护栏**：任一世界源目录无法扫描、任一已发现世界包读取/解析/校验失败，或本次没有成功加载任何世界时，**整体跳过收敛**。健康世界仍可更新；部分成功不构成删除其它世界的依据。

> 想清掉一个**仍有存档**的内建世界（收敛会因安全栏保留它），需显式删除其世界记录与关联 session。

### 文件更新与安装

世界包安装与 AI 生成的 `server-file` 目标写入用户世界目录，不回写内置资源。安装接口成功激活后返回 `restartRequired: false`，立即可从世界列表查询；激活失败只移除本次新建目录，允许重试。

server 使用 Node 26 的递归 `fs.watch` 监听内置与用户世界目录，包含 Linux。已有世界的 YAML / Markdown 文件变化会按物理目录延迟 500ms 合并后重读，读取后使用清单的 `id` 查询、更新世界并通知会话（目录名无需与 `id` 相同）；**仅维度发生变化时**更新存储，并向使用该世界的 session 发出 `world.dimensions.changed`。这是作者声明变化通知，不会将会话的演化值重置成新初值；已有会话需显式同步并检查冲突。它不是完整世界包或插件的热重载：直接放入一个新世界目录需重启 seed 或走安装入口，其他世界内容更新也应重启加载。

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
  story-events:
    planner: true
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

逐字段说明见生成的 [World data descriptor 字段表](schema/world-data-descriptor.md)；目标 URI 的阶段与语义见下方 [Target URI](#target-uri)，隐藏数据见[隐藏数据](#隐藏数据visibility-hidden)。

media source 应同时声明 `key: filename` 和 `indexTo: contract:<contractId>`。缺 key 会产生 error；缺 indexTo 无法生成媒体索引写入。当前媒体字节持久化随有效 media-index write 执行，因此没有活跃索引接收方时不会导入该 source 的字节。此时产生 warning，不阻断其他数据与投影；启用接收插件后可通过 sync 补导入。

### 隐藏数据（`visibility: hidden`）

source 默认是公开的。声明 `visibility: hidden` 的 source 承载「条件满足前不能被知道」的内容，例如隐藏剧情。它只能写入数据合约（`to: contract:<contractId>`），导入后落在接收插件的保留命名空间 `_hidden.<namespace>`（例如 `story-events` 的 `events` 命名空间对应 `_hidden.events`）。

```yaml
sources:
  storyEvents:
    kind: yaml
    path: data/hidden/story-events.yaml
    schema: contract:story.events@1
    to: contract:story.events@1
    key: id
    visibility: hidden
```

框架统一保证：

| 出口            | 处理                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提示词          | `input.inject` 注入隐藏命名空间时直接报错；扩展点（`prompt.segment@1`、`ui.slot@1`、`session.world-context@1`）的 `ctx.pluginData` 读不到隐藏数据 |
| 模型工具        | 内置 `plugin-data-get` / `plugin-data-list` 不返回隐藏命名空间                                                                                    |
| 玩家可见接口    | 插件数据 API、`/state` 数据面板与 discovery 不列出，单条读取返回 404                                                                              |
| lorebook 与投影 | 不允许 `+lorebook`；`worldProjections` 跳过隐藏 source                                                                                            |
| 其他目标        | `characters`、`lorebook`、`world:metadata.*`、media 与 `indexTo` 都会被拒绝                                                                       |
| 写入            | REST 与内置 `plugin-data-set` 工具不能写；只有所属插件自己的代码（function runtime、插件本地工具）能写自己的 `_hidden.*`                          |

只有接收插件自己的 runtime 代码能读取隐藏数据。插件决定揭示时，应通过本回合的 runtime 输出把内容交给需要的消费者，并在公开命名空间里留下不含原文的揭示记录；内置的 [`story-events`](plugins.md) 就是这样做的。揭示之后，内容会作为叙事该回合的输入出现在叙事的执行详情里。

#### 剧情中追加的隐藏内容

隐藏内容也可以在游玩中产生。runtime 发布带契约的输出，接收插件校验后写入自己的 `_hidden.<namespace>`；处理这些内容的 runtime 声明 `io.concealed: true`，其提示词、工具参数、结果与输出不会进入 trace、实时流、`/view`、`/turns` 或手动 RPC 的返回。内置链路：

1. `story-events/plot`（agent，post-turn，每 3 回合，设置 `planner` 开启时运行）读取世界简介、主角、本回合叙事、可选的本回合 WorldIR 抽取、维度快照、世界时间，以及 `evaluate` 公开的账本（已发生事件与已埋下事件的 ID / 标题，不含世界作者尚未发生的事件），调用 `plan-story-events` 发布 `story-event.plan@1`。
2. `story-events/intake`（function，post-turn）校验每份计划：事件结构、引用的维度 / 时间字段 / 事件是否存在，不能覆盖世界作者的事件或已发生的事件，同时等待的计划事件最多 8 个。通过的事件写入 `_hidden.planned`，只触发一次。
3. `story-events/evaluate` 每回合同时评估 `_hidden.events` 与 `_hidden.planned`，条件满足时照常交给叙事。

计划事件不随世界数据同步覆盖，因为它们和作者事件分属不同的隐藏命名空间。

隐藏的意义是「不剧透」，不是加密：世界包文件就在玩家本地，浏览器本地模式的工作区 checkpoint 也包含这些数据以便执行。不要把真正需要保密的信息写进世界包。

### 语言文件（`<name>.<locale>.<ext>`）

**主文件只写一种语言**，即 `world.yaml` 的 `defaultLocale`。其他语言放在主文件旁边的 `<name>.<locale>.<ext>` 里，只写译文，不重复结构：

```text
world.yaml                     # 主文件，defaultLocale 的文本
world.en-US.yaml               # 只有英文译文
data/dimensions.yaml
data/dimensions.en-US.yaml
characters/main-cast.json
characters/main-cast.en.json
WORLD.md
WORLD.en.md                    # 正文类文件没有可对齐的 id，整份替换
```

```yaml
# world.yaml
name: 雾港・裂潮纪
characterSchema:
  attributes:
    - id: fogRot
      name: 雾蚀
      type: number

# world.en-US.yaml —— 只有文本
name: Mistport Chronicles
characterSchema:
  attributes:
    - id: fogRot
      name: Fog Rot
```

合并规则（`@covel/shared` 的 `applyLocaleOverlay`）：

- 对象按 key 合并；对象列表按 `id` 合并（worldData source 用它声明的 `key`），元素没有 `id` 时按位置合并。
- 语言文件只能翻译主文件里已有的文本。出现主文件没有的 key 或 id、在结构位置写文本、改动数字或布尔值，这一条都会被忽略并报告，主文件的值保留。
- 没翻译的文本回退到主文件，所以可以逐步翻译。把主文件整份复制再改文字也是合法的语言文件。
- 纯文本列表（例如别名）作为一个整体翻译：语言文件里的列表替换主文件的列表，某一项写 `null` 表示沿用主文件。
- 文件名里的 `<locale>` 必须是真实语言的标签（`en`、`en-US`、`zh-Hant`）；`items.backup.yaml` 不会被当成语言文件。

两种读取方式：

| 文件                                                                                           | 读取方式                                                          | 结果                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `world.yaml`、维度定义（`dimensionSources` 的文件、`to: world:metadata.dimensions` 的 source） | 所有语言文件一起编译                                              | 文本成为 locale map，世界目录和面板标签按界面语言显示 |
| 其他结构化 worldData source（JSON / YAML）                                                     | 只合并会话语言的那一份：先精确 locale，再 script 兼容的主语言短键 | 单一语言的数据；会话里不保存 locale map               |
| `markdown` / `text` / `media`                                                                  | 语言文件整份替换主文件                                            | 同上                                                  |

- 会话语言在创建时确定；`importWorldDataForSession` / `syncWorldDataForSession` / `preflightWorldDataForSession` 的 `locale` 选项透传，缺省时取 `session.locale`。`zh-Hant-TW` 不会读取 `zh` 的文件。
- 语言文件是 source 的一部分：改动任何一份都会改变该 source 的摘要，`sync-data` 能看到。
- **主文件不再写内联 locale map**（`name: { zh-CN: …, en-US: … }`）。`pnpm validate:world` 把它报为 `inline-locale-map` 错误。此前用内联写法的世界包需要拆成主文件加语言文件；内置的三个双语世界已经这样迁移。
- 维度值里只有 schema 标了 `x-i18n: true` 的文本节点可以翻译；翻译其他节点会让该维度校验失败。

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

`living-world-rules` 将每个源 statement ID 投影为 `world-ir-` 加其 UTF-8 SHA-256 十六进制摘要，并在 `sourceStatementId` 保留原始 ID。这样中文、带标点和长 ID 都满足目标规则的 ASCII/长度约束，源 ID 变化也会产生不同键。所有 WorldIR 规则使用同一映射；旧键的开发期导入数据需要重建后重新导入，手工规则 ID 不受影响。

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

静态 world-data projection 与实时 story 管线使用同一 `contract:world-ir@1` 数据契约，但执行机制不同：静态数据走上面的纯函数 handler；实时回合由 `world-ir` agent 把 `narrative-engine@1` 输出抽取一次，`codex`、`core-quest/log`、`affinity`、`inventory/ledger` 和 `npc-graph/extractor` 再通过 typed input 并行消费。其中任务和物品是只读取固定字段事件的 function runtime，不调用模型；好感仍由 agent 判断（字段见 [tools.md · submit-world-facts](./tools.md#submit-world-facts)）；`inventory/vocabulary` 与 `core-quest/vocabulary` 在 pre-turn 经 `world-ir.vocabulary@1` 公布已追踪的物品名、任务名和未完成目标，抽取时沿用同一名称。共享抽取失败时，下游按 DAG gate 跳过，不影响本轮叙事成功提交。有自动维度维护义务的会话同时保留 `pending-settlement` 回执，不能将失败或跳过视为维度无变化；恢复完成前阻止下一次叙事。

## 世界角色 Schema

`world.yaml` 顶层声明 `characterSchema`，包含 `types` 与 `attributes`。`player` 是保留类型，不放进 `types`；会话最多有一个 player。

```yaml
characterSchema:
  types: [npc, companion]
  attributes:
    - id: affection
      name: 好感度 # world.en-US.yaml 里按 id 写 `name: Affection`
      type: number
      min: 0
      max: 100
      defaultValue: 0
      category: social
```

清单保存在世界 metadata 的同名字段中，会话初始化将其写入领域 schema。`character.schema.set` proposal 使用 `{types,attributes}`，版本由内核递增。工具、`ctx.world` 和最终提交共用校验规则；角色 `fields` 必须符合 schema，非 player 类型必须在声明中。

`world-init` guard 优先使用当前会话已有 schema，再使用世界声明的 schema；均不可用时才调用模型生成。维度初始化与角色属性生成是两种职责，不再将 dimension 资源结构自动推导成角色字段，也不会从其他会话或其他插件的私有 schema 数据复制。世界声明变更影响新会话，已有会话通过领域操作显式修改角色 schema。

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

导入器原样使用领域 ID（如 `mio`）写入 `characters` 并校验会话 schema；角色表按 `(sessionId, id)` 区分会话，ID 不再带会话前缀，提示词里的角色引用因此更短。角色读写不镜像到任何插件 namespace；面板和运行器通过 `ctx.world.characters` 或领域 API 获取同一份记录。关闭角色卡接收插件只跳过卡片数据，不影响独立的领域角色 source。

`effects: [characters]` 仍可把同一 source 的通用 `{id,name,type,description,fields}` 值投影为领域角色，但不会解释插件角色卡中的 `persona/attributes/instantiate` 语义。世界作者应优先使用独立的 `to: characters` source，明确提供要进入领域模型的字段。

## Character Presence Portraits

给角色配头像 / 立绘并在 `character-blueprint` 的立绘面板与对话中显示，world 包用两条 source 交付：

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

- `media` source 把 `media/portraits/` 下的图导入媒体库，按 **`sha256(内容)`** 寻址（与 `@covel/store` media-store 的 `sha256(bytes)` 一致），并把索引写进 `plugin_data[character-blueprint][assets]`。
- `presence.json` 是 presence 记录数组，每条把 `characterId` 对应角色的 `avatar` / `sprite` 指向那张图。前端按实例化 `CharacterRecord.id` 的精确值或 `-<characterId>` 后缀匹配：使用 `characters/characters.json` 中的原始 `id`（如 `npc-kamishiro-mio`），导入后的角色 ID 与它相同：

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

preflight 要求对应 contract 的 schema 和接收声明已注册。`character-blueprint` 的 `assets/presence` 分别接受 `character.portrait-assets@1` 与 `character.portraits@1`。将接收插件放入 `pluginPolicy.recommended` 可供玩家选择；未启用时跳过其数据和媒体索引写入并产生 warning。媒体单文件上限 20 MB、单 source 上限 100 MB，扩展名使用 allowlist（含 `.png/.webp`）。

实际范例见 `worlds/mistport` 与 `worlds/haruka-academy`（`data/world.data.yaml` + `media/`），提示词与生成流程见 [角色立绘生成指南](../guide/world-portraits.md)。

## Scene Backgrounds

世界包的预制背景通过 `stage.scene-assets@1` / `stage.scenes@1` 导入，使用已有图片无需配置图像模型。启用 `scene-stage` 的自动补图后，缺图时才调用该插件 `modelPresetId` 指向的图像用途。安装社区插画插件不会替它选择模型，见[图像生成](image-generation.md)。

场景背景（教室、社团楼、海堤这类地点插画，日/夜各一张）与立绘同一套图片管线，但清单结构不同：作者手编 `media/scenes.json`，脚本按清单批量生成 PNG、再由 `scripts/emit-scenes.mjs` 生成内容寻址的 `scenes.registry.json`。

`media/scenes.json` 字段：

| 字段           | 说明                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | 场景机器键，也是文件名前缀（`<id>-day.png` / `<id>-night.png`）。                                                                                 |
| `name`         | 场景显示名。                                                                                                                                      |
| `locationRef`  | 对应作者定义的地点名。内置 geography 模板的声明路径为 `geography.initialValue.regions[].name` 或其 `landmarks[].name`；这不是框架要求的维度结构。 |
| `subject`      | 英文画面描述（日图），composes 为 `style.prefix + subject + style.suffix`。                                                                       |
| `subjectNight` | 可选，夜图专用画面描述；留空则夜图回退用 `subject`（配合 `style.nightSuffix`）。                                                                  |

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

与 portraits 的差别只在于**注册表另走一条 source**：portraits 把每张图的索引直接喂给 `character-blueprint/assets`，而场景图除了 `scene-stage/assets` 的字节索引外，还需要 `scenes.registry.json` 整份导入 `scene-stage/scenes` 供解析 runtime 一次读全。实际写法见 `worlds/haruka-academy/data/world.data.yaml`。

`scenes.registry.json`（`scripts/emit-scenes.mjs` 自动生成，`{schemaVersion, registryId, scenes:[{sceneId,name,locationRef?,day,night}]}`，`day`/`night` 是 sha256 `MediaRef`）整份文档作为**一行** plugin_data 导入：`registryId: "scene-registry"` 是自描述常量字段，同时充当 `key`——scene-stage 的解析 runtime 读一行即得 `scenes[]` 全量，不需要按条目遍历。`scenes.registry.json` 是生成产物，不要手编，重新生成场景图后必须重跑 `emit-scenes.mjs` 刷新哈希。

**未出图时的空 registry 兜底**：`media/scenes.registry.json` 不存在会导致 world-data 校验失败（source 引用了不存在的文件）。作者还没准备场景图时，对空的 `media/scenes/` 目录跑一次 `emit-scenes.mjs` 即可产出合法的空 registry（`{schemaVersion: 1, registryId: "scene-registry", scenes: []}`），先提交进世界包占位；scene-stage 侧空 `scenes[]` 时一律走"未命中注册表"分支（`source: "none"`，舞台回退世界头图），不是错误状态。出图后重跑 `emit-scenes.mjs` 覆盖即可，无需改 world.data.yaml。

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

当前版本能预置哪些内容、各自怎么声明和怎么写，用下面的命令查询。输出来自各插件的 `contributes.data.*.authoring` 声明，包含可直接粘贴的 source 条目和一份合法示例：

```bash
pnpm describe:authoring              # 文本
pnpm describe:authoring --json       # 机器可读
pnpm describe:authoring --plugins ~/.covel/plugins   # 一并扫描社区插件
```

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
6. 普通导入 row 可通过 `force:true` 覆盖 modified/missing 冲突；维度的已演化值及待结算保护不因此解除。

维度同步另有领域约束：作者 definition 的摘要未变时保留当前进度，不重复应用初值；新增维度以初值初始化。修改或删除已演化/手改的维度，或尚有待结算义务时，返回 `modified` 冲突并保留值和 definition。未改动的导入基线才可采用新声明或删除，schema 改变不自动迁移旧值。同步在事务内重验 hash 与版本，预检通过不授权随后无条件覆盖。有冲突时返回计划及冲突，不应用本次同步。

`POST /api/worlds/:id/sync-dimensions` 仅同步维度，使用相同账本和冲突规则；不清理其他导入领域，也不重建 lorebook。热更新通知本身不改变会话当前值。

media index 同步删除只在事务提交后移除当前 session 的显式 media ref；ownership 随会话生命周期释放，底层内容寻址字节由媒体 GC 回收。准备阶段将字节和本次导入专属的 `world-data-import:<uuid>` 临时引用原子写入，防止发布完成前被 GC 回收。finalization 先建立真实会话的归属与引用，再释放临时引用；准备、事务或会话准入失败只释放本次导入的临时引用，不强制删除共享字节，不释放已有会话的 claims。新建会话的媒体 finalization 失败时，在同一会话生命周期锁内删除该会话并释放其媒体归属与引用。语义事务已提交但媒体 finalization 失败时保留临时引用，避免已提交索引失去保护；会话创建回滚删除失败时同样保留。临时引用释放失败仅记录日志；进程崩溃或释放失败可能遗留临时引用，GC 会保守保留其字节，不会自动过期，需确认导入已停止后人工清理。此机制复用现有引用表，无需迁移。

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

### 静态校验（`pnpm validate:world`）

```bash
pnpm validate:world worlds/my-world
pnpm validate:world --strict --plugins ~/.covel/plugins ~/.covel/worlds/my-world
```

校验器不创建会话、不执行插件代码，但复用建会话时的 worldData 预检，因此这里通过的数据在建会话时不会再因记录内容失败。插件目录取仓库 `plugins/` 加上每个 `--plugins <dir>`。

| 诊断 code               | 级别             | 含义                                                                                      |
| ----------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `manifest-invalid`      | error            | `world.yaml` 无法解析或不符合 schema                                                      |
| `lore-missing`          | error            | 某个声明的语言（`defaultLocale` / `supportedLocales`）解析不到 lore 文件                  |
| `lore-fallback-missing` | warning          | 没有 `WORLD.md`，未声明语言的会话会拿到空 lore                                            |
| `unknown-plugin`        | error 或 warning | `pluginPolicy` / `pluginSettings` 引用的插件 ID 不在已扫描目录中                          |
| `unknown-setting`       | warning          | `pluginSettings` 的 key 不是该插件声明的设置项，值会被忽略                                |
| `unprovided-contract`   | error 或 warning | `pluginPolicy.requires` 的契约没有提供者                                                  |
| `unresolved-contract`   | error 或 warning | source 使用的数据契约没有任何已扫描插件接收                                               |
| `world-data`            | 与预检一致       | descriptor、source 顺序、文件读取、target、隐藏数据规则，以及按契约 schema 逐条校验的记录 |
| `locale-overlay`        | warning          | 语言文件里有一条译文无处安放（主文件没有这个 key 或 id，或它改了非文本的值），这条被忽略  |
| `locale-script`         | warning          | 非中日韩语言的语言文件里留有中日韩文字：没翻译的文本，或从主文件照抄的触发词              |
| `inline-locale-map`     | error            | 主文件里把文本写成了 locale map；主文件只写一种语言，译文放进语言文件                     |

标为“error 或 warning”的三项：拼写接近某个已知 ID 时判为 error 并提示 “Did you mean”；否则默认是 warning（提供者可能是未扫描的社区插件），加 `--strict` 后一律为 error。`pnpm release:preflight` 对内置世界使用 `--strict`。

每个声明的语言各跑一遍预检，因为[语言文件](#语言文件namelocaleext)会让不同语言读到不同文本；主文件旁的每个语言文件都会检查，不限于声明的语言。校验逻辑在 `apps/server/src/world-data/validate-world-package.ts`，返回结构化诊断，可被其他工具复用。

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

# 世界数据

这一页说明一个世界包里可以放哪些文件，每个文件怎么写，以及 Covel 什么时候读它们。写世界的人查文件格式和校验报错时看这一页；给世界提供数据格式的插件作者看后半部分。

第一次做世界请先跟着[第一个世界](../worlds/first-world.md)走一遍。想给世界预置任务、物品和好感，看[预置开局内容](../recipes/starting-content.md)；想做开局配点，看[开局配点和掷骰判定](../recipes/point-buy.md)。

几个贯穿全页的词：

- **世界包**：一个文件夹，里面是 `world.yaml`、`WORLD.md` 和可选的数据、角色、图片。
- **source**：世界包里的一份数据来源，通常是一个文件，媒体则是一个目录。
- **descriptor**：一份可选的清单文件（`data/world.data.yaml`），逐条列出 source。大多数世界不需要它。
- **会话**：玩家用这个世界开的一局游戏。世界包里的数据在创建会话时被复制进会话，之后各局各自变化。

## World Package

**最小的世界包**是两个文件：

- `world.yaml`：世界的清单。必填字段有五个：`schemaVersion`、`id`、`name`、`summary`、`defaultLocale`。
- `WORLD.md`：世界观正文。

之后每增加一种内容，就在约定的位置加一个文件，不需要再登记：

| 文件                         | 内容                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `data/dimensions.yaml`       | 世界维度                                                                                                               |
| `data/lorebook.yaml`         | 按关键词触发的设定条目                                                                                                 |
| `characters/characters.json` | 领域角色记录                                                                                                           |
| 插件声明的路径               | 该插件接收的数据，例如 `data/quests.yaml`（任务）、`characters/main-cast.json`（角色蓝图）、`media/portraits/`（立绘） |

最后一行的路径由插件自己声明，装了什么插件就有什么约定路径。下面的命令列出当前版本的全部路径和每种数据的示例：

```bash
pnpm describe:authoring
```

这套约定的规则见[按约定导入](#按约定导入没有-descriptor)。

推荐结构：

```text
worlds/my-world/
├── world.yaml
├── WORLD.md                         # 默认世界观（所有语言的兜底）；可加 WORLD.en-US.md 等语言版本
├── data/
│   ├── world.data.yaml               # 可选：文件不在约定位置、或要指定顺序时才需要
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

`media/portraits.json` 和 `media/scenes.json` 是生图清单。只有四个脚本读它们：`scripts/generate-portraits.mjs`、`scripts/emit-presence.mjs`、`scripts/generate-scenes.mjs`、`scripts/emit-scenes.mjs`。服务端不导入它们，游玩时也不需要；不打算重新生图的世界可以不带。游玩时被读取的是 `presence.json`、`scenes.registry.json` 和图片目录。

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
worldData: data/world.data.yaml # 可选：不写时按约定路径读取，见下文“按约定导入”
defaultViewMode: stage
```

- `worldData` 是 descriptor 的路径，相对世界包根目录。只有世界包带 descriptor 时才写它。
- `world.yaml` 的全部字段见生成的 [World manifest 字段表](./schema/world-manifest.md)，外置维度文件见 [World dimensions 字段表](./schema/world-dimensions.md)。
- 清单只接受当前的字段。写了不认识的字段会报错，不会被悄悄忽略或换成别的写法。

### 正文怎样进入故事

`WORLD.md` 每个回合都会交给叙事模型，放在故事提示词的 `<world-lore>` 段里。

- **语言**：世界声明了几种语言，就读取对应的 `WORLD.<locale>.md`。会话的语言在创建时固定，正文按它选择。
- **编辑过的正文优先**：玩家在应用里改过世界正文时，默认语言用改过的版本。会话自己有一份正文（`loreOverride`）时用会话的，哪怕它是空的。
- **长度上限**：约 8,000 token。这是估算值：中文一字约一个，其他文字四个字符约一个。超出时在最后一个放得下的整行之后截断。
- [只给叙事者的正文](#只给叙事者的正文narrator-only)也算在长度里，因为模型会读。
- `pnpm validate:world` 在超出时给出警告（`prompt-size`），写明估算值与上限。世界详情页也会对放不下的世界显示一条说明。

框架不会从 `tone`、`startingConditions` 这类字段里提取专用的提示词。想让模型知道的基调和开局条件，写进正文或维度。

应用内的翻译和 AI 修改都要调用模型，需要一段时间。结果写回之前会再核对一次：这个世界还是不是原来那个。期间世界被编辑、删除，或者用同一个 ID 重建了，旧结果就作废，不会覆盖现在的世界。翻译成功时只加入新语言和它的正文，已保存的编辑保留。

### 只给叙事者的正文（narrator-only）

`WORLD.md` 有两类读者。模型读整篇。玩家也能读到它：右侧面板的“世界”页签、开局准备页的“世界文档”、世界详情页。

只该叙事者知道的内容——暗线、谜底、怎样主持和控制节奏——放在两行标记之间：

```markdown
## 人物

- **梅瑞尔**：酒馆老板娘，记性好、嘴巴紧。

<!-- narrator-only -->

## 暗线

灯是守灯人自己吹灭的。前三个房间里不要说破。

<!-- /narrator-only -->

## 开局

雨夜，你推开酒馆的门。
```

- 标记之间的内容照常进入提示词，写在这里的规则和设定在游玩中一样生效。模型读到的正文不含这两行标记。
- 玩家看到的正文不含标记之间的内容。
- 两行标记是 HTML 注释，在 Markdown 预览里不显示。每个标记独占一行。大小写和空格不敏感（`<!--Narrator-Only-->` 也可以）。一份正文可以有多段。
- 语言版本（`WORLD.<locale>.md`）用同样的写法，各版本在同样的位置标记。
- 拿不准的情况一律按“不给玩家看”处理：
  - 没有结束标记时，从开始标记到文末都不展示。
  - 写错的标记（例如 `<!-- end narrator-only -->`）当作开始标记。
  - 标记行写在代码块里也算标记。
  - `pnpm validate:world` 对这些情况给出 `lore-narrator-only` warning，并指出行号。
- 玩家在开局准备页编辑“世界文档”时，只看到并修改可见部分。标记之间的内容原样保留在这局游戏使用的正文里。
- 应用内的 AI 创建与修改世界处理的是整篇正文，包括标记。

> [!WARNING]
> 这是“不剧透”，不是保密。世界记录、世界包文件和接口返回的 `lore` 都是整篇正文，读文件或调接口的人看得到。需要“条件满足后才揭示”的内容用[隐藏数据](#隐藏数据visibility-hidden)。

### 动态世界维度（dimensions）

维度是世界里“会被记录、可能会变”的一项数据，例如声望、已知地点、城墙状态、倒计时。

- 维度的 ID 由作者自己起，没有固定的种类。`geography`、`factions`、`powerSystem` 只是常见的例子；金钱、声望、图鉴都可以用自己的 ID 和数据结构。
- 世界包里写的是**声明**：结构、初值和更新规则。**当前值**属于会话。同一世界的两局游戏各自演化，不会回写世界包里的初值。

这一节讲怎么声明。维度在一局游戏里怎样被读取和更新，见[动态世界维度](./dynamic-dimensions.md)。

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

| 字段           | 必填 | 说明                                                                   |
| -------------- | ---- | ---------------------------------------------------------------------- |
| `name`         | yes  | 显示名称，可以翻译                                                     |
| `description`  | no   | 含义说明，可以翻译                                                     |
| `schema`       | yes  | 值的结构，用下表列出的 JSON Schema 关键字写                            |
| `initialValue` | yes  | 满足 schema 的初值；`null` 是一个值，不表示删除                        |
| `updateRule`   | no   | 用自然语言写的更新规则，可以翻译；会话语言下非空时，才会每回合自动维护 |

规则：

- ID 必须匹配 `^[a-z][a-zA-Z0-9_-]{0,63}$`，且不能是 `__proto__`、`prototype`、`constructor`。
- 每项声明只接受上表的字段，多写会被拒绝。
- 不需要另一套“表格 / 单值”格式，用 schema 就能表达：
  - 标量是一个单值；
  - 嵌套对象是一组相关的值；
  - 元素为对象的数组是多行记录；
  - `additionalProperties` 是一组可以动态增加、各有名字的记录。
- 玩家可以改值，也可以增删 schema 允许的行。玩家不能在一局游戏里新建维度或改它的结构。

**随时间变化的值**（倒计时、期限、阶段）有两种写法：

- 在字段的 schema 上写 `x-derive`。值由代码按世界时钟算出，不经过模型。见[由时钟推导的字段](./dynamic-dimensions.md#由时钟推导的字段)。
- 不能这样表达、但仍取决于时间的规则，把 `updateRule` 写成时钟的函数。负责维护的模型每回合都能读到结算后的世界时钟和开局以来经过的时间。见[动态世界维度](./dynamic-dimensions.md#冻结读取与维护)。

#### 值校验与本地化

`schema` 支持的是一个明确、封闭的关键字集合，不是完整的 JSON Schema：

| 类别   | 支持的关键字                                                                                |
| ------ | ------------------------------------------------------------------------------------------- |
| 类型   | `type`：`string/number/integer/boolean/null/object/array`，也可用类型数组表示可空等联合类型 |
| 公共   | `title`、`description`、`enum`、`const`                                                     |
| 数值   | `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`                                |
| 文本   | `minLength`、`maxLength`                                                                    |
| 数组   | 单一 `items` schema、`minItems`、`maxItems`                                                 |
| 对象   | `properties`、`required`、`additionalProperties`（boolean 或 schema）                       |
| 本地化 | `x-i18n: true`；`title` 可以翻译；`x-enumLabels` 为标量枚举成员提供显示名                   |
| 推导   | `x-derive`，见[由时钟推导的字段](./dynamic-dimensions.md#由时钟推导的字段)                  |

校验规则：

- 不支持的关键字（包括 `$ref`、远程 schema、表达式与代码）直接拒绝，不会被忽略。
- 初值、玩家修改和自动更新用同一份校验。不做类型转换，也不自动补默认值。
- 大小限制：嵌套深度 32 层，节点数 10,000，序列化后 256 KiB。整张维度表和 schema 本身也受这些限制，不只是单个字段。
- 写进插件数据的单条记录（一个 key 的值）序列化后不得超过 256 KiB。运行期的写入也是这个上限。超出的记录得到 error，整个导入失败，不会被截断。需要更多内容时拆成多条记录。

**翻译。** 主文件写默认语言的文本，译文写在[语言文件](#语言文件namelocaleext)里。

- `name`、`description` 是面板上的标签，按玩家的界面语言显示。
- 值里的文本默认不翻译。只有 schema 明确标了 `x-i18n: true` 的节点可以翻译。
- 这些节点和 `updateRule` 在导入会话时，按会话的内容语言变成普通文字。会话里只存一种语言（见 [Dynamic Dimensions](./dynamic-dimensions.md)）。

例如：

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

`title` 与 `x-enumLabels` 只影响面板显示。值仍是稳定的枚举 ID，模型、规则和校验都使用 ID。`x-enumLabels` 的键必须是该节点 `enum` 中的标量成员：

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

读取到的维度值始终是原始值，翻译只在显示和查询时按上面的标注进行。一个普通的 JSON 值 `{zh: 1, en: 2}` 不会被当成翻译。ID、属性名和枚举成员不翻译。

#### 三种作者入口

三种写法使用相同的声明格式，选一种即可：

1. 在 `world.yaml` 里直接写 `dimensions`。
2. `dimensionSources`：每个维度 ID 指向一个文件（YAML 或 JSON，路径相对世界包根目录），文件内容是**这一项**的声明。
3. 一份维度文件，内容是**整张维度表**。放在 `data/dimensions.yaml` 时按约定读取；用 descriptor 时写 `schema: covel://world/dimensions`、`to: world:metadata.dimensions`，见 [Descriptor](#descriptor)。

```yaml
# world.yaml；data/reputation.yaml 的内容为上例 reputation 下的声明
dimensionSources:
  reputation: data/reputation.yaml
```

几种写法同时存在时：

- `dimensionSources` 的单项覆盖 `world.yaml` 里同 ID 的声明。
- 写向 `world:metadata.dimensions` 的 source 按加载顺序替换整张表。
- 只有最终生效的声明进入会话。被覆盖的那些不会各自初始化一遍。
- 外部文件同样可以有语言文件，路径同样不能跑出世界包。
- 任何一份声明读取或校验失败，这次加载作废，继续使用上一份完整的世界。

#### 初始化、演化与公共读取

对世界作者来说，要知道的是这几点：

- 创建会话时，最终生效的声明和初值被导入会话。不管声明来自哪种写法，也不管世界有没有 descriptor。
- 内置插件 `world-init` 负责初始化和每回合的维护。框架按能力 `world.dimensions@1` 找到负责的插件，不认插件 ID，所以换一个实现也可以。
- 每回合开始，叙事读到的是上一回合结束时的值。叙事结束后，一个模型按 `updateRule` 和本回合正文更新值。没有任何更新规则时，不产生这次模型调用。
- 规则由模型判断，结构和范围由代码校验。这不是按公式结算的引擎。
- 更新整批生效：有一条不合法，整批都不写。没有变化也会留下明确的记录。
- 维护失败、没有运行或发生冲突时，这一回合记为待结算（`pending-settlement`）。下一次叙事之前要重试、人工确认或明确跳过。
- 较大的值不会整份放进提示词。提示词里是有长度预算的摘要，模型需要时用内置工具 `world-dimension-list` / `world-dimension-get` 查询。

读取当前值的三个位置（写插件或提示词模板时用）：

| 位置       | 写法                                |
| ---------- | ----------------------------------- |
| 插件代码   | `ctx.world.dimensions.<id>.value`   |
| 提示词模板 | `{{ world.dimensions.<id>.value }}` |
| 会话快照   | `dimensions.<id>.value`             |

读到的每一项包含名称、说明、schema、值和版本，不包含更新规则和初值。

玩家改值走专门的入口，不走通用的插件数据写入。时序、五种结算状态和读写边界见 [World Model](./world-model.md#动态维度快照)，调用示例见 [API](./api.md#维度编辑与待结算恢复)。

> [!NOTE]
> 角色、背包、好感和时间仍由各自的插件维护，不要在维度里再存一份。维度也不是隐藏剧情的机制：不公开更新规则不等于事件内容保密，隐藏内容请用[隐藏数据](#隐藏数据visibility-hidden)。

> [!IMPORTANT]
> 每个维度都必须写成上面的声明格式。只写一个值（没有 `schema` 和 `initialValue`）的写法不被接受，也没有自动转换。改了格式之后，受影响的开发世界、会话和快照需要重新创建。

### AI 生成结果与文件导出

应用里的“AI 创建世界”和手写的世界包使用同一套格式。这一节说明生成的世界长什么样，以及集成 `@covel/create` 的开发者需要知道的行为。

**生成的内容：**

- 新建只创作一种语言。`defaultLocale` 和唯一的 `supportedLocales` 项都是请求的语言（缺省 `zh-CN`）。模型声称有、但没有真正生成的译本不会被采信。
- `characterSchema` 和其他合法的清单内容保留。
- 补充角色时，按 `characterSchema` 校验整组角色。三次都不合法时放弃这部分，并返回一条 warning。
- 修改已有世界时，校验的是合并后的全部角色。不合法就整包重试，最终失败，不会悄悄删掉已有角色。新建时的“只留一种语言”不会套用到修改上。

**生成的世界包长什么样：** 和手写的一样按[约定路径](#按约定导入没有-descriptor)布局。

- 维度在 `data/dimensions.yaml`，角色在 `characters/characters.json`，资料库与规则在 `data/lorebook.yaml`。
- 设定正文只有一份 `WORLD.md`，用世界自己的语言（`world.yaml` 的 `defaultLocale`）。`WORLD.<locale>.md` 是译文，新世界没有。
- 文件都在约定路径上时不写 descriptor，`world.yaml` 里也没有 `worldData`。

**插件内容**由创作简报的 `contracts` 指定：

- 生成器只为被选中的数据契约生成记录。每个契约的 schema、写作提示和示例取自接收插件的 `authoring` 声明（需声明 `generate`）。接收插件会被加入 `pluginPolicy.requested`。
- 未选中的契约不会进入提示词。模型为未选中的契约输出了记录，或漏掉了被选中的契约，这次尝试都算失败并重试。
- 一个契约的记录写进接收插件声明的文件（`authoring.source` 的 `path` 与 `kind`，例如 `data/memory-blocks.json`、`data/time.yaml`）。一条记录就是文件内容，多条写成数组。
- 下面两种情况，记录改写成 `data/contract-<n>.json`，并由 `data/world.data.yaml` 这个 descriptor 列出全部 source：
  - 接收插件没有声明路径；
  - 声明的路径不能当作约定：已安装的插件里另有契约声明了同一个路径。
- 接收方声明了 lorebook 投影时，目标写成 `contract:<id>+lorebook`。

**`@covel/create` 的接口：**

- `createWorld({ llm, concept, ... })` 生成并校验内容。成功时返回 `id`、`manifest`、`lore`、`locale`、`packageContent` 与 `warnings`；失败时返回 `success: false` 和 `errors`。`warnings` 包括数量低于简报目标的内容和被丢弃的无效维度。
- 返回的 `manifest` 已经过 schema 校验并规范化，包含 locale 的规范写法和 `characterSchema.types` 等默认值。三种保存目标使用同一份结果。
- 生成过程不写文件，也不接收 `outputDir`。生成的清单必须把数据写在清单里，不能引用还没生成的 `worldData` 或 `dimensionSources` 文件。
- 简报生成的 `memoryDefinitions` 会转换成 `packageContent.contractData` 里的 `memory.blocks@1/world` 记录。写文件和不写文件两种模式用同一份数据，同一目标重复声明会被拒绝。
- 需要文件包时显式调用 `await writeWorldPackage(outputDir, result, { dataContracts })`。它返回写出的相对路径，在一份独立的副本里把清单里的数据转换成文件引用，原生成结果不变。已有同名包会被拒绝；并发写同一个包只有一个成功。

**没有文件夹的世界。** 保存在服务端数据库（`server-store`）或浏览器本地的世界没有可以长期读取的包目录。这时：

- 通用角色放进 `WorldRecord.metadata.embeddedCharacters`，资料库与规则放进 `WorldRecord.metadata.embeddedLorebook`。
- 创建会话时，只有没有导入文件形式的世界数据，才使用这份内容。所以同一个世界不会导入两遍。
- 这种形式只装文本。图片仍然需要 media source、真实文件和内容寻址的索引。

> [!NOTE]
> 生成器写出的世界包根目录里有一个 `.covel-generated.json`。它列出应用写进包里的每个文件，世界记录也因此带上 `metadata.generated: true`。包里只有这些文件、内容也没有改过时，应用可以按玩家的要求把它整包重写（`POST /api/ai/revise-world`）。你手工加入立绘或其他文件，或者改过生成的文件之后，“修改这个世界”会拒绝重写，并列出这些文件，包保持原样。这时请直接编辑包里的文件。想再用“修改这个世界”，先把这些改动撤销。

### 内置示例世界

世界包不必用上所有能力，让题材决定插件组合和数据。仓库里的四个世界展示了不同的组合：

| 示例                    | 玩家体验                                    | 主要能力                                                                                                                                                                                                                                                  | 适合参考的文件                                                                                                                     |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `worlds/mistport`       | 黑暗奇幻调查，面向重剧情玩家                | `mistport-investigation` 组合；演化维度「案情板 / 四方立场 / 深退潮 / 钥匙碎片」；`visibility: hidden` 的隐藏事件（`story-events`）；按语言选择的世界观、角色、规则与 presence；角色属性 schema、立绘、潮汐与势力规则                                     | `world.yaml`、`WORLD.md` / `WORLD.en-US.md`、`data/dimensions.yaml`、`data/rules/`、`characters/`、`media/`                        |
| `worlds/haruka-academy` | 校园群像恋爱（GalGame），对话与视觉小说舞台 | `haruka-galgame` 组合（舞台、多回复、好感）；`defaultViewMode: stage`；好感种子与演化维度「心之路线 / 学园祭筹备 / 文艺部存续审查 / 约定 / 校园传闻」；隐藏个人线事件及其后续；透明立绘与日 / 夜场景注册表                                                | `world.yaml`、`WORLD.md`、`data/dimensions.yaml`、`data/affinity.yaml`、`data/rules/`、`characters/`、`media/scenes.registry.json` |
| `worlds/emberback`      | 英文科幻救援，RPG 资源与任务推进            | `emberback-rescue` 组合；骰子判定、任务、物品与好感种子；演化维度「Crownfire Countdown / Relay Grid / Signal Log / Medical Convoy」；隐藏事件及事件链                                                                                                     | `data/dimensions.yaml`、`data/quests.yaml`、`data/items.yaml`、`data/affinity.yaml`、`characters/`                                 |
| `worlds/lantern-barrow` | 经典跑团地城探索（中英双语）                | `classic-tabletop` 组合；`tabletop-rules` 开局配点（`contract:tabletop-rules.rules.initial@1`）与表单检定、`dice-check` 骰池；任务 / 物品 / 好感的 `.en-US` 变体；演化维度「古冢地图 / 古冢警戒 / 古冢之灯 / 名望」；隐藏遭遇及事件链（含 `.en-US` 变体） | `world.yaml`、`WORLD.md` / `WORLD.en-US.md`、`data/tabletop-rules.json`、`data/*.en-US.yaml`、`characters/*.en-US.json`            |

- 雾港、遥风学园与提灯古冢用 `data/world.data.yaml` 列出 source。Emberback 没有 descriptor，按约定路径读取。两种写法效果相同。
- 四个世界都启用 `story-events`。雾港、Emberback 与提灯古冢另外以 `pluginSettings.story-events.planner: true` 开启剧情策划：在作者预设的隐藏事件之外，它会根据游玩中留下的线索，追加只触发一次的后续事件。遥风学园的恋爱路线由作者逐条编排，不开启剧情策划。
- 做新世界时，先复制玩法最接近的那个世界的结构，再按后文各节增减角色、规则或媒体。

### 展示用字段

这些字段只影响世界怎样显示，都可以省略。

- `defaultViewMode`：会话第一次进入游玩时的默认呈现方式，写 `stage`（全屏舞台模式，见 [ui-panels.md](./ui-panels.md#舞台模式stage-view)）或 `parsed`。它只是初始值，玩家在页面顶部切换视图之后以玩家的选择为准。
- `version`、`author`、`license`、`homepage`：世界包的版本和作者信息。字段、限制和翻译规则与插件相同，见[作者信息](./plugins.md#作者信息)。它们只显示在世界卡片上，不进入会话数据和提示词。
- `cover`、`accentColor`、`themeMusic`：封面、强调色和世界列表上的音乐，见 [Background Music](#background-music) 一节末尾。

### 插件选择（`pluginPolicy`）

`pluginPolicy` 说的是“这个世界希望用哪些插件”。它不会锁死任何插件：最终启用哪些，由 Covel 根据每个插件声明的能力和依赖、玩家的授权以及玩家自己的勾选算出来。

| 字段                            | 说明                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `presetId`                      | 默认组合包 ID，可引用 `packs[].id` 或内置组合包                                         |
| `preferredTags` / `avoidedTags` | 插件标签偏好                                                                            |
| `requires`                      | 世界必需的契约 ID（如 `action-check@1`），任何提供该契约的已安装插件都能满足            |
| `requested`                     | 世界建议作为初始选择的插件 ID                                                           |
| `recommended`                   | 额外推荐插件 ID                                                                         |
| `packs`                         | 自定义组合包，每项包含 `id/label`，可选 `description/requested/recommended/tags/reason` |

`presetId` 必须是内置组合包或这个世界 `packs` 里的 ID，否则 `pnpm validate:world` 报 `unknown-preset`。

`requires` 表达“这个世界离不开什么能力”。这里写契约（一种能力的名字加版本），不写插件：

```yaml
pluginPolicy:
  requires:
    - action-check@1 # 行动判定；内置的 dice-check 提供它，换一个判定插件也可以
  requested:
    - dice-check # 可选：初始选择，同时在有多个提供者时指定用哪一个
```

- 只有一个已安装的插件提供它时，这个插件自动启用。
- 没有提供者，或者有多个而世界与玩家都没有选定：准备页说明原因，并禁用开始。
- 玩家仍然可以主动关掉提供者。这是玩家的选择，会话照常开始，准备页给出提示。
- `requires` 只接受 `名字@版本` 形式的契约 ID。写成插件 ID 会在加载世界时报错。

`requested` 写的是插件 ID，玩家的电脑上不一定装了它：

- `GET /api/worlds/:id/plugin-plan` 会把没安装的 ID 从世界策略和各组合包的 `requested` 中去掉，改列在 `missing`（来自组合包的带 `packId`）。
- 准备页据此提示缺少哪些插件。会话仍然可以创建，只是这些插件提供的玩法不会生效。
- `recommended` 不参与默认选择，原样返回。

### 启动加载与收敛（seed & reconcile）

服务器启动时，把世界目录里的每个世界包写进数据库。这一步叫 seed。

**读取顺序：**

1. 内置目录：`COVEL_WORLDS_DIR`，从源码运行时默认是仓库的 `worlds/`。
2. 用户目录：`COVEL_USER_WORLDS_DIR`；没设时是 `$COVEL_HOME/worlds`；`COVEL_HOME` 也没设时是 `~/.covel/worlds`。桌面版使用 `<data_root>/worlds`。

seed 可以重复执行：每个世界包对应一条世界记录，有就更新，没有就新增，并标上 `metadata.source = "file"`。seed 本身从不删除。

**清理（reconcile）。** 只新增不删除会留下一个问题：一个曾经内置、后来从包里移除的世界，会一直留在老用户的数据库里。所以所有目录 seed 完之后，会删除“已经不在任何世界目录里”的旧记录。三条保护保证只清理这种记录，不误删用户数据：

1. **只看来源**：只有 `metadata.source === "file"` 的世界可以被清理。AI 生成的世界（`generated` / `generated-file`）和其他任何来源的世界永远不碰，即使它不在当前的世界目录里。
2. **有存档就保留**：旧世界仍有会话时保留不删，并在日志里写一条 `warn`。删除带存档的世界必须由人明确操作。
3. **扫描不完整就不清理**：任何一个世界目录无法扫描，任何一个世界包读取、解析或校验失败，或者这次一个世界都没加载成功，就整体跳过清理。健康的世界照常更新。

用户世界目录尚不存在时，按空目录处理；内置世界仍会刷新。其他目录读取错误仍视为扫描不完整。

> [!NOTE]
> 想清掉一个**仍有存档**的内置世界，需要明确地删除它的世界记录和关联的会话。

**多个目录有同一个 ID 时：**

- 后面的目录优先（用户目录优先于内置目录）。被盖住的那个包不会改写世界记录，也不会通知会话。
- 同一个目录里出现重复的 ID 会报错，这些包不写入数据库。
- 优先的那个包清单或维度加载不完整时，保留已有记录并跳过清理，不会拿被盖住的包顶替。
- 查找世界只看目录的直接子文件夹。清单是符号链接的包会被拒绝，隐藏的临时目录会被忽略。
- 文件夹的名字不必和 `id` 相同。创建会话、预检和数据同步都按清单里的 `id` 找世界包。

**浏览器本地存储。** 用浏览器私有存储时，世界保存在浏览器里：

- 第一次初始化空库时，从 `GET /api/worlds` 导入完整目录，保留清单 ID、世界观、维度、角色与包信息。
- 目录请求失败时不算初始化完成，可以重试。成功拿到一个空目录也是有效结果。
- 初始化之后，浏览器里的世界只由本地的编辑和删除管理。之后启动不再请求目录，也不会自动覆盖，可以离线读取。已有的本地世界不会被初始化覆盖。
- 服务端目录之后的变化不会自动更新这些副本。

### 文件更新与安装

**安装到哪里。** 安装的世界包和 AI 生成并保存为文件的世界，都写进用户世界目录，不会改动内置目录。

- 安装成功后世界立刻出现在世界列表里，不需要重启（接口返回 `restartRequired: false`）。
- 激活失败只移除这次新建的文件夹，可以重试。
- ZIP 安装会先校验世界数据。有 error 级别的问题（descriptor 或 source 缺失、文件无法解析、数据不符合它自带的 schema）时返回 400，不创建世界记录，并移除这次新建的文件夹。修好之后可以用同一个 ID 重试。warning 不阻止安装。
- 这次校验只读包里的数据。它不会让本机的 override 掩盖包里的错误，也不执行社区代码。
- 启动时的 seed 不受这条影响：世界数据有错的包，按原来的宽容方式加载。

从 GitHub 安装和更新见[世界目录与安装](./world-installation.md)。

**改文件后自动重载。** 服务器监听内置和用户世界目录（包括 Linux）。

- 世界包里的文件变化后，等 500 毫秒把连续的改动合并，再重新读取。图片、音频和编辑器临时文件的变化不触发重读。`world.yaml`、`WORLD.md`、各语言版本、`data/`、`characters/`、`media/*.json` 等都会触发。
- 读取后按清单的 `id` 找到世界。有任何差异就更新世界记录，并在日志里写出重载了什么：设定正文、名称与简介、维度、插件策略与设置、世界数据与设置。
- 清单或正文读不出来时记录 warning，已加载的版本继续使用。
- 在应用里被玩家编辑过的世界（`packageModified`）保留编辑后的副本，文件改动不覆盖它。
- 重载不会改变世界的来源和创建时间。AI 生成的世界不会因为重新加载而变成不能删除的内置世界。

**重载影响谁：**

| 对象           | 结果                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 新建的会话     | 读取最新的世界包                                                                                                                           |
| 已有会话的正文 | 下一回合读到新的设定正文；会话自带 `loreOverride` 时仍用它                                                                                 |
| 已有会话的数据 | 角色、资料库条目、维度值和已经发生的状态不会被自动改写。玩家想用新的开局数据，需要新开会话；作者和工具可调用[同步接口](#preflight-与-sync) |

- 维度声明变化时，使用这个世界的会话会收到 `world.dimensions.changed`。这只是通知：会话里已经演化的值不会被重置成新初值。作者和工具需要调用同步接口，才能尝试更新会话的声明；冲突的维度仍保留原样。
- 这不是整包热更新。直接往目录里放一个**新的**世界文件夹，需要重启或走安装入口才会出现。插件安装后也仍需重启服务。
- 文件系统不支持监听时，启动时记录一条 warning。维度还可以通过 `POST /api/worlds/:id/dimensions/import` 导入。
- 实现见 `apps/server/src/world-file-watcher.ts`，安装响应见 [API 参考](./api.md#installed-resource-storage-and-vector-configuration)。

**维度文件必须全部读得出来。** `dimensionSources` 和写向 `world:metadata.dimensions` 的 worldData source 遵循同一规则。 任何一个文件缺失、不可读、YAML 写错或校验失败，整个世界这次加载失败。此时保留上一份完整的记录，不发维度变更通知，也不做旧世界清理。修好文件后会继续自动重载。

**删除 AI 生成并保存为文件的世界（`generated-file`）：**

- 先在已配置的世界目录里核对 `metadata.storage.path`，再按清单 ID 找到那个目录里唯一的世界包。旧记录没有存储位置时，必须在所有目录里只匹配到一个。
- 位置失效、包不见了或有多个候选时，返回 `409 world_package_unresolved`，文件和数据库记录都不删。不会转而去删其他目录里的同名包。
- 删除时先把包移进同一目录下的临时位置，再删数据库记录。数据库失败时把文件夹移回去，可以重试。
- 成功之后清理临时文件失败只记日志，那个临时位置不会被当成世界重新加载。
- 这只保证进程内出错时能恢复。进程在两步之间崩溃时，不保证文件和数据库一致。

**编辑世界记录时不变的东西：**

- 世界的 `metadata.source` 和 `metadata.storage` 在普通的修改请求（PATCH）里保持原值，编辑或浏览器同步不会改变文件归属。
- 维度以 `metadata.dimensions` 为准，顶层的 `dimensions` 是同一份内容的读取入口。只提供顶层维度时写入 `metadata.dimensions`；替换或清空 `metadata.dimensions` 时顶层同步更新。三种数据库后端行为相同。

### 插件配置默认值（`pluginSettings`）

`world.yaml` 顶层（与 `pluginPolicy` 平级）可以写 `pluginSettings`，为插件的设置项预置**这个世界的默认值**。写法是 `插件 ID → 设置项 → 值`：

```yaml
pluginSettings:
  story-events:
    planner: true
  chat-mode-narrator:
    dialogueRatio: 70
```

一个设置项的取值按这个顺序决定，前面的优先：

1. 玩家在设置里改的值；
2. 世界的 `pluginSettings`；
3. 插件自己声明的默认值（`contributes.settings[].default`）。

- 玩家仍然可以覆盖每个值。
- 写了插件没有声明的设置项不会出错，只是没有作用；`pnpm validate:world` 会给出 `unknown-setting` 提醒。值的类型、范围或选项不对时报 `invalid-setting` 错误。
- `pluginSettings` 只设默认值，不决定启用哪些插件。启用哪些由 [`pluginPolicy`](#插件选择pluginpolicy) 决定。

给插件作者：加载后它保存在 `WorldRecord.metadata.pluginSettings`。每个回合开始时，它与玩家的值（请求头 `X-Plugin-User-Settings`）合并，放进 `TurnInput.userSettings`，agent 的 `{{ userSettings.* }}`、guard 和 hook 读到的是同一份。

### 世界记忆定义（`memory.blocks@1`）

记忆定义告诉 `memory` 插件：这个世界要长期记住哪几类东西，例如线索、承诺。它和其他插件数据一样导入。`data/memory-blocks.json` 是**一个对象**，`id` 固定为 `world`，不是一个数组：

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

文件放在 `data/memory-blocks.json` 时按约定读取。用 descriptor 时这样写：

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

- `label` 必须符合 `^[a-z][a-z0-9_]*$`。
- `displayName`、`extractionHint` 可以按语言分别写；`maxChars` 是正整数。
- 定义按这个顺序加载：插件固定的基础定义，然后是其他启用插件提供的定义（`memory.block-definitions@1` 服务），最后是世界的定义。一个 `label` 已经被占用时，保留先加载的那个。
- 对象导入 `memory` 插件自己的 `definitions/world` 记录。记忆的内容保存在该插件的 `blocks` 里，并由它放进提示词。`world.yaml` 里没有记忆定义的专用字段。
- 四个内置世界都用这个文件。

## 按约定导入（没有 descriptor）

`world.yaml` 没有 `worldData` 字段时，世界包按约定读取：约定路径上有文件（媒体则是目录），它就是一个 source。效果和在 descriptor 里写出同一条完全相同。

约定来自两处：

- **内核**：
  - `data/dimensions.yaml` → 维度（`world:metadata.dimensions`）
  - `data/lorebook.yaml` → 资料库（`lorebook`）
  - `characters/characters.json` → 角色（`characters`）
- **插件**：每个数据契约在 `contributes.data.<ns>.authoring.source` 里声明的 `kind` / `path` / `key`。`pnpm describe:authoring` 把它们全部列出来，例如：

```text
### Starting quests — `quests@1` (plugin `core-quest`)

Importable quest records — world packs may preseed main/side quests; the quest log advances them by name.

How to write it: Seed the main quest and, at most, a few side quests. `status` is `active`, `completed` or `failed`. Each objective has `text` and `done`; give it an `id` so later updates can address it. The quest log advances quests by name, so use the quest and giver names that the lore uses.

Put the file at `data/quests.yaml`: it is imported without a descriptor. The same source in a descriptor:

    quests:
      kind: yaml
      path: data/quests.yaml
      schema: contract:quests@1
      to: contract:quests@1
      key: id
```

规则：

- 导入顺序是：维度，然后媒体，然后其余契约数据，最后是 `characters`。
- 内置世界 `worlds/emberback` 就是这样读的：它没有 descriptor，13 个 source 全部来自约定路径。
- 没有 descriptor 时，按这个会话**启用**的插件的约定读取。没启用的插件和加载失败的插件不影响读取。有 descriptor 时，只读取它列出的 source。
- 同一个会话启用的两个契约声明了同一个路径时，这个路径不算约定，这个文件不导入，世界包要用 descriptor 说明给谁。会话照常开始。服务端日志记一条 `[sessions]` 警告，世界数据预检返回一条 `convention-collision` 警告，`pnpm validate:world` 也会报出来（见[静态校验](#静态校验pnpm-validateworld)）。

给插件作者：`path` 是相对世界包根目录的路径，只能由 ASCII 字母、数字和 `_`、`.`、`/`、`-` 组成，不能以 `/` 开头，也不能含 `..`。它也不能是内核或世界包自己的路径：`world.yaml`、`WORLD.md`、`data/world.data.yaml`、`data/dimensions.yaml`、`data/lorebook.yaml`、`characters/characters.json`、`media/gallery.json`、`media/portraits.json`、`media/scenes.json`、`media/gallery/` 目录，以及它们的语言版本（如 `world.zh-CN.yaml`），比较时不分大小写。不符合的插件清单在加载时校验失败。

**什么时候仍然写 descriptor：**

- 文件不在约定路径上，比如规则文件叫 `data/rules/tide-mystery.yaml`，或者想用中文文件名；
- 一个契约有多个文件；
- 需要用 `after` 指定顺序；
- 要关掉某个 source。

> [!IMPORTANT]
> 写了 `worldData` 之后只认 descriptor，约定不再生效。descriptor 要把所有 source 列全。

**没被用到的文件。** `pnpm validate:world` 会检查 `data/`、`characters/`、`media/`（包括子目录）里有没有哪个文件没被任何 source 或框架功能用到，有就给出 `data-file-unused` 提醒。两种导入方式都检查。已有 source 的语言文件、本地 schema、维度文件、主题音乐和画廊图片不会被误报；README 是作者说明，也不参与检查。

## Descriptor

descriptor 是一个 YAML 文件，通常叫 `data/world.data.yaml`，用 `sources` 列出每份数据：

```yaml
schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    to: world:metadata.dimensions

  cast:
    kind: json
    path: characters/main-cast.json
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

每个 source 最常用的字段：

| 字段     | 说明                                                  |
| -------- | ----------------------------------------------------- |
| `kind`   | 文件类型：`yaml`、`json`、`markdown`、`text`、`media` |
| `path`   | 文件或目录，相对世界包根目录                          |
| `to`     | 数据去哪里，见 [Target URI](#target-uri)              |
| `key`    | 每条记录里用作唯一标识的字段，通常是 `id`             |
| `after`  | 要排在哪个 source 之后导入                            |
| `schema` | 用什么校验，通常可以省略（见下）                      |

逐字段说明见生成的 [World data descriptor 字段表](./schema/world-data-descriptor.md)。

- source 的名字（`sources` 下的键）必须匹配 `^[a-z][a-zA-Z0-9_-]{0,63}$`。
- descriptor 顶层目前只接受 `schemaVersion: 1` 和 `sources`。

**`schema` 什么时候写：**

- 目标是 `contract:<id>`（含 `+lorebook`）时，按该契约的 schema 校验，可以不写。
- 目标是 `world:metadata.dimensions` 时，按维度 schema 校验，可以不写。
- 只有想用世界包里的 JSON Schema 文件校验时才需要写。
- 省略时，如果没有任何插件为该契约声明 schema，这个 source 不做校验。明确写了 `schema: contract:<id>` 却找不到 schema，则是错误。

**媒体 source** 要同时写 `key: filename` 和 `indexTo: contract:<contractId>`：

- 缺 `key` 是 error。
- 缺 `indexTo` 时没有地方记录“有哪些图”，这些文件不会被导入。
- 接收图片索引的插件没有启用时，这个 source 的文件同样不导入。这时是 warning，不影响其他数据。之后在游戏里启用接收插件，它的数据会自动导入一次（见[开局后加入的接收插件](#开局后加入的接收插件)）。

### 会话之外可见的图片

世界包的图片在创建会话之前就能被玩家看到：世界列表和世界详情通过 `GET /api/worlds/:id/gallery` 直接从世界包读取。

- 世界包有 `media/gallery.json` 时，展示清单里的图片和介绍，只到 `spoilerLevel: opening` 这一级。
- 没有时，展示公开的 `kind: media` source 里的图片。`enabled: false` 和 `visibility: hidden` 的 source 不在其中。

接口和展示规则见 [api.md](./api.md) 与[世界美术方向](../worlds/art-direction.md#画廊资料与前端使用)。

### 隐藏数据（`visibility: hidden`）

source 默认是公开的。写了 `visibility: hidden` 的 source 用来放“条件满足前不能被知道”的内容，例如隐藏剧情。

- 它只能交给插件（`to: contract:<contractId>`）。
- 导入后放在接收插件一块专门的隐藏区域 `_hidden.<namespace>` 里。例如 `story-events` 的 `events` 对应 `_hidden.events`。

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

框架保证隐藏数据不会从这些出口漏出去：

| 出口            | 处理                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提示词          | `io.selfData` 注入隐藏命名空间时直接报错；扩展点（`prompt.segment@1`、`ui.slot@1`、`session.world-context@1`）的 `ctx.pluginData` 读不到隐藏数据                |
| 模型工具        | 内置 `plugin-data-get` / `plugin-data-list` 不返回隐藏命名空间                                                                                                  |
| 玩家可见接口    | 插件数据 API、`/state` 数据面板与 discovery 不列出，单条读取返回 404；快照读取接口（`GET` / `POST /snapshots`）的响应同样去掉隐藏命名空间，存储中的快照保持完整 |
| lorebook 与投影 | 不允许 `+lorebook`；`worldProjections` 跳过隐藏 source                                                                                                          |
| 其他目标        | `characters`、`lorebook`、`world:metadata.*`、media 与 `indexTo` 都会被拒绝                                                                                     |
| 写入            | REST 与内置 `plugin-data-set` 工具不能写；只有所属插件自己的代码（function runtime、插件本地工具）能写自己的 `_hidden.*`                                        |

只有接收插件自己的代码能读隐藏数据。插件决定揭示时：

- 在这一回合把内容交给需要它的一方（通常是叙事）；
- 在公开的数据里留下一条不含原文的揭示记录。

内置的 [`story-events`](./plugins.md) 就是这样做的。揭示之后，内容会作为叙事这一回合的输入，出现在叙事的执行详情里。

> [!WARNING]
> 隐藏的意义是“不剧透”，不是加密。世界包文件就在玩家本地；浏览器本地模式为了能运行，保存的进度里也包含这些数据。不要把真正需要保密的信息写进世界包。

#### 剧情中追加的隐藏内容

隐藏内容也可以在游玩中产生。一个 runtime 发布带契约的输出，接收插件校验后写进自己的 `_hidden.<namespace>`。

处理这些内容的 runtime 要声明 `io.concealed: true`。这样它的提示词、工具参数、结果与输出不会进入 trace、实时流、`/view`、`/turns` 或手动 RPC 的返回。

内置的链路：

1. `story-events/plot`（agent，post-turn，每 3 回合一次，设置项 `planner` 开启时运行）读取这些内容：世界简介、主角、本回合叙事、可选的本回合 WorldIR 抽取、维度值、世界时间，以及 `evaluate` 公开的账本。账本里是已发生事件与已埋下事件的 ID 和标题，不含世界作者尚未发生的事件。然后它调用 `plan-story-events` 发布 `story-event.plan@1`。
2. `story-events/intake`（function，post-turn）校验每份计划：
   - 事件的结构是否正确；
   - 引用的维度、时间字段和事件是否存在；
   - 不能覆盖世界作者的事件或已发生的事件；
   - 同时等待的计划事件最多 8 个。

   通过的事件写入 `_hidden.planned`，只触发一次。

3. `story-events/evaluate` 每回合同时评估 `_hidden.events` 与 `_hidden.planned`，条件满足时照常交给叙事。

计划事件和作者事件放在不同的隐藏区域，所以同步世界数据不会覆盖计划事件。

### 语言文件（`<name>.<locale>.<ext>`）

**主文件只写一种语言**，即 `world.yaml` 的 `defaultLocale`。其他语言放在主文件旁边的 `<name>.<locale>.<ext>` 里，只写译文，不重复结构。

```text
world.yaml                     # 主文件，defaultLocale 的文本
world.en-US.yaml               # 只有英文译文
data/dimensions.yaml
data/dimensions.en-US.yaml
characters/main-cast.json
characters/main-cast.en-US.json
WORLD.md
WORLD.en-US.md                 # 正文类文件没有可对齐的 id，整份替换
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

**文件名：**

- `<locale>` 要写成 `supportedLocales` 里的完整写法。世界声明了 `en-US`，文件就叫 `….en-US.…`。世界声明的就是 `fr` 时，`….fr.…` 才是准确的名字。
- 只写语言的 `….en.…` 不会被读取，也不会按“会话是 `en-US` 就读 `en`”来猜。
  - `pnpm validate:world` 报 `locale-file-name` 错误，并给出应改成的文件名。
  - 服务端加载时在日志里写出文件名和应有的名字。
  - 安装或导入社区世界时以 400 拒绝，并给出同一条说明。
- `<locale>` 必须是真实语言的标签（`en-US`、`zh-Hant`）。`items.backup.yaml` 不会被当成语言文件。
- 会话语言之间的回退不受影响。例如 `zh-TW` 的会话读 `zh-CN` 版本，这是在世界实际有的版本之间选择。

**译文怎样对上主文件：**

- 对象按 key 对齐。
- 对象列表先按 source 的 `key` 对齐，再按 `id`。source 可以用 `localeArrayKeys` 额外声明嵌套列表里的稳定字段（如 `localeArrayKeys: [label]`）。每个列表采用“所有元素都有”的第一个字段；译文必须保留它。这样在主文件里插入、删除或调整顺序，都不会让译文对错位置。没有这些字段时按位置对齐。
- 用来对齐的字段不翻译，即使它是中文或看起来像展示文本。翻译工具也不会提取它。其他位置的同名字段仍然可以翻译。
- 语言文件只能翻译主文件里已有的文本。出现主文件没有的 key 或 id、在不是文本的位置写文本、改动数字或布尔值，这一条会被忽略并报告，主文件的值保留。
- 没翻译的文本回退到主文件，所以可以逐步翻译。
- 语言文件里只放对齐用的字段和译文。不要复制媒体哈希、路径这些会变化的内容。
- 纯文本列表（例如别名）整列翻译：语言文件里的列表替换主文件的列表，某一项写 `null` 表示沿用主文件。

**三类文件的读取方式：**

| 文件                                                                                           | 读取方式                                                     | 结果                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `world.yaml`、维度定义（`dimensionSources` 的文件、`to: world:metadata.dimensions` 的 source） | 所有语言文件一起读                                           | 文本带着所有语言，世界目录和面板标签按界面语言显示 |
| 其他结构化 source（JSON / YAML）                                                               | 只合并会话语言的那一份：文件名里的 locale 与会话语言完全一致 | 单一语言的数据；会话里不保存多语言                 |
| `markdown` / `text` / `media`                                                                  | 语言文件整份替换主文件                                       | 同上                                               |

其他规则：

- 会话语言在创建时确定，并且一定是世界声明的版本。文件名与它逐字对应：`zh-Hant-TW` 不会读取 `zh` 的文件。
- 语言文件是 source 的一部分。改动任何一份都算这个 source 变了，[同步](#preflight-与-sync)能看到。
- 主文件里不能把文本写成多语言对照（`name: { zh-CN: …, en-US: … }`）。`pnpm validate:world` 把它报为 `inline-locale-map` 错误。这样写的世界包要拆成主文件加语言文件。
- 维度值里只有 schema 标了 `x-i18n: true` 的文本节点可以翻译。翻译其他节点会让该维度校验失败。

给插件作者：合并规则是 `@covel/shared` 的 `applyLocaleOverlay`。`importWorldDataForSession` / `syncWorldDataForSession` / `preflightWorldDataForSession` 的 `locale` 选项原样传入，缺省时取 `session.locale`。

## Target URI

`to` 说明数据去哪里。当前支持：

| URI                              | 什么时候导入 | 说明                                                                            |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `world:metadata.<path>`          | 加载世界时   | 写入世界记录的 `metadata` 子路径；目前只有 `world:metadata.dimensions` 真正生效 |
| `contract:<contractId>`          | 创建会话时   | 交给所有启用的、声明接收这个契约的插件                                          |
| `contract:<contractId>+lorebook` | 创建会话时   | 同上，并同时在会话的资料库里生成一条条目                                        |
| `lorebook`                       | 创建会话时   | 直接写入会话的资料库                                                            |
| `characters`                     | 创建会话时   | 把通用角色记录写入会话                                                          |
| `media` + `indexTo`              | 创建会话时   | 导入媒体文件，并把索引交给 `indexTo` 的插件                                     |

- 媒体 source 用 `to: media` 加契约形式的 `indexTo`。结构化 source 不能把 `to` 写成 `media`。这类组合错误在校验时被拒绝。
- `world:metadata.<path>` 的路径里不能有 `__proto__` 这类危险的段。`dimensions` 以外的路径目前只被记录下来，不产生效果。
- 世界数据在创建会话时导入。作者和工具可通过 [`sync-data`](#preflight-与-sync) 更新已有会话；先调用 `preflight` 可以在写入之前看到诊断。应用没有供玩家操作的同步入口。
- 创建会话的响应在 `worldDataNotices` 里列出没有导入的数据（warning 和 error，例如没有启用的接收插件），游戏界面把它们显示给玩家。

### 开局后加入的接收插件

创建会话时没有启用的插件收不到世界数据，例如开局后才批准的社区插件。在游戏里启用插件（`PUT /api/sessions/:id/plugins/:pluginId`）时，Covel 为这次新加入的插件补跑一次导入：

- 只写新加入、并且导入账本里还没有这个世界记录的插件的数据。其他插件的数据和账本不动；同一个插件关掉再打开，不会覆盖游戏改过的数据。
- 社区插件的投影代码只在它获得这局游戏的授权后运行。
- 响应的 `worldData` 写明哪些插件收到了数据、写了多少条，以及按现在的插件还缺哪些数据（`notices`）。游戏界面用它替换之前的提示。
- 导入失败时插件仍然启用，`notices` 里给出 error。

### Lorebook 按玩家消息选择性注入

资料库（lorebook）适合放大量设定：一条条目只在玩家提到相关关键词时才进入提示词，不会每回合都占位置。

文件放在 `data/lorebook.yaml` 时按约定读取。世界用了 descriptor 时这样写：

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

条目的字段：

| 字段              | 说明                                                                              |
| ----------------- | --------------------------------------------------------------------------------- |
| `id`              | 条目的 ID                                                                         |
| `content`         | 正文，必填，不能为空                                                              |
| `strategy`        | `constant`（每回合都注入）或 `selective`（命中关键词才注入）。省略时是 `constant` |
| `kind`            | 另一种写法：`constant` 或 `triggered`（等同 `selective`）                         |
| `keys`            | 关键词列表。`selective` 条目必须有非空的 `keys`                                   |
| `position`        | 插入位置，默认 `after_plugin`                                                     |
| `insertionOrder`  | 排序用的数字，默认 100                                                            |
| `enabled`         | 默认 `true`                                                                       |
| `extra.scanDepth` | 除了当前这条玩家消息，还往前看几条已提交的对话（含已压缩的消息）。0 到 20，默认 0 |

匹配规则：

- `selective` 条目检查当前玩家消息，以及 `extra.scanDepth` 指定的最近几条对话。
- 拉丁字母的关键词按整词匹配，并接受复数和所有格词尾：`lantern` 也匹配 `lanterns`、`lantern's`，不匹配 `lanternfish`。
- 中日韩文字的关键词按子串匹配。
- 大小写不敏感。
- `selective` 条目缺少 `keys` 时，静态校验和导入预检都会拒绝。

其他：

- 从世界包导入的条目归“世界”所有。一条条目由“会话、所有者、ID”三项共同确定，所以它不会覆盖玩家或插件创建的同 ID 条目。
- `PLUGIN.md` 里的 Markdown 链接不会让 Covel 去加载文件。`references/*.md` 和其中自定义的 `keywords` 不是插件运行时的一部分。

### Contract 解析与预检

`contract:<contractId>` 可以出现在三个位置：`schema`、`to` 和媒体的 `indexTo`。

- 契约 ID 匹配 `^[a-z][a-z0-9.-]*@[1-9][0-9]*$`，例如 `character.blueprints@1`。
- `+lorebook` 只能用在 `to` 上。它额外生成一条归世界所有的资料库条目；有多个接收插件时也只生成一条。

**怎样找到 schema 和接收方：**

- `schema` 从已注册插件根目录的 `contracts.<id>.schema` 找，文件在那个插件的目录里。
- `to` 匹配插件根目录的 `contributes.data.<namespace>.accepts`，按固定顺序写给每个启用的接收方。
- 两者是分开的两道检查：数据先通过来源的 schema，再通过每个接收方自己的 schema。

**结果：**

| 情况                                            | 结果                                                |
| ----------------------------------------------- | --------------------------------------------------- |
| 没有任何已注册的插件接收这个契约                | error，这是作者的错误                               |
| 有插件接收，但这局游戏里都没启用                | warning，只跳过这个契约的写入，其他 source 照常处理 |
| 有多个启用的接收方                              | 每个都收到一份；数据不绑定某个具体的插件 ID         |
| 缺 schema、路径跑出世界包、文件读不了、值不合法 | error，阻止导入                                     |

内置的和世界包本地的 schema 在加载世界时校验。契约的 schema 要知道装了哪些插件，所以在创建会话或预检时校验。

ZIP 安装与 AI 文件写回共用包预检，不读取本地覆盖。生成、修订和翻译先检查暂存副本，再发布；失败时保留原包。它不要求接收插件已启用，也不代替会话的契约预检。

## WorldIR 与插件投影

这一节面向插件作者。世界作者通常用不到它。

`contract:world-ir@1` 是 `world-ir` 插件发布的一种中立格式，用来描述世界里的事实。它让世界作者或上游的抽取步骤只维护一份世界事实，再由各插件把同一份输入转换成自己的数据。

v1 的顶层和每类记录都拒绝未知字段。插件专用的内容只能放在 `attributes` 里：

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

source 只有明确写了 `effects: [projections]` 才会运行插件投影：

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

导入时，从这局游戏最终启用的插件里找出 `contributes.worldProjections`，按 `pluginId/projectionId` 排序，只执行 `from` 与 source 的 schema 完全相同的那些。handler 收到：

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

handler 的返回值：

- 必须是一个对象，键是声明的 output id。每个 output 的值可以是一条记录或记录数组。
- 多出的 output、缺少 key 字段、越界的 handler 路径、不符合目标 `contributes.data` JSON Schema 的结果都会被拒绝。
- 每条投影记录和普通导入的数据一样进入事务、导入账本和 `sync-data`，来源记为 `projection:<pluginId>/<projectionId>`。
- 没有匹配的已启用投影时，这个 source 产生零条投影写入，不算错误。

`living-world-rules` 的投影：每条源 statement 的 ID 变成 `world-ir-` 加它的 UTF-8 SHA-256 十六进制摘要，原始 ID 保留在 `sourceStatementId`。这样中文、带标点和很长的 ID 都能满足目标规则对 ID 的限制，源 ID 变了键也跟着变。所有 WorldIR 规则用同一种映射；手写规则的 ID 不受影响。

执行边界：

- `preflight` 只校验 source、声明、目标和 schema，**不加载也不执行 handler**。投影实际产生哪些 key，只有导入或同步之后才知道。
- 导入和同步只运行这局游戏已启用插件的匹配声明。单个投影失败只产生 warning，不阻止原始 source 的写入，也不影响其他插件的投影。
- 每个声明的 output 要么整组成功，要么整组不写。任何一条的 key 或 schema 无效时，这一组保持上一次成功的内容和账本，不会出现新旧混杂。只有 handler 成功返回 `[]` 才表示“确实没有记录”，这时才删除旧记录。
- 内置插件的 handler 可以直接运行。社区插件的 handler 需要这局游戏明确授权运行服务端代码。会话创建之前没法授权，所以创建时社区投影不运行，只发 warning，不会偷偷执行代码。玩家批准并启用这个插件时，投影随[开局后加入的接收插件](#开局后加入的接收插件)的导入运行一次。之后要按新的世界包重跑，作者和工具调用 `sync-data`；应用没有供玩家操作的同步入口。
- 每次调用在独立的 Worker 里运行，输入是一份结构化克隆：

  | 限制                  | 值               |
  | --------------------- | ---------------- |
  | 超时                  | 1 秒             |
  | V8 old / young 代上限 | 128 / 32 MiB     |
  | 栈上限                | 4 MiB            |
  | JSON 输出上限         | 1 MiB            |
  | 每个 output 的记录数  | 1000 条          |
  | 每个 source 的投影数  | 排序后的前 32 个 |

  Worker 隔离只用来防止状态互相影响和资源滥用，**不是安全沙箱**。已经授权的代码仍然可能访问 Node 和网络。

- handler 文件的摘要、投影与 output 的身份、实际产生的记录都计入账本里的来源摘要。只改 handler、不改世界数据时，下一次同步仍然能发现变化。执行前后 handler 的摘要不一致时，这次结果被丢弃，避免热更新时写入错误的来源记录。
- 创建会话时，先在锁和数据库事务之外读取 source、运行投影并生成一份不可变的计划，再在事务里一次应用。同步也是这样：dry-run 不取写锁；实际写入只在很短的锁内重新核对世界、语言、启用的插件与授权范围，然后检查冲突并应用。

**发现接口。** 开发工具和 Agent 可以通过 `GET /api/framework/capabilities` 发现 `projections` effect 和契约 URI 的写法，再通过 `GET /api/plugins/:id` 读取每个插件汇总后的 `worldProjections`。这些接口只返回声明信息，不暴露插件根路径或 handler 路径，也不能直接调用 handler。

**静态数据和游玩中的抽取**使用同一个 `contract:world-ir@1`，但执行方式不同：

- 静态世界数据走上面的 handler。
- 游玩中，`world-ir` agent 把叙事输出（`narrative-engine@1`）抽取一次，`codex`、`core-quest/log`、`affinity`、`inventory/ledger` 和 `npc-graph/extractor` 并行读取这一份结果。
  - 任务和物品是只读固定字段的 function runtime，不调用模型。
  - 好感仍由 agent 判断，字段见 [tools.md · submit-world-facts](./tools.md#submit-world-facts)。
  - `inventory/vocabulary` 与 `core-quest/vocabulary` 在 pre-turn 通过 `world-ir.vocabulary@1` 公布已追踪的物品名、任务名和未完成的目标，抽取时沿用同样的名称。
- 这次共享的抽取失败时，依赖它的 runtime 被跳过，不影响本回合叙事成功提交。
- 需要自动维护维度的会话，这时仍然留下 `pending-settlement`。失败或跳过不能当成“维度没有变化”；恢复完成之前会阻止下一次叙事。

## 世界角色 Schema

`world.yaml` 顶层的 `characterSchema` 说明这个世界的角色有哪些类型和属性：

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

- `types` 是除玩家以外的角色类型。`player` 是保留类型，不要写进 `types`；每局游戏最多有一个玩家角色。
- `attributes` 是角色可以有的属性。
- 创建会话时，它被复制进会话。角色的 `fields` 必须符合它；非玩家角色的类型必须在 `types` 里。工具、插件读取和最终保存用的是同一套校验。
- 修改世界的 `characterSchema` 只影响新开的会话。已有会话要在会话里明确修改。

给插件作者：

- 修改会话 schema 的 proposal 是 `character.schema.set`，内容是 `{types, attributes}`，版本由内核递增。
- `world-init` 的 guard 先用会话已有的 schema，再用世界声明的 schema；两者都没有时才调用模型生成。
- 维度和角色属性是两回事。维度的结构不会自动变成角色属性，也不会从其他会话或其他插件的私有数据里复制 schema。

## 领域角色与插件角色卡

角色有两类文件，作用不同：

| 文件                         | 是什么                                             | 谁读                       |
| ---------------------------- | -------------------------------------------------- | -------------------------- |
| `characters/characters.json` | 领域角色：会话里真正存在的角色记录                 | 内核、角色面板、所有插件   |
| `characters/main-cast.json`  | 角色卡：给模型的扮演说明（口吻、动机、秘密），可选 | 插件 `character-blueprint` |

四个内置世界两种都带。在 descriptor 里这样写：

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
    "aliases": ["Class President", "澪"],
    "type": "npc",
    "description": "A fellow student.",
    "fields": { "affection": 20 }
  }
]
```

**顺序。** 领域角色按作者在文件里写的顺序进入会话，面板和提示词里的名册都按这个顺序。多个 source 都写角色时，按 source 的导入顺序接着排。游玩中新建的角色排在它们之后。（实现上，导入时每个角色的 `createdAt` 比前一个晚一毫秒，列表按 `(createdAt, id)` 排序。）

**别名（`aliases`）。** 可选。写故事里对同一个人的其他叫法：昵称、只指这一个人的头衔、另一种文字的名字。按希望展示的写法和顺序写。

- 追踪角色、关系和好感的模型按名字找人。写了别名，模型用别名称呼时就会找到这个角色，而不是另建一个。
- 一个名字只能属于一个角色。别名和另一个角色的名字或别名相同时，`pnpm validate:world` 在后一条记录上报错，会话也不会带着这种数据创建。大小写、全角半角、空白、间隔号不算差别。
- 不要把“学者”“老板娘”这类可能指别人的普通名词写成别名。
- 语言文件里的 `aliases` 整列替换主文件的列表。
- 完整规则见[别名与按名字解析](./world-model.md#别名与按名字解析)。

**ID。** 导入时原样使用文件里的 ID（如 `mio`），不加前缀。角色记录不会复制到任何插件的数据里；面板和插件通过 `ctx.world.characters` 或角色 API 读到同一份。关掉接收角色卡的插件只跳过角色卡，不影响领域角色。

**`effects: [characters]`。** 它可以把同一个 source 里通用的 `{id,name,type,description,fields}` 变成领域角色，但不会理解角色卡里的 `persona/attributes/instantiate`。建议单独写一个 `to: characters` 的 source，明确给出要进入会话的字段。

**角色卡的字段去了哪里。** 前提是接收插件 `character-blueprint` 在这局游戏里启用：

| 角色卡字段                                                                                                   | 去向                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `name`、`persona.summary`、`description`、`role`、`aliases`、`tags`、`attributes`                            | 插件的只读“预设角色”面板                                                                                      |
| `persona`（`voice`、`style`、`summary`、`traits`、`goals`、`fears`、`secrets`）、`rules`、`dialogueExamples` | 故事 runtime 的 `<character-notes>` 提示段：按这些说明扮演角色；`secrets` 标为只有叙事者知道                  |
| `scenarioDefaults.relationships`、`scenarioDefaults.state`                                                   | 同一提示段；`state` 只作为开场事实列出，不保存、不能用工具修改                                                |
| `attributes`、`instantiate`                                                                                  | 不会自动变成领域角色；领域角色来自 `to: characters` 的 source。手动运行 `import` runtime 并实例化时才使用它们 |

要注意的三点：

- 提示段只写“角色在这局游戏里”的卡。判断方法：卡的 `id` 等于领域角色的 `id`，或者领域角色的 `id` 是 `npc-<卡 id>`。所以角色卡和领域角色要用对得上的 ID。
- 想让模型能修改的状态，要声明成 `characterSchema` 的属性，并写进领域角色的 `fields`。只写在 `scenarioDefaults.state` 里的开关没有可以修改的地方。
- 应用内的 AI 创建世界默认只生成领域角色，口吻和动机写在 `description` 里。创作者勾选了接收插件提供的“预设角色”内容时，才按上表另外生成角色卡。

长度上限与裁剪顺序见[插件 README](../../plugins/character-blueprint/README.md#角色卡怎样进入叙事)。

## Character Presence Portraits

给角色配头像和立绘，并在 `character-blueprint` 的立绘面板与对话中显示。完整的出图流程见[角色立绘](../worlds/portraits.md)；这一节是数据格式。

世界包交付两样东西：一个图片目录，和一份“哪个角色用哪张图”的映射文件。放在约定路径（`media/portraits/` 和 `media/presence.json`）时不用写 descriptor。在 descriptor 里是两条 source：

```yaml
sources:
  portraits:
    kind: media
    path: media/portraits # 一层目录，放 <id>.webp
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

- 第一条把 `media/portraits/` 下的图导入媒体库，并把索引交给 `character-blueprint`。每张图用它内容的 SHA-256 作为标识。
- 第二条 `presence.json` 是一个数组，每条把 `characterId` 对应角色的 `avatar` / `sprite` 指向一张图。
- `characterId` 写 `characters/characters.json` 里的原始 `id`（如 `npc-kamishiro-mio`），导入后的角色 ID 与它相同。前端匹配时，角色 ID 与它完全相同，或以 `-<characterId>` 结尾，都算对上。

```json
[
  {
    "schemaVersion": 1,
    "characterId": "npc-kamishiro-mio",
    "displayName": "神代澪",
    "avatar": {
      "id": "0000000000000000000000000000000000000000000000000000000000000000",
      "mime": "image/webp",
      "size": 2155557
    },
    "sprite": {
      "id": "0000000000000000000000000000000000000000000000000000000000000000",
      "mime": "image/webp",
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
            "mime": "image/webp",
            "size": 2155557
          },
          "stage": { "scale": 1, "offsetX": 0, "offsetY": 0 }
        }
      ]
    }
  }
]
```

> [!IMPORTANT]
> 图片引用里的 `id` 必须是那张图内容的 **64 位小写 SHA-256**。它和媒体库里的标识相等，图才找得到。不要手算：运行 `scripts/emit-presence.mjs <world>`，它从 `media/portraits/` 自动生成 `presence.json`。**重新生成立绘之后必须重跑一次**，刷新哈希。

**变体（`visuals`）。** 可选，用来给一个角色配多套服装和表情。`avatar` / `sprite` 是基础图。

- 每个变体必须有唯一的 `id` 和 `sprite`，可以用 `outfit`、`expression`、`pose` 标注。
- `stage.scale`（0.5–2）和 `offsetX` / `offsetY`（-100–100，百分比）用来校正不同裁切的源图在屏幕上的大小和基线。
- 舞台按这个顺序找图：精确的变体 id → 服装、表情、姿势的组合 → 默认变体 → 基础的 sprite / avatar。所以剧情请求了还没画的表情时，角色仍然会显示，不会空白。
- `scripts/emit-presence.mjs` 默认给每个角色生成一个 `default/default/neutral/default` 变体。作者可以在生成结果上继续添加服装和表情图。

**限制与启用：**

- 媒体单个文件最大 20 MB，一个 source 的目录合计最大 100 MB。
- 可以导入的扩展名：`.png`、`.jpg`、`.jpeg`、`.webp`、`.mp3`、`.wav`、`.mp4`。
- 预检要求对应契约的 schema 和接收声明已经注册。`character-blueprint` 的 `assets` 和 `presence` 分别接收 `character.portrait-assets@1` 与 `character.portraits@1`。
- 把接收插件放进 `pluginPolicy.recommended`，玩家就可以选择它。没有启用时，跳过它的数据和媒体索引，并给出 warning；之后在游戏里启用它，数据补导入一次。

实际例子见 `worlds/mistport` 与 `worlds/haruka-academy`（`data/world.data.yaml` + `media/`）。

## Scene Backgrounds

场景背景是地点的插画（教室、社团楼、海堤），白天和夜晚各一张。完整流程见[场景背景](../worlds/scenes.md)；这一节是数据格式。

- 世界包自带的背景通过 `stage.scene-assets@1` / `stage.scenes@1` 导入，由 `scene-stage` 插件接收。使用已有图片不需要配置图像模型。
- 只有开启了 `scene-stage` 的自动补图，并且缺图时，才会调用该插件 `modelPresetId` 指向的图像用途。安装社区的插画插件不会替它选择模型，见[图像生成](./image-generation.md)。

它和立绘用同一套图片流程，但清单不同：作者手写 `media/scenes.json`，脚本按清单批量生成 WebP，再由 `scripts/emit-scenes.mjs` 生成 `scenes.registry.json`。

`media/scenes.json` 字段：

| 字段           | 说明                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | 场景的 ID，也是文件名前缀（`<id>-day.webp` / `<id>-night.webp`）。                                                                                                                                                                                 |
| `name`         | 场景显示名。                                                                                                                                                                                                                                       |
| `locationRef`  | 对应作者定义的地点名；一张背景对应多个地点时用 `/` 分隔（`图书馆/二楼窗边长桌/旧刊架`），每一段都是这个场景的一个名字。内置 geography 模板的声明路径为 `geography.initialValue.regions[].name` 或其 `landmarks[].name`；这不是框架要求的维度结构。 |
| `subject`      | 英文画面描述（日图）。最终的生图提示词是 `style.prefix + subject + style.suffix`。                                                                                                                                                                 |
| `subjectNight` | 可选，夜图专用的画面描述；留空则夜图用 `subject`（配合 `style.nightSuffix`）。                                                                                                                                                                     |

**叙事报告的地点怎样对到场景。** 比较前去掉空白、不分大小写。按下面的顺序，前一条没有结果才看后一条：

1. 地点等于场景的 `name` 或 `locationRef` 的某一段。
2. 地点里含有某个名字（地点“图书馆二楼”对到名字“图书馆”）；有多个时取最长的名字。
3. 某个名字里含有这个地点（地点“海堤”对到名字“樱坂海堤”），并且只有一个场景如此。两个场景的名字都含有这个地点时不匹配，舞台不换背景图。

所以名字要写成叙事会用的说法，并避免让两个场景共用同一个短片段。

**两条 source，都不能省。** 一条把图片导入媒体库，一条导入注册表。媒体 source 必须带 `key` 和 `indexTo`，否则图片不会被导入（见上方[媒体 source](#descriptor) 的说明）：

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

实际写法见 `worlds/haruka-academy/data/world.data.yaml`。

**`scenes.registry.json`** 由 `scripts/emit-scenes.mjs` 自动生成，不要手写。重新生成场景图之后必须重跑它，刷新哈希。

- 形状是 `{schemaVersion, registryId, scenes:[{sceneId,name,locationRef?,day,night}]}`。`day` / `night` 是用 SHA-256 标识的图片引用。
- 整份文件作为**一条**记录导入。`registryId: "scene-registry"` 是固定值，同时充当 `key`。插件读这一条就拿到全部场景。

和立绘的区别只有一点：立绘只需要每张图的索引；场景图除了索引，还要把整份注册表交给 `scene-stage`。

> [!TIP]
> **还没有图时。** `media/scenes.registry.json` 不存在会让世界数据校验失败，因为 source 引用了不存在的文件。对空的 `media/scenes/` 目录运行一次 `emit-scenes.mjs`，会得到一份合法的空注册表（`{schemaVersion: 1, registryId: "scene-registry", scenes: []}`），先把它放进世界包占位。`scenes` 为空时舞台显示世界头图，这不是错误。出图之后重跑 `emit-scenes.mjs` 覆盖即可，不用改 `world.data.yaml`。

## Background Music

世界包的背景音乐由 `soundtrack` 插件接收（契约 `stage.music-assets@1` / `stage.music-tracks@1`）。播放不需要任何模型：插件按当前场景和情绪从曲目表里选曲，应用负责播放（见 [ui-panels.md](./ui-panels.md#stage-music)）。

世界包提供两样东西：

- `media/music/` 下的音乐文件：`.mp3` / `.wav`，单个文件最大 20 MB，整个目录最大 100 MB。
- 一份手写的曲目表 `media/music.yaml`。

曲目（`tracks` 里的每一项）：

| 字段     | 说明                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------- |
| `id`     | 曲目的 ID，在表内唯一。                                                                            |
| `title`  | 可选，播放时显示给玩家的曲名。                                                                     |
| `file`   | `media/music/` 下的文件名。不写哈希：导入时每个文件生成一条以文件名为 key 的索引记录。             |
| `theme`  | 可选，`true` 表示世界主题曲：没有别的曲目合适时播放。                                              |
| `scenes` | 可选，叙事里使用的场景名列表。声明后这首曲子只在这些场景播放；场景名相同或一方包含另一方即算命中。 |
| `moods`  | 可选，这首曲子适合的情绪。名字由世界作者自己定（见下），不区分大小写。                             |
| `loop`   | 可选，`false` 表示只播放一遍。默认循环。                                                           |
| `volume` | 可选，这首曲子的音量（0–1）。默认 1。玩家自己的音量再乘在上面。                                    |

**情绪。** 情绪没有固定的词表。曲目表顶层可以写 `moods`，列出这个世界的音乐情绪和各自的适用时机。叙事只看到这里的名字和说明，并在故事情绪变成其中一种时发出 `music.cue`：

```yaml
moods:
  - id: battle
    when: 刀已出鞘，胜负未分。
  - id: 灯下
    when: 回到有灯有火的地方，暂时安全。
```

- 没写顶层 `moods` 时，情绪清单就是各曲目 `moods` 里出现过的名字。
- 所有曲目都没有 `moods` 的世界，不向叙事提供情绪清单，音乐只跟随场景和主题曲。之后也可以由别的插件来决定怎样切换。
- `silence` 是保留字，表示停止音乐。

**选曲顺序。** `tracks` 的顺序就是优先顺序。依次找：

1. 符合当前情绪、并且属于当前场景的曲目；
2. 符合当前情绪、不限场景的曲目；
3. 当前场景自己的曲目；
4. 主题曲；
5. 静音。

情绪来自叙事发出的 `music.cue` 事件，场景来自 `scene.set` 事件（由跟踪场景的插件发出）。只想要一首贯穿全局的主题曲时，曲目表里放一首 `theme: true` 的曲目即可，不依赖任何事件。

> [!NOTE]
> 把 `soundtrack` 放进世界的 `pluginPolicy`，玩家启用它之后，这些数据才会导入并播放。

**怎样声明。** 没有 descriptor 的世界，把文件放在上面两个约定路径即可。有 descriptor 的世界写两条 source。`registryId: music-registry` 是曲目表里的固定值，同时充当 `key`：

```yaml
sources:
  music:
    kind: media
    path: media/music
    to: media
    indexTo: contract:stage.music-assets@1
    key: filename
  musicTracks:
    kind: yaml
    path: media/music.yaml
    to: contract:stage.music-tracks@1
    key: registryId
    after: music
```

**封面、主题色和世界列表上的音乐**也写在 `world.yaml` 里，三项都可以省略：

| 字段          | 写法                                                                                                                 | 用在哪里                                               | 省略时                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| `cover`       | 一张图片的路径：`media/` 下一层目录里的 `.png` / `.jpg` / `.webp`，最大 20 MB，例如 `media/gallery/world-cover.webp` | 世界卡片、世界详情、准备页和会话背景                   | 界面用自带的默认背景         |
| `accentColor` | `#rrggbb` 或 `oklch(72% 0.12 75)`                                                                                    | 卡片与标题的强调色                                     | 按世界 ID 算出一个固定的色相 |
| `themeMusic`  | 一个音频文件的路径：`media/` 下一层目录里的 `.mp3` / `.wav`，例如 `media/music/theme.mp3`                            | 世界选择页和世界详情展示这个世界时播放，不需要任何插件 | 不播放                       |

- 封面不必列在 `media/gallery.json` 里。列了的话，世界详情的图集不会把它再展示一遍。
- `themeMusic` 通常和曲目表里 `theme: true` 的那首是同一个文件。
- `pnpm validate:world` 会检查封面能否显示（`cover`）、音乐能否播放（`theme-music`）；颜色写法不对则按 schema 报错。
- AI 生成的世界没有图片，所以不带 `cover` 和 `accentColor`。

## Third-Party Extension

这一节讲两件事：插件作者怎样让世界包携带自己插件的数据，以及怎样给一个已有的世界追加数据。

第三方内容可以用两种方式交付：一个独立的世界包，或者一个 override 包。插件作者应公开带版本的契约（`contract:<contractId>`），世界包再引用它。

独立世界包：

```text
worlds/my-world-extra/
├── world.yaml
└── data/
    ├── world.data.yaml
    ├── characters/cast.json
    └── dimensions.yaml
```

给已有世界增加本地覆盖：

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

override 里的 `path` 相对 `~/.covel/world-overrides/<world-id>/`。路径解析符号链接之后仍然必须在这个目录里。

### 配套插件数据

当前版本能预置哪些内容、各自怎么声明和怎么写，用下面的命令查询。输出来自各插件的 `contributes.data.*.authoring` 声明，包含可以直接粘贴的 source 条目和一份合法的示例：

```bash
pnpm describe:authoring              # 文本
pnpm describe:authoring --json       # 机器可读
pnpm describe:authoring --plugins ~/.covel/plugins   # 一并扫描社区插件
```

**插件怎样接收世界数据。** 在根 `PLUGIN.md` 里同时发布 schema 和接收声明：

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

- schema 是插件根目录里的 JSON Schema 文件。
- 接收声明只写在包的根 `PLUGIN.md`，不写进 `RUNTIME.md`。
- 插件代码用 `ctx.pluginData.get(namespace,key)` / `list(namespace)` 读自己的数据；RPC 用绑定了当前会话和插件的 `ctx.store`。不要去读别的插件的私有数据。

插件作者还要做到三件事：

1. 在 `PLUGIN.md` 写清楚 namespace、契约、数据形状和示例文件。
2. 在 runtime 或工具里读取自己的数据。
3. 给世界作者一段最小可用的 `data/world.data.yaml` 片段，并声明 `authoring.source`，让文件可以按约定路径读取。

**世界包这一侧。** 数据文件建议用数组，一条一个对象：

```yaml
- id: mio-rin
  from: kamishiro-mio
  to: asakura-rin
  type: clubmate
  score: 42
```

对应的 source：

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

**导入账本。** 创建会话时，每条实际写入的记录（插件数据、资料库、角色、媒体索引）都记进 `world_data_import_ledger`，包含 `target`、`pluginId`、`namespace`、`key`、`sourceDigest`、`valueHash`、`schemaRef` 和 `sourceId`。会话、插件数据、资料库、角色和账本在同一个事务里写入；导入失败时全部回滚。之后的[同步](#preflight-与-sync)靠这本账判断哪些记录来自世界包、有没有被改过。

#### 内置 RPG 玩法种子（quests / items / affinity）

三个内置 RPG 插件接受世界包预置的数据。手把手的做法见[预置开局内容](../recipes/starting-content.md)，完整的成品见 `worlds/emberback/data/`。

| 插件         | schema URI                      | to                              | 记录形状                                                                                     |
| ------------ | ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `core-quest` | `contract:quests@1`             | `contract:quests@1`             | `{ id, name, description, status?, objectives?: [{id?, text, done?}], giver?, reward? }`     |
| `inventory`  | `contract:inventory.items@1`    | `contract:inventory.items@1`    | `{ id, name, quantity, description?, tags?: string[], equipped?: boolean }`                  |
| `affinity`   | `contract:character.affinity@1` | `contract:character.affinity@1` | `{ id, name, score (int -100..100), notes? }`（tier/history 等派生字段由工具首次写入时补齐） |

- 三者都用 `key: id`。约定路径分别是 `data/quests.yaml`、`data/items.yaml`、`data/affinity.yaml`。
- 预置的任务由 `core-quest` 只推进、不重建。建议给每个任务目标写一个任务内稳定的 `id`：之后推进时即使 `text` 被略微改写，也能勾到同一个目标。
- 预置的物品就是开局行囊。
- 预置的好感给关键 NPC 一个非零的起点，正负都可以。

### Preflight 与 Sync

**预检（preflight）**：在不写入任何东西的前提下，看一遍这次导入会写什么、有什么问题。

```http
POST /api/worlds/<world-id>/world-data/preflight
```

- 传 `plugins` 时，按这份插件选择预检。
- 传 `sessionId` 时，按已有会话启用的插件预检。
- 内置的界面在开始游戏前会自动调用它，展示计划写入的内容、目标摘要和诊断。

**同步（sync）**：作者和工具用的 HTTP 接口，把世界包后来的数据改动应用到一个指定的已有会话。应用目前没有供玩家操作的同步入口。

更新世界包、文件热更新和批准插件运行服务端代码，都不会自动调用同步。启用插件只为新加入、还没收到过这个世界数据的插件导入一次（见[开局后加入的接收插件](#开局后加入的接收插件)），不更新其他数据。玩家要使用新的开局数据，请新开会话；已有会话保留自己的数据和进度。正文仍按本页“改文件后自动重载”的规则更新。

```http
POST /api/worlds/<world-id>/sync-data
```

请求必须带 `sessionId`。默认只是试算（dry-run），返回计划和 `upserted`、`deleted`、`unchanged`、`conflicts`，不改会话。作者和工具先检查诊断与冲突，再传 `dryRun:false` 执行可应用的写入。请求和响应见 [API](./api.md#post-apiworldsidsync-data)。

同步读取该会话已启用插件所接收的数据，可以新增导入记录、更新未被改过的记录，以及删除世界包已经移除的记录。它不启用插件，不重新运行开局流程，也不重写历史故事。

同步规则：

1. 已有记录的覆盖和删除，只处理导入账本里 `managed=true`、并且 `sourceWorldId` 是当前世界的记录；新导入的记录写入同一本账。
2. 记录现在的内容和导入时一样（哈希与账本的 `valueHash` 一致），才会自动覆盖或删除。
3. 记录被玩家或插件改过时，返回 `conflicts.reason = "modified"`。
4. 世界包里仍然有这条，但会话里的记录不见了，返回 `conflicts.reason = "missing"`。
5. 世界包里已经移除、会话里也已经没有的记录，只清理账本，不报冲突。
6. 普通的导入记录可以用 `force:true` 覆盖 `modified` / `missing` 冲突。维度已经演化的值和待结算的保护不会因此解除。
7. 有冲突的记录保持原样并列在 `conflicts` 里，不影响其余记录：账本里没有的新记录（世界包后来新增的 source、新立绘）照常写入，没被改动的记录照常更新或删除。
8. 被同步改写的角色保留原来的 `createdAt`，在角色列表里的位置不变。世界包新增的角色排在已有角色之后。

**维度的额外规则：**

- 作者的声明没变时，保留当前进度，不重新套用初值。新增的维度用初值初始化。
- 修改或删除一个已经演化、被手改过、或者还有待结算回合的维度，返回 `modified` 冲突，值和声明都保留。
- 待结算的保护不依赖导入账本。游玩中才初始化、账本里没有记录的维度同样受保护；声明没变时不算冲突。
- 只有没被改动过的导入初值，才可以采用新声明或被删除。schema 变了不会自动转换旧值。
- 同步在事务里重新核对哈希与版本。预检通过不等于之后可以无条件覆盖。
- 维度有冲突时，返回计划和冲突，保留冲突的维度，其余没有冲突的记录照常应用。

`POST /api/worlds/:id/sync-dimensions` 同样只给作者和工具使用。它直接尝试写入 `sessionId` 指定的一个会话，没有 dry-run；想先试算，用 `sync-data`。它只同步维度，用同一本账和同样的冲突规则，不清理其他数据，也不重建资料库。文件热更新的通知本身不改变会话的当前值。

**媒体文件的保护。** 图片和音乐的字节按内容存放，由多局游戏共享，所以删除和失败时的处理比较保守：

- 同步删除一条媒体索引时，只在事务提交之后移除当前会话对那个文件的引用。会话的其他索引行（内容相同的文件共用一个 ID）、消息或快照里还出现这个文件时，引用保留，历史里的图仍然能读，从旧快照分叉也不受影响。文件本身由媒体清理（GC）在没人用时回收。
- 导入准备阶段，文件和一条本次导入专属的临时引用（`world-data-import:<uuid>`）一起写入，防止导入完成之前被清理掉。
- 导入完成时，先建立真实会话对文件的归属和引用，再释放临时引用。
- 准备、事务或会话准入失败时，只释放本次导入的临时引用。不强制删除共享的文件，也不动已有会话的引用。
- 新建会话的收尾失败时，在同一把会话锁内删除这个会话，并释放它的媒体归属和引用。
- 数据已经提交、但收尾失败时，保留临时引用，避免已提交的索引失去保护。会话创建回滚时删除失败，同样保留。
- 释放临时引用失败只记日志。进程崩溃或释放失败可能留下临时引用：它在创建满 24 小时后过期，由 `POST /api/media/cleanup` 释放，在那之前清理会保留那些文件（见 [媒体存储](./media-store.md#世界数据导入时的临时引用)）。

### World 包与插件包的边界

- **插件包**放执行逻辑、界面、schema 文档和默认示例。
- **世界包**放具体的世界数据和媒体。

第三方同时交付插件和世界数据时，推荐这样组织（一起发布的做法见[合集](../ship/collections.md)）：

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

通过时的输出：

```text
✓ worlds/emberback/world.yaml
```

- 校验器不创建会话，不执行插件代码。
- 它复用创建会话时的世界数据预检。所以这里通过的数据，创建会话时不会再因为记录内容而失败。
- 插件从仓库的 `plugins/` 加上每个 `--plugins <dir>` 里找。
- 世界声明了几种语言，预检就各跑一遍，因为[语言文件](#语言文件namelocaleext)会让不同语言读到不同的文本。主文件旁边的每个语言文件都会检查，不限于声明的语言。

**不依赖 schema 的检查：**

- 角色 source 和 `effects: [characters]` 按世界的 `characterSchema` 检查类型与属性，并检查合并后最多只有一个玩家角色。
- 直接导入的资料库记录必须有 `content`。
- 直接导入的记录和 `+lorebook` 投影出来的 `selective` 条目都必须有非空的 `keys`。
- 错误信息包含文件、记录序号和 key。导入之前发现错误就拒绝整个计划，其余合法的记录也不写。
- 空的 source 给出 warning。
- 接收插件用 [`authoring.references`](./plugins.md) 声明了“这个值是角色属性的 `id`”时，按世界的 `characterSchema` 检查这个值。属性不存在、类型不对或数值超出属性范围，报 `attribute-reference` 错误。世界没有写 `characterSchema` 时不检查。
- 记录或角色字段里，名字以 `At` 结尾或叫 `timestamp`、取值是 ISO 时间的字段，会被当成记账信息，模型读不到。每个这样的字段给出一条 `model-hidden-field` 提醒。要让模型看到剧情里的时间，请换一个名字（`date`、`diedOn`），或者不写成 ISO 时间。
- 记录里名字是 `id` 或以 `Id` / `Ids` 结尾、取值是 UUID 的字段，也会被当成记账信息，模型读不到，同样给出一条 `model-hidden-field` 提醒。请换成人能读懂的 ID，用小写单词加连字符，例如 `npc-lin-yao`。
- 即使没有任何约定的数据文件，`dimensionSources` 也会被检查。

**诊断一览：**

| 诊断 code               | 级别             | 含义                                                                                                                            |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `manifest-invalid`      | error            | `world.yaml` 无法解析或不符合 schema                                                                                            |
| `lore-missing`          | error            | 某个声明的语言（`defaultLocale` / `supportedLocales`）找不到正文文件                                                            |
| `lore-fallback-missing` | warning          | 没有 `WORLD.md`，未声明语言的会话会拿到空的正文                                                                                 |
| `lore-narrator-only`    | warning          | [narrator-only 标记](#只给叙事者的正文narrator-only)没有结束、没有开始、嵌套或写错；后面的正文会对玩家隐藏                      |
| `unknown-plugin`        | error 或 warning | `pluginPolicy` / `pluginSettings` 引用的插件 ID 不在已扫描目录中                                                                |
| `unknown-preset`        | error            | `pluginPolicy.presetId` 不是内置组合包，也不是这个世界 `packs` 里的 ID                                                          |
| `unknown-setting`       | warning          | `pluginSettings` 的 key 不是该插件声明的设置项，值会被忽略                                                                      |
| `invalid-setting`       | error            | `pluginSettings` 的值不符合该设置项声明的类型、范围或选项                                                                       |
| `unprovided-contract`   | error 或 warning | `pluginPolicy.requires` 的契约没有提供者                                                                                        |
| `unresolved-contract`   | error 或 warning | source 使用的数据契约没有任何已扫描插件接收                                                                                     |
| `unrequested-receiver`  | warning          | 新开会话默认启用的插件里没有这个 source 的接收方；玩家手动开启接收插件之前，这个 source 不导入                                  |
| `convention-collision`  | error 或 warning | 世界没有 descriptor，而某个文件所在的路径有不止一个插件声明；同时启用这些插件的会话不导入它                                     |
| `world-data`            | 与预检一致       | descriptor、source 顺序、文件读取、target、隐藏数据规则，以及按契约 schema 逐条校验的记录                                       |
| `locale-file-name`      | error            | 语言文件的文件名只写了语言（`.en.`），没有写成世界声明的 locale（`.en-US.`）；这个文件不会被读取                                |
| `locale-overlay`        | warning          | 语言文件里有一条译文无处安放（主文件没有这个 key 或 id，或它改了非文本的值），这条被忽略                                        |
| `locale-script`         | warning          | 非中日韩语言的语言文件里留有中日韩文字：没翻译的文本，或从主文件照抄的触发词                                                    |
| `edition-incomplete`    | warning          | `supportedLocales` 声明了某种语言，但该语言的版本缺少若干条译文；用这种语言开的会话会读到世界默认语言的原文                     |
| `inline-locale-map`     | error            | 主文件里把文本写成了多语言对照；主文件只写一种语言，译文放进语言文件                                                            |
| `data-file-unused`      | warning          | `data/`、`characters/` 或 `media/` 中的文件未被 source 或框架功能使用                                                           |
| `attribute-reference`   | error            | 记录里指向角色属性的值（由接收插件的 `authoring.references` 声明）在世界的 `characterSchema` 里不存在、类型不对或超出范围       |
| `model-hidden-field`    | warning          | 记录里有模型读不到的字段：名字以 `At` 结尾或叫 `timestamp`、取值是 ISO 时间；或者名字是 `id` / 以 `Id`、`Ids` 结尾、取值是 UUID |
| `cover`                 | error            | `cover` 指向的文件应用无法显示                                                                                                  |
| `theme-music`           | error            | `themeMusic` 指向的文件世界列表无法播放                                                                                         |
| `prompt-size`           | warning          | 内容占用的提示词偏大，见下                                                                                                      |

`unknown-plugin`、`unprovided-contract`、`unresolved-contract` 三项：拼写接近某个已知 ID 时是 error，并提示 “Did you mean”。否则默认是 warning，因为提供者可能是没被扫描的社区插件。加 `--strict` 后一律是 error。`pnpm release:preflight` 对内置世界使用 `--strict`。

**新开会话默认启用的插件**，就是开局准备页默认勾选的插件：`pluginPolicy.requested`、`presetId` 选中的组合包里的 `requested`、带 `preferredTags` 标签的插件，再加上 core 插件和 `requires` 自动带上的依赖。已扫描的社区插件当作已经同意。`unrequested-receiver` 和 `convention-collision` 按这个集合判断：`convention-collision` 的声明者里有两个在这个集合里时是 error，否则是 warning。记录仍然按所有已扫描插件的 schema 校验，所以玩家手动开启的插件，它的数据也会检查。

**`prompt-size` 的三种情况**，都不阻止使用：

| 内容                                       | 警告线      | 说明                                                               |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------ |
| `WORLD.md`                                 | 8,000 token | 这是故事提示词能带的长度；更长的正文在最后一个放得下的整行之后截断 |
| 一个 source 里 `constant` 资料库条目的合计 | 2,000 token | 这些内容每回合都进入提示词                                         |
| 维度初值                                   | 8,000 token | 维度在提示词里的摘要                                               |

长度是估算的 token：中日韩文字一字一个，其他文字四个字符一个。所以同一个世界用哪种语言写，量出来的标准都一样。必不可少的设定留在 `WORLD.md`，只在特定情况下才需要的设定写成 `selective` 资料库条目。

校验逻辑在 `apps/server/src/world-data/validate-world-package.ts`，返回结构化的诊断，其他工具可以复用。

### 开发检查清单

- source 的名字用短名，例如 `cast`、`social-links`、`portraits`。
- `path` 放在 `data/`、`characters/` 或 `media/` 下。
- `schema` 引用带版本的契约，或世界包里的 JSON Schema 文件。
- `to` 使用公开的数据契约或内核的目标（`characters`、`lorebook` 等）。数据落进哪个插件的哪个 namespace，由插件的接收声明决定，世界包不写。
- `key` 指向数据对象里稳定的 id 字段。
- 大段文字用 markdown / text source，大量结构化数据用 yaml / json source，图片和音频用 media source。
- 世界包和 override 包的路径都必须留在各自的根目录里。

## Current Limits

- source 只读取本地文件，类型是 `yaml`、`json`、`markdown`、`text`、`media`。
- media source 只扫描一层目录，只接受固定的扩展名（`.png`、`.jpg`、`.jpeg`、`.webp`、`.mp3`、`.wav`、`.mp4`），单个文件最大 20 MB，一个目录合计最大 100 MB。
- `merge` 只支持 `replace` 与 `skipExisting`。
- `key` 只支持简单的字段名、markdown / text 的固定 key、media 的 `filename`。
- 远程来源、SQLite 来源、CUE、RO-Crate、复杂的 JSON Patch 覆盖目前都不支持。

相关页面：

- **世界时间**不属于维度。它是插件数据，契约是 `world.time-definition@1`，记录写成 `{ id: world, definition }`，放在 `data/time.yaml`。AI 生成的这类记录在文件、服务端存储和浏览器本地的世界里保持同样的契约；不带文件夹的世界要求记录的 `key` 等于 `value.id`。字段、倒流和随机规则见 [World time](./world-time.md)。
- GitHub 世界包目录、一次选择多个世界、代理下载和更新流程见[世界目录与安装](./world-installation.md)。

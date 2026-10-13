# 世界模型

World Model 是一局游戏里由内核保管的那部分世界数据：世界记录、角色和角色的属性定义、资料库、维度的当前值。这一页说明它们各自的规则：名字怎样找到角色，维度的值什么时候能读、什么时候更新，资料库条目归谁所有。

世界作者主要需要“别名”一节。其余部分面向写插件的人。世界包里的文件怎么写，见[世界数据](./world-data.md)。

插件读取 World Model 的四个入口：

| 入口                        | 内容                 |
| --------------------------- | -------------------- |
| `ctx.world.worldRecord`     | 世界记录             |
| `ctx.world.characterSchema` | 角色的类型和属性定义 |
| `ctx.world.characters`      | 角色                 |
| `ctx.world.dimensions`      | 维度的当前值         |

这些入口是只读的，写入要通过 proposal（一份“我想改什么”的申请，由内核校验后统一保存）。

- 角色和角色 schema：同一次执行里，排在前面的 runtime 提出的合法修改，以及当前 runtime 自己还没保存的修改，后面读得到。
- 维度不一样：它的值在一个回合内是冻结的。不要把自己刚提出的修改当成别的 runtime 已经能看到的值。

字段和各部分归谁管见[插件契约](./plugins.md#world-model-与数据边界)。

## 角色与角色 schema

世界包可以在 `world.yaml` 里声明 `characterSchema`，创建会话时它被复制进会话。

- 它包含 `types`（角色类型）和 `attributes`（属性）。
- `player` 是保留类型，每局游戏最多一个。其他类型由 schema 声明。
- 角色的 `fields` 按当前的 schema 校验。
- 修改 schema 的 proposal 是 `character.schema.set`，内容是 `{types, attributes}`，版本由内核递增。

世界文件、角色初值和导入的例子见[世界数据](./world-data.md#世界角色-schema)与[领域角色](./world-data.md#领域角色与插件角色卡)。

几条边界：

- 角色的创建和更新只通过角色 proposal 和角色工具。
- 角色面板读会话的 `session.characters`，属性的显示读会话的 `characterSchema`。
- 插件的角色卡可以保留自己的原始内容，但内核的角色记录不会复制到任何插件的数据里。
- 角色卡里的 `persona`、`scenarioDefaults` 不会自动变成角色的 `fields`。需要时请明确提供 `fields`。schema 没有声明的字段不会因此被拒绝。
- 维度的结构不会自动变成角色属性。角色、背包、好感和时间各由自己的插件维护。

AI 生成世界时的校验：

- 新建时，接受补充的角色之前，按生成的 `characterSchema` 校验**整组**角色：角色类型、属性约束、只有一个玩家。
- 修改时，按合并后的 schema 校验全部角色，不能只检查新增的。

### 别名与按名字解析

故事里同一个人有很多叫法：名字、昵称、头衔、另一种文字写的名字。所以角色在 `name` 之外还有可选的 `aliases`：一个有顺序的字符串列表，按展示用的写法保存。没有别名时没有这个字段。

```ts
interface CharacterRecord {
  id: string;
  name: string;
  aliases?: readonly string[]; // 守灯人伊索德 → ["伊索德", "守灯人"]
  type: string;
  // description, fields, version, createdAt, updatedAt
}
```

**一个名字只指一个人。**

- 一局游戏里，任何别名都不能是另一个角色的名字或别名。角色的名字也不能是另一个角色的别名。
- 世界导入、执行中的读取和最终保存用的是同一份校验（`validateWorldModel`）。违反时报错，并写明另一个角色是谁，不会悄悄选一个。
- 两个角色同名（类型不同）仍然允许。按这个名字查找时，结果是“有歧义”。

**把名字变成角色只有一条规则**：`@covel/plugin-handlers-utils` 的 `resolveCharacter(characters, query, options?)`（`@covel/shared` 也导出同名函数）。内置的角色工具和内置插件都用它。结果有三种：

| 结果        | 含义                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| `found`     | 依次按 ID 原样、名字、别名匹配到唯一角色，`matchedBy` 说明是哪一步                          |
| `ambiguous` | 这个名字或别名属于不止一个角色，`candidates` 列出它们；调用方必须报告，不能自行选择         |
| `missing`   | 没有角色叫这个名字；`closest` 按相似程度列出最多 5 个相近的角色，供错误信息提示，不用于匹配 |

比较名字和别名之前，先用 `characterNameKey` 把写法统一：

- **算作相同的差别**：
  - 字母大小写；
  - 全角与半角（NFKC）；
  - 首尾空白和连续空白；
  - 包在名字外面的引号与书名号（`"…"`、`「…」`、`《…》`）；
  - 译名中间的间隔号（`・`、`·`、`•` 视为同一个）；
  - 撇号的不同写法；
  - 英文开头的 `the`。
- **不算相同的差别**：头衔、敬称和称谓（`Dr.`、`Sister`、`先生`、`小姐`、`老`）。`Dr. Park` 和 `Mr. Park`、“陈先生”和“陈小姐”可以是两个人，去掉称谓会把他们并成一个。只指一个人的头衔请写成别名。
- **没有模糊匹配**：不比较编辑距离，也不比较读音。拼错一个字母不会匹配成功，只会出现在 `closest` 里，让模型自己改正。

`{ partial: true }` 只给读取用。没有精确匹配时，如果恰好只有一个角色的名字或别名包含查询词（或被它包含），就返回这个角色。例如 `Mina Park` 找到 `Dr. Mina Park`。

> [!WARNING]
> 写入不能用 `partial`。“陈”今天只匹配陈远山；故事里来了第二个姓陈的人之后，就会写到错的人身上。

**别名从哪里来：**

- 世界作者在 `characters/characters.json` 里写 `aliases`（见[领域角色](./world-data.md#领域角色与插件角色卡)）。语言文件可以整列替换。
- 故事揭示新名字时，模型通过 `update-character` / `sync-characters.updates[]` 的 `aliases` 参数追加。`create-character` 也接受 `aliases`。
- `character.upsert` proposal 的 `aliases`：
  - 带 `expectedVersion` 时，追加到已有别名之后。同一回合两次追加都保留，和 `fields` 的合并方式一样。
  - 不带时，它就是完整的列表。
  - 和角色名字相同的别名、重复的别名在写入时去掉。
  - 带 `expectedVersion` 的 proposal 还可以带 `removeAliases`：先从已有别名里去掉这些（按统一后的写法比较，没有的略过），再追加 `aliases`。模型挂错的别名靠它撤销。否则按“一个名字只指一个人”，真正叫这个名字的角色永远拿不到它。别名冲突的报错里会提示这一点。

**模型看到的写法**是名字后面跟一个括号：`- 守灯人伊索德 (aka 伊索德, 守灯人) [npc] | …`（`characterLabel`）。`characterSheetSegments`、`{{ characters.npcs }}`、`list-characters` 和角色追踪的名册都只在有别名时多出这一段；没有别名的角色一个字符也不多。内置的四个世界里，每个角色因此多 5 到 9 个 token。

**玩家看到的**：角色面板里显示别名，只读。游玩界面不提供编辑。

**玩家的名字不能是世界里已有角色的名字或别名**（按 `characterNameKey` 比较）。原因：世界常把常见的名写成别名（`Tomas`、`June`）。玩家起了这样的名字，保存时会被拒绝；和某个 NPC 全名相同虽然不被拒绝，之后按这个名字的每次查找都会是 `ambiguous`。所以建角的三个环节都执行同一条规则：

- **建角表单**带校验器 `player-name`（`char-creator` 用 `registerFormValidator` 注册）。提交已被占用的名字会得到 `form_rejected`，`issues` 指向 `characterName` 字段，文字用会话的内容语言。答案没有保存，玩家改名后再提交同一张表单。
  - 表单会发给客户端并留在会话消息里，所以它不带任何角色的名字或别名。它带的是这些名字按表单加盐后的 SHA-256 摘要（放在 `validation.data`）。
  - 摘要只防止直接读出名单，防不住拿着已经猜到的名字去验证。
- **`player-init` 的 guard** 再查一次，因为表单发出之后世界里的角色可能变了。名字仍然冲突时，它不产生 `character.upsert`，而是让 runtime 重新发出表单，`notice` 说明这个名字已有角色使用，其余答案保留。开局不会因此反复失败。
- **`create-character`** 创建 `type: "player"` 时，名字是其他角色的名字或别名就报错，并说明要向玩家另要一个名字。它不会把那个 NPC 当作“已经存在的角色”返回。

保存时的规则没有变：两个非玩家角色可以同名（查找时是 `ambiguous`），名字等于别人的别名才被拒绝。

> [!IMPORTANT]
> `characters` 表有 `aliases` 列。服务端只建表、不改表，所以在加入别名之前创建的 SQLite / PostgreSQL 开发数据库缺这一列，读取角色时报 `no such column: aliases`。按[迁移说明](./env-registry.md#plugin-extension-development-data)备份后换一个新的数据库文件（PostgreSQL 重建 schema）。浏览器私有存档里的角色没有别名，照常读取。

## 动态维度快照

世界包里的 `dimensions` 是作者的声明：结构、初值和可选的更新规则。`ctx.world.dimensions` 是**这局游戏的当前值**，形状由公共契约 `world.dimensions@1` 规定：

```ts
interface DimensionSnapshotEntry {
  name: I18nText;
  description?: I18nText;
  schema: DimensionValueSchema;
  value: JsonValue;
  version: number;
}

type DimensionSnapshot = Readonly<Record<string, DimensionSnapshotEntry>>;
```

读取的位置：

| 谁读             | 写法                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| 插件             | `ctx.world.dimensions.reputation.value`                                                                             |
| 提示词模板       | `{{ world.dimensions.reputation.value }}`                                                                           |
| 客户端的会话视图 | `snapshot.dimensions.reputation.value`                                                                              |
| 模型             | 内置工具 `world-dimension-get`（`path` 相对于该项的 `value`）和 `world-dimension-list`（只列 ID、名称、类型和版本） |

规则：

- 读到的每一项不包含 `initialValue`、`updateRule`，也不包含它上次是按哪个回合更新的。
- 值是原始 JSON。显示和查询时，只翻译 schema 明确标了 `x-i18n` 的节点。
- 没有插件负责维度，或者维度还没初始化时，快照可以是空的。
- 已经有插件负责维度、但它不可用或读取失败时，必须报错。不能改用世界包的初值，也不能假装是空的。

### 属主与写入

**谁负责。** 内置的 `world-init` 提供世界上下文（扩展点 `session.world-context@1`，只能有一个提供者）和 `world.dimensions@1`。框架按契约找到唯一负责的插件，不按插件 ID 判断。负责的插件 ID（`dimensionProviderPluginId`）由宿主填写；`dimensionRecovery` 里的 editor / tracker runtime ID 必须确实属于这个插件。

**存在哪里。** 每个维度在负责插件的受保护区域 `_dimensions` 里是一条 `{definition, value, version, lastTrackedSource?}` 记录。

- 声明和当前值共用一个版本号，从 1 开始。
- 同一个世界的各局游戏互相隔离，不回写世界包。
- 不会再往别处存一份（没有 `state_entries` 副本，也没有常驻的资料库条目）。

**怎么写。** 只有两种 proposal 可以写：

| proposal               | 内容                                                                                      | 行为                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `dimension.initialize` | `{definitions}`                                                                           | 只创建还没有的记录。用同样的声明重复初始化什么都不做，不重置进度。已采用的声明不一样时是冲突。 |
| `dimension.update`     | `{updates: [{id, expectedVersion, value, reason?}], source?, readVersions?, settlement?}` | 值满足 schema、所有版本都对得上，才整批保存。不会自动合并，也不是“后写的赢”。                  |

- 自动结算时的 `source` / `readVersions` 由宿主提供，不由模型填写。
- 普通的插件数据写入、批量写入、删除和 REST 写入都碰不到这块受保护的区域。
- 玩家改值通过 runtime RPC 提交同一种 proposal。普通的手改不带结算来源，所以不会自动解除待结算的回合。
- 整批保存和版本比较的细节见[事务契约](./transactions.md#versioned-plugin-data-batch-cas)。

### 回合时序与结算回执

```text
已解除上一回合的结算义务
  → dimension-context 在 pre-turn 发布已提交快照 Sₙ（不调用模型）
  → narrator、WorldIR 与 tracker 以同一版本内容为公共读取基线
  → post-turn tracker 按规则求值，提交时再次校验版本
  → 原子写入当前值与成功回执；回合结束后客户端读取已提交新版
```

**一个回合内，读到的值不变。** 玩家同时手改，或者 tracker 提出了修改，都不会让这一回合读到的值变化。下一次执行重新读取已保存的值。

- `dimension-context` 在这次执行里运行了、但没成功时，叙事被跳过（`dimension-snapshot-unavailable`），整次执行不保存：它之前的 runtime 的写入、对话记录和回合计数一并回滚。玩家可以重试同一个动作。
- `dimension-context` 没有被安排运行时（指定只跑叙事的手动运行，或重试），叙事直接使用执行开始时已保存的值。
- 叙事不能反过来依赖回合后才运行的 tracker 的输出。`recordAs` 导出也不能代替保存下来的值。
- 提示词里放的是有长度预算的摘要，需要时再查询，不会默认展开所有大表。

**结算义务。** 有自动维护规则时，叙事保存的同时，宿主登记一条“这一回合的维度还没结算”。它和这一回合的叙事结果、回合号绑定。

- tracker 没有运行、失败，或者发生版本冲突，都**不等于**没有变化。
- 没有自动规则时，没有维护用的模型调用，也没有结算义务。

回执保存在 `_dimension-settlements`，有五种状态：

| 状态                 | 含义                                         | 允许继续叙事 |
| -------------------- | -------------------------------------------- | ------------ |
| `pending-settlement` | 尚未成功结算，包括未运行、维护失败、冲突     | 否           |
| `settled`            | 数值变更与成功回执已原子提交                 | 是           |
| `no-change`          | 明确求值并校验读取版本后的无变化回执         | 是           |
| `manual`             | 玩家明确确认已人工处理该来源                 | 是           |
| `skipped`            | 玩家明确跳过该来源，保留当前值且不再自动补算 | 是           |

- 已经保存的故事可以保留，附带一条待结算的回执。结算被拒绝不会让有效的叙事作废；数据库出错时仍然整体回滚。
- 下一次叙事之前检查有没有未解决的义务。解决的办法有三种：重试原回合、人工确认、明确跳过。
- “改一个值”和“确认已人工处理”是两个不同的操作。

**回执里存什么：**

- 待结算的回执保存：来源的引用、这一回合读到的各维度版本（`readVersions`）、带更新规则的维度声明，以及状态。它不重复保存叙事正文；重试时从原回合保存的结果里读。
- 回执进入最终状态后，清掉声明和 `readVersions`，只留下结果的身份、状态和版本，用来防止重复结算。
- 已经有最终状态的来源不会再结算一次。
- 恢复、重启、分叉和浏览器的存档点都保留义务和回执。
- 客户端只收到[公开的摘要和恢复入口](./api.md#维度编辑与待结算恢复)，收不到私有的规则和读取基线。

**初始化的细节。** 维度初始化只通过 `dimension.initialize` proposal 写入。它同样经过 `PreStateCommit` 这一步检查，并在提出它的 runtime 自己保存的时候落库。被否决就不写；被改写就写改写后的声明。回执记录的是已经保存的记录，所以同一事务里被否决、或随 runtime 一起丢弃的初始化不会出现在回执里。

**玩家在界面上看到的：**

- 游玩时，维度的值是只读的。
- 有待结算的回合时，对话上方出现提示，可以重试或明确跳过。
- 自由改值和“确认已人工处理”在调试用的会话数据视图里。
- 条目的标签和给玩家看的错误信息使用界面语言。

> [!IMPORTANT]
> 维度必须按[当前声明格式](./world-data.md#动态世界维度dimensions)写。早期“只写一个值”的维度、存在资料库里的维度副本和那时的快照都读不了，也没有自动转换。请更新世界包，并重新创建受影响的开发世界、会话和快照。维度只提供会随剧情变化的数据，不负责隐藏事件和按条件触发，那是[隐藏数据](./world-data.md#隐藏数据visibility-hidden)和 `story-events` 插件的事。

## Lorebook

资料库（lorebook）是一局游戏里的设定条目。

**条目归谁。** 一条条目由 `(sessionId, owner, id)` 三项确定。`owner` 可以是 world、player 或 plugin：

- 从世界包导入的条目属于 world。
- 玩家编辑的接口只处理 player 的条目。
- 插件通过 `lorebook.upsert` 写入的条目，归属由 proposal 的来源决定。插件不能覆盖其他所有者的同 ID 条目。

管理接口见 [Lorebook API](./api.md#lorebook)，导入目标见[世界数据目标](./world-data.md#target-uri)。

**禁用一条条目。** `enabled: false` 表示完全停用：

- 它不再自动进入提示词，也不参与关键词检索和向量检索。
- 向量索引是后台慢慢更新的。即使旧的向量还没清掉，检索时也会看条目现在的状态，停用条目的旧向量不会被返回。之后的索引更新会清掉它的向量和进度。
- 重新启用后，关键词检索立刻恢复。还没清掉的向量可以马上接着用；已经清掉的由之后的索引更新重建。
- 停用不删除条目，也不影响其他所有者的同 ID 条目、角色或插件的记忆块。

> [!NOTE]
> 只有 `plugin_id` 一列、没有所有者的旧资料库表不会自动升级。开发环境的处理办法见[迁移说明](./env-registry.md#plugin-extension-development-data)。

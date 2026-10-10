# World Model

World Model 的只读执行视图包含世界记录、角色 schema、角色与公开的动态维度快照。插件通过 `ctx.world.worldRecord`、`ctx.world.characterSchema`、`ctx.world.characters`、`ctx.world.dimensions` 读取；角色和 schema 的合法上游 proposal 及本 runtime 缓冲写入可物化为执行局部视图。动态维度有独立的回合冻结边界，不能把局部写入预览当成其他 runtime 已可见的公共状态。字段与属主边界见[插件契约](plugins.md#world-model-与数据边界)。

## 角色与角色 schema

世界包可在 `world.yaml` 声明 `characterSchema`，会话创建时写入领域 schema。它包含 `types` 和 `attributes`；`player` 是保留类型，每会话至多一个，其他角色类型由 schema 声明。`character.schema.set` proposal 的 payload 为 `{types, attributes}`，版本由内核递增。角色 `fields` 按当前 schema 校验。世界文件、角色初值和导入示例见[世界数据](world-data.md#世界角色-schema)与[领域角色](world-data.md#领域角色与插件角色卡)。

AI 世界生成在接受角色补充前，按生成 manifest 的 `characterSchema` 校验整个角色集合（包括角色类型、声明字段约束与 player 单例）；修订按合并后的 schema 校验全部角色，不能只检查新增条目。蓝图 `persona`、`scenarioDefaults` 不自动成为领域 `fields`；需要领域字段时显式提供 `fields`，未声明字段仍遵循领域校验的宽容规则。

角色创建与更新走领域 proposal 和工具；角色面板从会话 `session.characters` 读取，角色字段组件从会话 `characterSchema` 读取。插件角色卡可以保留自己的原始蓝图，但不将领域角色镜像到插件 namespace。dimension 的资源 schema 不会自动转换成角色属性；角色、背包、好感和时间继续由各自领域属主维护。

### 别名与按名字解析

故事里同一个人有很多叫法：名字、昵称、头衔、另一种文字写的名字。角色记录因此在 `name` 之外有可选的 `aliases`：一个有序的字符串列表，按展示用的写法保存，没有别名时不出现该字段。

```ts
interface CharacterRecord {
  id: string;
  name: string;
  aliases?: readonly string[]; // 守灯人伊索德 → ["伊索德", "守灯人"]
  type: string;
  // description, fields, version, createdAt, updatedAt
}
```

**一个名字只指一个人。** 会话内任何别名都不能是另一个角色的名字或别名，角色的名字也不能是另一个角色的别名。这条规则在 `validateWorldModel` 里检查，世界导入、执行内读取和提交用的是同一份校验；违反时报错并写明另一个角色是谁，不会悄悄选一个。两个角色同名（不同类型）沿用原先的行为，仍然允许，按名字查到它们时结果是「有歧义」。

**把名字变成角色只有一条规则**：`@covel/plugin-handlers-utils` 的 `resolveCharacter(characters, query, options?)`（`@covel/shared` 同名再导出）。内置角色工具和捆绑插件都用它，结果有三种：

| 结果        | 含义                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| `found`     | 依次按 ID 原样、名字、别名匹配到唯一角色，`matchedBy` 说明是哪一步                          |
| `ambiguous` | 这个名字或别名属于不止一个角色，`candidates` 列出它们；调用方必须报告，不能自行选择         |
| `missing`   | 没有角色叫这个名字；`closest` 按相似程度列出最多 5 个相近的角色，供错误信息提示，不用于匹配 |

名字和别名比较前先用 `characterNameKey` 归一：

- 折叠：字母大小写；全角与半角（NFKC）；首尾空白和连续空白；包在名字外面的引号与书名号（`"…"`、`「…」`、`《…》`）；译名中间的间隔号（`・`、`·`、`•` 视为同一个）；撇号的写法；英文开头的 `the`。
- **不折叠**：头衔、敬称和称谓前后缀（`Dr.`、`Sister`、`先生`、`小姐`、`老`）。`Dr. Park` 和 `Mr. Park`、「陈先生」和「陈小姐」可以是两个人，去掉称谓会把他们并成一个。只指一个人的头衔写成别名。
- 不做编辑距离或读音之类的模糊匹配：拼错一个字母不会解析成功，只会出现在 `closest` 里让模型自己改正。

`{ partial: true }` 只给读取用：没有精确匹配时，如果恰好只有一个角色的名字或别名包含查询词（或被它包含），就返回该角色（`Mina Park` 找到 `Dr. Mina Park`）。写入不能用它：「陈」今天只匹配陈远山，故事里来了第二个姓陈的人之后就会写到错的人身上。

别名的来源有三处：

- 世界作者在 `characters/characters.json` 里写 `aliases`（见[领域角色](world-data.md#领域角色与插件角色卡)），语言文件可以整列替换。
- 模型在故事揭示新名字时，通过 `update-character` / `sync-characters.updates[]` 的 `aliases` 参数追加；`create-character` 也接受 `aliases`。
- `character.upsert` proposal 的 `aliases`：带 `expectedVersion` 时追加到已有别名之后（与 `fields` 的浅合并同理，同一回合两次追加都保留），不带时是完整列表。与角色名字相同的别名、重复的别名在写入时去掉。带 `expectedVersion` 的 proposal 还可以带 `removeAliases`：先从已有别名里去掉这些（按归一后的写法比较，没有的略过），再追加 `aliases`。模型挂错的别名靠它撤销，否则按「一个名字只指一个人」，真正叫这个名字的角色永远拿不到它；别名冲突的报错里会提示这一点。

模型读到的写法是名字后面跟一个括号：`- 守灯人伊索德 (aka 伊索德, 守灯人) [npc] | …`（`characterLabel`）。`characterSheetSegments`、`{{ characters.npcs }}`、`list-characters` 和角色追踪的名册都只在有别名时多出这一段，没有别名的角色一个字符也不多。内置四个世界每个角色多 5 到 9 个 token。

玩家在角色面板里看到别名（只读）。游玩界面不提供编辑。

> **BREAKING CHANGE**：`characters` 表新增 `aliases` 列。服务端只建表、不改表，此前创建的 SQLite / PostgreSQL 开发数据库缺这一列，读取角色时报 `no such column: aliases`。按[迁移说明](../guide/env-registry.md#plugin-extension-development-data)备份后换一个新的数据库文件（PostgreSQL 重建 schema）。浏览器私有存档里的角色没有别名，照常读取。

## 动态维度快照

世界包的 `dimensions` 是作者 definition map，保存结构、初值与可选更新规则；`ctx.world.dimensions` 是**会话当前值**，采用 `world.dimensions@1` 公共契约：

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

统一读取路径：

- 插件：`ctx.world.dimensions.reputation.value`。
- 提示词模板：`{{ world.dimensions.reputation.value }}`。
- 客户端会话视图：`snapshot.dimensions.reputation.value`。
- builtin `world-dimension-get` 的 `path` 相对于该项的 `value`；`world-dimension-list` 只列 ID、名称、类型和版本。

公共项不包含 `initialValue`、`updateRule` 或追踪来源。快照保留原始 JSON；本地化展示与查询仅处理 schema 显式标记的 `x-i18n` 节点。没有活跃提供者或尚未初始化时可为空；已绑定提供者不可用或读取失败必须报告错误，不能回退世界包初值或假装空状态。

### 属主与写入

`session.world-context@1` 仍为 single 扩展点。捆绑的 `world-init` 提供上下文和 `world.dimensions@1`，框架通过契约发现唯一属主，而非按插件 ID 分支。`dimensionProviderPluginId` 由 host 注入；`dimensionRecovery` 中的 editor/tracker runtime ID 须验证属于同一活跃提供者。

每个维度在属主的受保护 `_dimensions` namespace 中保存一条 `{definition, value, version, lastTrackedSource?}` 记录；定义与当前值共用一个版本，版本从 1 开始。同一世界的会话互相隔离，不回写世界包，也不双写 `state_entries` 或常驻 lorebook。

只有领域路径可以写入：

- `dimension.initialize`：`{definitions}`，仅创建缺失记录；同定义重复初始化为 no-op，不重置进度，已采用定义不同则冲突。
- `dimension.update`：`{updates: [{id, expectedVersion, value, reason?}], source?, readVersions?, settlement?}`。值满足有效 schema、所有版本匹配才整批提交；不自动 rebase 或最后写入获胜。自动结算的 `source/readVersions` 来自 host 输入，不由模型填写。

普通 `plugin.data`、batch、delete 和 REST 写入不能绕过保留 namespace 校验。玩家修改通过 runtime RPC 提交同一领域 proposal；普通手改没有结算来源，不自动解除待结算义务。原子性和 CAS 见[事务契约](transactions.md#versioned-plugin-data-batch-cas)。

### 回合时序与结算回执

```text
已解除上一回合的结算义务
  → dimension-context 在 pre-turn 发布已提交快照 Sₙ（不调用模型）
  → narrator、WorldIR 与 tracker 以同一版本内容为公共读取基线
  → post-turn tracker 按规则求值，提交时再次校验版本
  → 原子写入当前值与成功回执；回合结束后客户端读取已提交新版
```

回合内公共读取冻结，不因玩家并发手改或 tracker 的局部预览换版；新执行重新读取已提交存储。dimension-context 在本次执行中运行但未成功时，叙事 runtime 被跳过（`dimension-snapshot-unavailable`），整次执行不提交：它之前的 runtime 的写入、对话记录与回合计数一并回滚，玩家可重试同一动作；它未被调度时（定向的手动叙事或重试），叙事直接使用执行开始时冻结的已提交快照。`recordAs` export 不替代权威状态库，叙事不能反向依赖 post-turn tracker 的输出。提示词使用预算投影与按需查询，不默认展开全部大行集。

有自动维护规则时，host 在叙事提交事务中登记源回合义务，身份绑定服务器确定的 narrative result ID 和逻辑回合号。维度初始化只经 `dimension.initialize` proposal 写入：它同样经过 `PreStateCommit`，并在提出它的 runtime 自己的提交边界内落库；被否决不写入，被改写则写入改写后的定义。回执冻结的是已提交的记录，同一事务里被否决或随 runtime 一起丢弃的初始化不会出现在回执中。tracker 未运行、失败或发生版本冲突不等于无变化。回执保存在 `_dimension-settlements`，有五种状态：

| 状态                 | 含义                                          | 允许继续叙事 |
| -------------------- | --------------------------------------------- | ------------ |
| `pending-settlement` | 尚未成功结算，包括未运行、抽取/维护失败、冲突 | 否           |
| `settled`            | 数值变更与成功回执已原子提交                  | 是           |
| `no-change`          | 明确求值并校验读取版本后的无变化回执          | 是           |
| `manual`             | 玩家明确确认已人工处理该来源                  | 是           |
| `skipped`            | 玩家明确跳过该来源，保留当前值且不再自动补算  | 是           |

自动规则缺失时没有维护模型调用，也不产生结算义务。已提交故事可以保留并附 pending 回执；领域结算拒绝不使有效叙事作废，存储异常仍回滚事务。下一次叙事前检查未解决义务，恢复通过原回合重试、人工确认或明确跳过完成。普通改值与“人工处理完成”是不同操作。

完整回执保存来源引用、该回合采用的 readVersions、带更新规则维度的 definitions 及状态，不重复保存叙事正文；重试从原 turn artifact 读取。已终结来源不重复结算，恢复、重启、fork 与浏览器 checkpoint 保留义务及回执。客户端只收到[公开摘要和恢复入口](api.md#维度编辑与待结算恢复)，不收到私有规则或读取基线。

> **BREAKING CHANGE**：旧 raw dimensions、世界词条副本与旧快照不提供兼容读取。按[当前声明格式](world-data.md#动态世界维度dimensions)更新世界包，并重建受影响的开发世界、会话和快照。本期只提供动态状态层，不实现隐藏事件/条件触发（#97）。

## Lorebook

`enabled: false` 表示全面禁用该词条：不参与自动提示词注入，也不参与 archival 关键词或向量检索。已有异步索引尚未清理时，检索仍检查当前源状态，禁用词条的旧向量不会返回；后续 ingestion 清除其向量与索引进度。重新启用后恢复关键词检索；未清理的有效向量可立即复用，已清理的向量由后续 ingestion 重建。禁用不删除词条，不影响其他 owner 的同 ID 词条、角色或插件记忆块。

Lorebook 使用 `(sessionId, owner, id)` 作为身份，`owner` 可为 world、player 或 plugin。世界导入条目属 world；玩家编辑 API 固定处理 player；插件 `lorebook.upsert` 的归属由 proposal 来源绑定，插件不能覆盖其他 owner 的同 ID 条目。管理 API 和导入目标分别见[Lorebook API](api.md#lorebook)与[世界数据目标](world-data.md#target-uri)。旧数据库中只有 `plugin_id` 的 Lorebook 表不自动升级；开发环境操作见[迁移说明](../guide/env-registry.md#plugin-extension-development-data)。

维度结算回执进入终态后清空 definitions 和 readVersions，仅保留结果身份、状态和版本等幂等信息；待结算回执保留冻结定义用于恢复。下一次叙事的屏障只解析待结算项。

During play, dimension values are read-only. Pending settlement actions appear above the conversation and offer retry or explicit skip; free value editing and manual settlement are available in the debug session-data view. Entry labels and player-facing errors use the UI locale.

# World Model

World Model 的只读执行视图包含世界记录、角色 schema、角色与公开的动态维度快照。插件通过 `ctx.world.worldRecord`、`ctx.world.characterSchema`、`ctx.world.characters`、`ctx.world.dimensions` 读取；角色和 schema 的合法上游 proposal 及本 runtime 缓冲写入可物化为执行局部视图。动态维度有独立的回合冻结边界，不能把局部写入预览当成其他 runtime 已可见的公共状态。字段与属主边界见[插件契约](plugins.md#world-model-与数据边界)。

## 角色与角色 schema

世界包可在 `world.yaml` 声明 `characterSchema`，会话创建时写入领域 schema。它包含 `types` 和 `attributes`；`player` 是保留类型，每会话至多一个，其他角色类型由 schema 声明。`character.schema.set` proposal 的 payload 为 `{types, attributes}`，版本由内核递增。角色 `fields` 按当前 schema 校验。世界文件、角色初值和导入示例见[世界数据](world-data.md#世界角色-schema)与[领域角色](world-data.md#领域角色与插件角色卡)。

角色创建与更新走领域 proposal 和工具；角色面板从会话 `session.characters` 读取，角色字段组件从会话 `characterSchema` 读取。插件角色卡可以保留自己的原始蓝图，但不将领域角色镜像到插件 namespace。dimension 的资源 schema 不会自动转换成角色属性；角色、背包、好感和时间继续由各自领域属主维护。

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

回合内公共读取冻结，不因玩家并发手改或 tracker 的局部预览换版；新执行重新读取已提交存储。dimension-context 在本次执行中运行但未成功时，叙事 runtime 被跳过（`dimension-snapshot-unavailable`）；它未被调度时（定向的手动叙事或重试），叙事直接使用执行开始时冻结的已提交快照。`recordAs` export 不替代权威状态库，叙事不能反向依赖 post-turn tracker 的输出。提示词使用预算投影与按需查询，不默认展开全部大行集。

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

Lorebook 使用 `(sessionId, owner, id)` 作为身份，`owner` 可为 world、player 或 plugin。世界导入条目属 world；玩家编辑 API 固定处理 player；插件 `lorebook.upsert` 的归属由 proposal 来源绑定，插件不能覆盖其他 owner 的同 ID 条目。管理 API 和导入目标分别见[Lorebook API](api.md#lorebook)与[世界数据目标](world-data.md#target-uri)。旧数据库中只有 `plugin_id` 的 Lorebook 表不自动升级；开发环境操作见[迁移说明](../guide/env-registry.md#plugin-extension-development-data)。

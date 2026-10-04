# 动态世界维度

本页为能力导览；字段和行为细节以各专业参考页为准：[作者声明与同步](world-data.md#动态世界维度dimensions)、[会话快照与结算](world-model.md#动态维度快照)、[扩展点](extension-points.md#会话世界上下文)、[协议](protocol.md#会话维度事件)、[编辑与恢复 API](api.md#维度编辑与待结算恢复)。

世界声明与会话当前值是两种数据，不互相回退。维度由作者定义任意合法 ID；九类世界资料仅为编辑模板，不是合法键白名单。

```yaml
dimensions:
  study:
    name: 学习进度
    schema: { type: integer, minimum: 0 }
    initialValue: 0
    updateRule: 本轮明确完成一次学习时加一；承诺、回忆和未完成的学习不计入。
```

## 声明与校验

定义形状为 `{name, description?, schema, initialValue, updateRule?}`。支持标量、nullable、嵌套对象、数组及 `additionalProperties` 声明的命名记录。所有初值和提交值都校验同一 schema。

支持的 JSON Schema 字段以 `packages/shared/src/schemas/dimensions.ts` 为准：`type`、`enum`、`const`、`minimum`、`maximum`、`minLength`、`maxLength`、`minItems`、`maxItems`、`items`、`properties`、`required`、`additionalProperties`、`title`（可为 `I18nText`）、`description`、`x-i18n`、`x-enumLabels`（标量枚举成员的显示名，值仍存 ID）。未知关键字明确报错，不忽略约束。声明、规则、JSON 值、批次及查询都有体积/深度/数量预算。

只有显式 `x-i18n: true` 的文本节点可以在世界包里写成 locale map。普通 JSON 的语言形似键、枚举和业务 ID 不会被当作翻译。

**翻译在导入时解析，会话里只存一种语言。** 创建会话（或同步世界数据）时，`initialValue` 里的 `x-i18n` 节点和 `updateRule` 按会话的内容语言解析成普通字符串再写入；缺少该语言时按[统一解析规则](./i18n.md#统一解析规则)回退。插件在游玩中通过 `dimension.initialize` 声明定义时（例如开局时把世界包的声明再提交一次），框架在物化记录前做同样的解析，所以无论走哪条路径，会话里的记录都只有一种语言，重复声明也不会和已导入的记录冲突。会话状态里的维度值、存下的 `initialValue` 和 `updateRule` 都是普通字符串，提交 locale map 会被校验拒绝；模型和玩家修改时也只写一份文本。`name`、`description`、schema 的 `title` 与 `x-enumLabels` 是面板标签，继续保留 locale map，按玩家当前的界面语言显示。此前创建的开发会话若存有 locale map 形式的维度值，需要重新创建。

`world.yaml` inline、`dimensionSources` 单项文件、`covel://world/dimensions → world:metadata.dimensions` 使用同一 definition map。外部同名定义优先于 inline；descriptor 替换最终 map。单项文件内容是完整 definition，不是旧 raw value。

## 会话权威与同步

内核按 `world.dimensions@1` 发现并固定唯一 active provider。受保护的 `plugin_data[_dimensions]` 保存 `{definition,value,version,lastTrackedSource?}`；无新表、无 Lorebook 常量副本。泛用 plugin-data/state-patch 写入不能绕过维度领域提交。

- `dimension.initialize` 只创建缺失记录；重复同定义初始化不重置进度。
- `dimension.update` 是整批、必填 expectedVersion 的 CAS，未知 ID、坏值或任一版本冲突全批不写。
- Memory、SQLite、PostgreSQL 实现同一条件批写；PG 在事务内锁定 session 行。值与成功回执同事务提交。
- 各种作者入口都进入 import ledger。未变作者源保留会话进度；修改/删除已演化、手改或待结算维度报告 conflict，即使 `force` 也不重置。
- `sync-dimensions` 只同步维度，不能修改 Lorebook、角色或其他插件数据。没有 descriptor 的文件世界也可同步 inline/external 声明。

## 冻结读取与维护

pre-turn 的 function publisher 不调用模型，发布 Sₙ；本轮 `ctx.world.dimensions.<id>.value`、公共 builtin 查询和有预算的提示投影读取相同冻结状态，不读取 pending proposals，也不回退作者初值。提交后 API/UI 发布 Sₙ₊₁。

`world-dimension-list` 发现 ID/名称/类型/版本；`world-dimension-get` 接收 `{queries:[{dimension,path?,offset?,limit?,expectedVersion?}]}`，支持 dot/brackets、JSON Pointer 和 Unicode 分页。二者是跨插件可用的只读 builtin。完整值不全量注入模型，省略内容通过分页查询。维护 runtime 的 self-only `<dimension-rules>` 段在 24000 字符预算内直接给出每个有规则维度的完整规则、schema 与冻结值，通常一次模型调用即可结算；超出预算的维度才回退到 `dimension-rule-get`（仅在 provider 内按冻结版本分页读取完整规则/schema）与 `world-dimension-get`。维护 runtime 关闭推理（`reasoningEffort: disabled`）。公共快照、故事 segment 和公共查询不含 updateRule/initialValue。

world-init 的 post-turn tracker 以本轮 narrative 为必要来源，WorldIR 为可选辅证。没有非空规则时零维护模型调用，也不强制抽取 WorldIR。已有但失败的共享 WorldIR 不能解释成无变化。

## 回执、恢复与玩家编辑

host 在叙事提交边界独立登记义务，冻结原 `resultId`、`sourceTurnId`、readVersions，以及带非空 updateRule 的 definitions（静态设定不复制进每张回执）。回执不重复存正文；原文来自该来源的持久 turn artifact。状态为 `pending-settlement`、`settled`、`no-change`、`manual`、`skipped`。失败/未运行/跳过调度不是 no-change；自动失败保留叙事及待结算义务，不破坏其他普通 proposal 的全执行回滚语义。tracker 的模型调用在超时/瞬时错误时自动重试一次（`maxRetries: 1`），仍失败才留下待结算。下一次依赖叙事在义务解决前被阻止。

玩家通过 snapshot 受信 recovery metadata 使用既有 runtime RPC：

- 普通编辑、明确人工处理/跳过调用 `editorRuntimeId`，使用同一 `dimension.update` 和 expectedVersion。
- 原源重试直接调用 `trackerRuntimeId`，携带 `retryFromTurnId`。仅同时有 sourceTurnId 和 retrySeedResults 的显式重试可以解析冻结源 IO；普通 manual 调用没有 turn bindings。scoped recovery 不开放 recursiveCall。
- 终态回执阻止再次补算；手改不会隐式解除 pending。冲突使用稳定 `dimension-version-conflict` 和当前版本，客户端刷新后明确重试，不自动 rebase。

`dimensions.changed` 只发布已提交公共值；`dimensions.settlement.changed` 单独发布回执状态。通知在事务提交后发送，版本单调合并；订阅恢复读取权威快照。`SessionSnapshot.dimensions` 必填，provider/recovery 元数据由 host 验证，不接受 plugin-data 自报权限。

通用会话面板按 schema 显示标量/字段/记录，编辑普通字段与增删允许的行；复杂嵌套值提供相同校验的 JSON 入口。编辑版本在打开编辑器时冻结。世界编辑器编辑 definitions，不把世界声明更新当作玩家当前值更新。

BrowserVault 以现有 FIFO 工作区和原子 checkpoint 保留记录、版本、回执与 ledger；仅 pristine setup checkpoint 没有保护记录/ledger 时初始化声明。restore/fork 不重置已有状态，不新增 IndexedDB DataStore。

## 边界与开发数据

inventory 的 add/remove/equip 继续由库存插件独占，affinity、characters、world-time 同理；不迁移或双写到维度。通用记录 schema 能表达物品行不等于已适配库存操作，未来迁移须切换唯一所有者。

本期不实现 #97 隐秘事件触发，不声称能安全隐藏事件载荷。**BREAKING CHANGE：旧 raw dimensions、世界词条副本及旧会话/浏览器 checkpoint 要重建；无迁移、双读写或旧格式兼容。**

详见各参考页：[世界声明与导入](world-data.md)、[World Model](world-model.md)、[插件](plugins.md)、[扩展点](extension-points.md)、[工具](tools.md)、[API](api.md)、[协议](protocol.md)、[事务](transactions.md)、[提示词结构](prompt-structure.md)。

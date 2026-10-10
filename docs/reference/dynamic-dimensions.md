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

支持的 JSON Schema 字段以 `packages/shared/src/schemas/dimensions.ts` 为准：`type`、`enum`、`const`、`minimum`、`maximum`、`minLength`、`maxLength`、`minItems`、`maxItems`、`items`、`properties`、`required`、`additionalProperties`、`title`（可为 `I18nText`）、`description`、`x-i18n`、`x-enumLabels`（标量枚举成员的显示名，值仍存 ID）、`x-derive`（[由时钟推导的字段](#由时钟推导的字段)）。未知关键字明确报错，不忽略约束。声明、规则、JSON 值、批次及查询都有体积/深度/数量预算。

只有显式 `x-i18n: true` 的文本节点可以在世界包里写成 locale map。普通 JSON 的语言形似键、枚举和业务 ID 不会被当作翻译。

**翻译在导入时解析，会话里只存一种语言。** 创建会话（或同步世界数据）时，`initialValue` 里的 `x-i18n` 节点和 `updateRule` 按会话的内容语言解析成普通字符串再写入；缺少该语言时按[统一解析规则](./i18n.md#统一解析规则)回退。插件在游玩中通过 `dimension.initialize` 声明定义时（例如开局时把世界包的声明再提交一次），框架在物化记录前做同样的解析，所以无论走哪条路径，会话里的记录都只有一种语言，重复声明也不会和已导入的记录冲突。会话状态里的维度值、存下的 `initialValue` 和 `updateRule` 都是普通字符串，提交 locale map 会被校验拒绝；模型和玩家修改时也只写一份文本。`name`、`description`、schema 的 `title` 与 `x-enumLabels` 是面板标签，继续保留 locale map，按玩家当前的界面语言显示。此前创建的开发会话若存有 locale map 形式的维度值，需要重新创建。

`world.yaml` inline、`dimensionSources` 单项文件、`covel://world/dimensions → world:metadata.dimensions` 使用同一 definition map。外部同名定义优先于 inline；descriptor 替换最终 map。单项文件内容是完整 definition，不是旧 raw value。

## 由时钟推导的字段

有些值是世界时钟的函数：倒计时、期限、随时间推进的阶段。在字段的 schema 节点上写 `x-derive`，这个值就由代码计算，不经过模型：

```yaml
crownfire:
  name: Crownfire Countdown
  schema:
    type: object
    properties:
      minutesRemaining:
        type: integer
        minimum: 0
        maximum: 180
        x-derive:
          source: clock.elapsedSinceStart
          start: 180
          perUnit: -1
          min: 0
          max: 180
      stage:
        type: string
        enum: [distant, approaching, imminent, overhead]
        x-derive:
          source: clock.elapsedSinceStart
          start: 180
          perUnit: -1
          min: 0
          ranges:
            - { from: 121, value: distant }
            - { from: 31, value: approaching }
            - { from: 1, value: imminent }
            - { value: overhead }
      frontPassed:
        type: boolean
    required: [minutesRemaining, stage, frontPassed]
    additionalProperties: false
  initialValue: { minutesRemaining: 180, stage: distant, frontPassed: false }
  updateRule: Set frontPassed to true only when the narrative says the storm front has moved on.
```

| 字段      | 必填 | 说明                                                                                                                                                   |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`  | yes  | 目前只有 `clock.elapsedSinceStart`：世界时钟自开局以来经过的基础单位数（日历制是分钟，阶段制是阶段），见 [World time](world-time.md#runtime-and-state) |
| `start`   | no   | `source` 为 0 时的数，默认 0                                                                                                                           |
| `perUnit` | no   | `source` 每增加 1，数增加多少；倒计时写负数。默认 1                                                                                                    |
| `min`     | no   | 数的下限                                                                                                                                               |
| `max`     | no   | 数的上限                                                                                                                                               |
| `ranges`  | no   | 把数换成标签：从上到下第一个包含这个数的区间给出 `value`。`from`、`to` 都是闭区间端点，可省略；最后一项不写端点，接住前面没有覆盖的数                  |

数等于 `start + perUnit × source`，再限制在 `min`、`max` 之间。没有 `ranges` 时值就是这个数（`integer` 字段四舍五入）；有 `ranges` 时值是区间给出的标签。没有表达式语言，世界文件里不写代码。

校验（`pnpm validate:world`、导入和提交用同一份 schema）：

- `x-derive` 只能写在维度值本身，或只经 `properties` 到达的属性上；数组元素和 `additionalProperties` 的命名记录没有固定位置，不能推导。
- 字段要有单一的标量类型。`number` / `integer` 可以不写 `ranges`；`string`、`boolean` 必须写 `ranges`，且每个 `value` 都是该字段允许的值（类型、`enum`、`const`）。`x-i18n` 文本不能推导。
- 字段写了 `minimum` / `maximum` 时，`min` / `max` 必须落在其中，算出的数才不会被字段自己的约束拒绝。
- `initialValue` 里这个字段必须等于 `source` 为 0 时的值：开局时还没有任何回合去计算它。
- 整个值都由推导给出的维度不能再写 `updateRule`。

**计算在哪里发生。** `world-init/dimension-clock` 是 post-turn 的 function runtime，通过契约 `world-time-evolution@1` 读取本轮结算后的时钟，对每个带 `x-derive` 的维度算出新值，值有变化时提交一条带版本的 `dimension.update`（不是叙事结算，不占用回执）。它排在时间结算和 tracker 之后（`schedule.after`），读到的值已经带上 tracker 本轮的更新，只改其中的推导字段，两者不会从同一版本写同一个维度；不调用模型，不增加回合耗时。同一回合提交后，面板和下一回合的叙事读到的就是时钟对应的值。值只取决于时钟读数，不取决于上一个值：重跑一个回合、从较早的回合分叉、或某一回合时间没有结算，之后算出的值都与时钟一致。会话里没有提供该契约的插件时，推导字段保持初值。

**模型不写推导字段。** tracker 看到的 schema 和冻结值里没有这些字段；`update-dimensions` 收到的值无论是否带着它们，写入时都保留当前值。一个维度可以同时有推导字段和由 `updateRule` 维护的字段（上例的 `frontPassed`）。只有推导字段、没有 `updateRule` 的维度不产生模型调用，但仍算作随回合变化的维度，进入叙事提示词的回合段。玩家通过 `edit-dimensions` 改动推导字段不会被拒绝，时钟下一次走动时会被重新算出的值覆盖。

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

tracker 还通过可选输入 `world-time-evolution@1` 读取本轮结算之后的世界时钟（`runtime-inputs.worldTime.value`：显示文本 `display`、基础单位 `unit`、开局以来经过的 `elapsedSinceStart` 和本轮经过的 `elapsedThisTurn`，见 [World time](world-time.md#runtime-and-state)）。这条输入让 tracker 排在时间结算之后，读到的是本轮的时钟，不是上一轮的。能写成时钟的线性函数或分段标签的值（倒计时、期限、阶段）用 [`x-derive`](#由时钟推导的字段) 声明，由代码计算。不能这样表达、但仍取决于时间的规则（例如取决于当前状态的每小时消耗）应把规则写成时钟的函数，按 `elapsedThisTurn` 结算，而不是“减去正文花掉的时间”：正文不提时间的回合，后一种写法不会更新。没有提供该契约的插件、或本轮时间未能结算时，tracker 照常运行，只是没有时钟可读。

模型在“本回合什么都没发生”时倾向于直接提交空结果，倒计时就停在原地。为此 `update-dimensions` 要求模型在 `followsClock` 里列出规则取决于时间的维度；时钟在本轮走动时，列出的维度在 `updates` 里缺一条，这次提交就被拒绝并带回时钟，模型再提交一次（见 [update-dimensions](tools.md#update-dimensions)）。`followsClock` 只管由模型结算的规则；`x-derive` 字段由代码计算，不需要也不应列入。

tracker 的提示词和 `dimension-rule-get` 给出每个维度的规则、schema 和冻结值：规则和 schema 在 system prompt 的 `<dimension-rules>` 里，整局不变；冻结值在回合上下文的 `<dimension-values>` 里（见 [Prompt 结构](prompt-structure.md#记账-runtime-的布局)）。给它看的 schema 里，文本字段的 `maxLength` 是作者所写值的 80%：模型不会数字数，按上限写经常多出几个到几十个字，整次提交被拒后还要再调一次模型；留出余量后，写得略超也仍在作者的上限以内。写入时校验的始终是作者写的上限。`update-dimensions` 每条更新的 `expectedVersion` 由工具取本次执行读到的版本，不由模型填写。

## 回执、恢复与玩家编辑

host 在叙事提交边界独立登记义务，冻结原 `resultId`、`sourceTurnId`、readVersions，以及带非空 updateRule 的 definitions（静态设定不复制进每张回执）。回执不重复存正文；原文来自该来源的持久 turn artifact。状态为 `pending-settlement`、`settled`、`no-change`、`manual`、`skipped`。失败/未运行/跳过调度不是 no-change；自动失败保留叙事及待结算义务，不破坏其他普通 proposal 的全执行回滚语义。tracker 的模型调用在超时/瞬时错误时自动重试（`maxRetries: 3`；单次调用上限 60 秒、runtime 上限 120 秒，所以卡住不返回的调用只够再试一次，很快返回的失败最多再试三次），仍失败才留下待结算。待结算会挡住之后的回合，所以这里宁可多试。下一次依赖叙事在义务解决前被阻止。已解决的回执每个会话只保留最近 20 条（登记新回执时清理更早的），待结算的回执不会被清理。

玩家通过 snapshot 受信 recovery metadata 使用既有 runtime RPC：

- 普通编辑、明确人工处理/跳过调用 `editorRuntimeId`，使用同一 `dimension.update` 和 expectedVersion。
- 原源重试直接调用 `trackerRuntimeId`，携带 `retryFromTurnId`。仅同时有 sourceTurnId 和 retrySeedResults 的显式重试可以解析冻结源 IO；普通 manual 调用没有 turn bindings。scoped recovery 不开放 recursiveCall。
- 终态回执阻止再次补算；手改不会隐式解除 pending。冲突使用稳定 `dimension-version-conflict` 和当前版本（提交失败的 proposal 以 `code` 字段携带它，宿主不再读错误文字），客户端刷新后明确重试，不自动 rebase。

`dimensions.changed` 只发布已提交公共值；`dimensions.settlement.changed` 单独发布回执状态。通知在事务提交后发送，版本单调合并；订阅恢复读取权威快照。`SessionSnapshot.dimensions` 必填，provider/recovery 元数据由 host 验证，不接受 plugin-data 自报权限。

通用会话面板按 schema 显示标量/字段/记录，编辑普通字段与增删允许的行；复杂嵌套值提供相同校验的 JSON 入口。编辑版本在打开编辑器时冻结。世界编辑器编辑 definitions，不把世界声明更新当作玩家当前值更新。

BrowserVault 以现有 FIFO 工作区和原子 checkpoint 保留记录、版本、回执与 ledger；仅 pristine setup checkpoint 没有保护记录/ledger 时初始化声明。restore/fork 不重置已有状态，不新增 IndexedDB DataStore。

## 边界与开发数据

inventory 的 add/remove/equip 继续由库存插件独占，affinity、characters、world-time 同理；不迁移或双写到维度。通用记录 schema 能表达物品行不等于已适配库存操作，未来迁移须切换唯一所有者。

本期不实现 #97 隐秘事件触发，不声称能安全隐藏事件载荷。**BREAKING CHANGE：旧 raw dimensions、世界词条副本及旧会话/浏览器 checkpoint 要重建；无迁移、双读写或旧格式兼容。**

详见各参考页：[世界声明与导入](world-data.md)、[World Model](world-model.md)、[插件](plugins.md)、[扩展点](extension-points.md)、[工具](tools.md)、[API](api.md)、[协议](protocol.md)、[事务](transactions.md)、[提示词结构](prompt-structure.md)。

# 动态世界维度

维度是世界里“会被记录、可能会变”的一项数据，例如学习进度、声望、倒计时。这一页从头到尾讲一遍维度在一局游戏里的经过：怎样声明、怎样校验、每回合怎样读取和更新、更新失败后怎样恢复。

世界作者需要前两节（声明，以及按时钟自动计算的字段）。后面几节面向写插件和排查问题的人。

这一页是总览。各部分的完整规则在这些页面：

| 想查什么                 | 页面                                                     |
| ------------------------ | -------------------------------------------------------- |
| 世界包里怎么写、怎么同步 | [作者声明与同步](./world-data.md#动态世界维度dimensions) |
| 会话里的值和结算状态     | [会话快照与结算](./world-model.md#动态维度快照)          |
| 插件怎样成为负责的一方   | [扩展点](./extension-points.md#会话世界上下文)           |
| 通知事件                 | [协议](./protocol.md#会话维度事件)                       |
| 玩家改值与恢复的接口     | [编辑与恢复 API](./api.md#维度编辑与待结算恢复)          |

先记住两件事：

- 世界包里的**声明**和会话里的**当前值**是两份数据。当前值读不到时，不会改用声明里的初值。
- 维度的 ID 由作者自己起。常见的九类世界资料（地理、势力等）只是编辑器里的模板，不是允许的 ID 清单。

```yaml
dimensions:
  study:
    name: 学习进度
    schema: { type: integer, minimum: 0 }
    initialValue: 0
    updateRule: 本轮明确完成一次学习时加一；承诺、回忆和未完成的学习不计入。
```

## 声明与校验

一项声明的形状是 `{name, description?, schema, initialValue, updateRule?}`。

- `schema` 可以是标量、可空的值、嵌套对象、数组，或者用 `additionalProperties` 声明的一组有名字的记录。
- 初值和之后每次提交的值都用同一个 schema 校验。

**支持的 schema 关键字**以 `packages/plugin-handlers-utils/src/dimension-schemas.ts` 为准：

- `type`、`enum`、`const`
- `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`
- `minLength`、`maxLength`
- `minItems`、`maxItems`、`items`
- `properties`、`required`、`additionalProperties`
- `title`（可以翻译）、`description`
- `x-i18n`
- `x-enumLabels`：标量枚举成员的显示名，值仍然存 ID
- `x-derive`：[由时钟推导的字段](#由时钟推导的字段)

写了不认识的关键字会明确报错，不会被忽略。声明、规则、值、一批更新和查询都有体积、深度和数量的上限，具体数字见[值校验与本地化](./world-data.md#值校验与本地化)。

**翻译。** 只有明确标了 `x-i18n: true` 的文本节点，可以在世界包里按语言分别写。普通 JSON 里长得像语言代码的键、枚举值和业务 ID 不会被当作翻译。

**会话里只存一种语言。**

- 创建会话或同步世界数据时，`initialValue` 里的 `x-i18n` 节点和 `updateRule` 按会话的内容语言变成普通字符串，再写入。缺少该语言时按[统一解析规则](./i18n.md#统一解析规则)回退。
- 插件在游玩中通过 `dimension.initialize` 声明维度时（例如开局时把世界包的声明再提交一次），框架做同样的处理。所以不管走哪条路，会话里的记录都只有一种语言，重复声明也不会和已导入的记录冲突。
- 会话里的维度值、存下的 `initialValue` 和 `updateRule` 都是普通字符串。提交多语言对照会被校验拒绝。模型和玩家修改时也只写一份文本。
- `name`、`description`、schema 的 `title` 与 `x-enumLabels` 是面板上的标签，继续保留各种语言，按玩家当前的界面语言显示。

> [!NOTE]
> 开发会话里如果存有多语言对照形式的维度值，需要重新创建这个会话。

**两种写法用同一种声明格式**：写在 `world.yaml` 里，或者写成整张表的维度文件 `data/dimensions.yaml`（`covel://world/dimensions → world:metadata.dimensions`）。

- 维度文件替换 `world.yaml` 里的整张表。
- 每一项的内容都是一项完整的声明，不是一个值。

## 由时钟推导的字段

有些值只取决于世界时间：倒计时、期限、随时间推进的阶段。在字段的 schema 上写 `x-derive`，这个值就由代码计算，不经过模型：

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

这个例子里，`minutesRemaining` 从 180 开始，世界时间每过一分钟减 1，减到 0 为止。`stage` 用同一个数换成四个标签之一。`frontPassed` 没有 `x-derive`，由模型按 `updateRule` 维护。

| 字段      | 必填 | 说明                                                                                                                                                     |
| --------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | yes  | 目前只有 `clock.elapsedSinceStart`：世界时钟自开局以来经过的基础单位数（日历制是分钟，阶段制是阶段），见 [World time](./world-time.md#runtime-and-state) |
| `start`   | no   | `source` 为 0 时的数，默认 0                                                                                                                             |
| `perUnit` | no   | `source` 每增加 1，数增加多少；倒计时写负数。默认 1                                                                                                      |
| `min`     | no   | 数的下限                                                                                                                                                 |
| `max`     | no   | 数的上限                                                                                                                                                 |
| `ranges`  | no   | 把数换成标签：从上到下第一个包含这个数的区间给出 `value`。`from`、`to` 都是闭区间端点，可省略；最后一项不写端点，接住前面没有覆盖的数                    |

**怎么算：**

1. 数 = `start + perUnit × source`。
2. 把它限制在 `min` 和 `max` 之间。
3. 没有 `ranges` 时，值就是这个数（`integer` 字段四舍五入）。有 `ranges` 时，值是区间给出的标签。

没有表达式语言，世界文件里不写代码。

**校验**（`pnpm validate:world`、导入和提交用的是同一份）：

- `x-derive` 只能写在维度值本身，或者只经过 `properties` 就能到达的属性上。数组的元素和 `additionalProperties` 的记录没有固定的位置，不能推导。
- 字段要有单一的标量类型：
  - `number` / `integer` 可以不写 `ranges`；
  - `string`、`boolean` 必须写 `ranges`，并且每个 `value` 都是这个字段允许的值（类型、`enum`、`const`）；
  - `x-i18n` 的文本不能推导。
- 字段写了 `minimum` / `maximum` 时，`min` / `max` 必须落在其中。这样算出的数才不会被字段自己的约束拒绝。
- `initialValue` 里这个字段必须等于 `source` 为 0 时的值，因为开局时还没有任何回合去计算它。
- 整个值都由推导给出的维度不能再写 `updateRule`。

**计算在哪里发生。** 由 `world-init/dimension-clock` 完成。它是一个不调用模型的 runtime，在每回合叙事之后运行，不增加模型调用。

- 它读取本回合结算之后的时钟（契约 `world-time-evolution@1`），给每个带 `x-derive` 的维度算出新值。值有变化时提交一条带版本的 `dimension.update`。这不是叙事结算，不占用结算回执。
- 它排在时间结算和 tracker（按规则更新维度的那个模型）之后。读到的值已经带上 tracker 本回合的更新，它只改其中的推导字段。所以两者不会从同一个版本去写同一个维度。
- 同一回合保存之后，面板和下一回合的叙事读到的就是时钟对应的值。
- 值只取决于时钟的读数，不取决于上一个值。重跑一个回合、从较早的回合分叉、或者某一回合时间没有结算，之后算出的值都和时钟一致。
- 这局游戏里没有插件提供这个契约时，推导字段保持初值。

**模型不写推导字段。**

- tracker 看到的 schema 和值里没有这些字段。`update-dimensions` 收到的值不管带不带它们，写入时都保留当前值。
- 一个维度可以同时有推导字段和由 `updateRule` 维护的字段（上例的 `frontPassed`）。
- 只有推导字段、没有 `updateRule` 的维度不产生模型调用。但它仍然算作“随回合变化”的维度，会进入叙事提示词里每回合更新的那一段。
- 玩家通过 `edit-dimensions` 改动推导字段不会被拒绝。时钟下一次走动时，它会被重新算出的值覆盖。

## 会话权威与同步

**谁负责、存在哪里。** 内核按契约 `world.dimensions@1` 找到唯一启用的提供者，并在这局游戏里固定下来。每个维度是受保护区域 `plugin_data[_dimensions]` 里的一条 `{definition,value,version,lastTrackedSource?}` 记录。没有新的数据库表，也没有资料库里的常驻副本。通用的插件数据写入不能修改它。

**两种写入：**

- `dimension.initialize` 只创建还没有的记录。用同样的声明重复初始化不重置进度。
- `dimension.update` 是整批的，每条都必须带 `expectedVersion`。有未知的 ID、不合法的值，或任何一条版本对不上，整批都不写。
- 三种数据库后端（内存、SQLite、PostgreSQL）行为相同；PostgreSQL 在事务里锁住会话这一行。值和成功的回执在同一个事务里保存。

**和世界包同步：**

- 不管用哪种写法声明，都记进导入账本。
- 作者的声明没变时，保留这局游戏的进度。
- 修改或删除一个已经演化、被手改过、或者还有待结算回合的维度，会报告冲突。用 `force` 也不会重置它。
- `sync-dimensions` 只同步维度，改不了资料库、角色或其他插件数据。写在 `world.yaml` 里和维度文件里的声明都可以用它同步。

完整的同步规则见 [Preflight 与 Sync](./world-data.md#preflight-与-sync)。

## 冻结读取与维护

**公共读取使用冻结底本。** 回合开始时，一个不调用模型的 runtime 发布上一回合结束时的值（记作 Sₙ）。`world.dimensions@1` 输入、公共内置查询和叙事提示词摘要都使用这份底本，不读取尚未提交的更新，也不改用作者的初值。

function / guard 的 `ctx.world.dimensions` 在这份底本上叠加已完成上游和当前 runtime 自己的合法维度 proposal，供后续计算。例如 `dimension-clock` 能在 tracker 的提案之上计算时钟字段。这只是执行内的投影视图，不表示已经保存。提交之后，接口和界面才得到新的权威值（Sₙ₊₁），见 [World Model](./world-model.md)。

**两个只读的内置工具**，所有插件都可以用：

- `world-dimension-list`：列出 ID、名称、类型和版本。
- `world-dimension-get`：参数是 `{queries:[{dimension,path?,offset?,limit?,expectedVersion?}]}`。`path` 支持点号和方括号的写法，也支持 JSON Pointer。结果可以分页，分页按 Unicode 字符计。

完整的值不会全部放进提示词，省略的内容用分页查询。公共的读取（快照、故事提示词段、公共查询）都不含 `updateRule` 和 `initialValue`。

**维护用的模型（tracker）读到什么。** `world-init` 的 tracker 在叙事之后运行。

- 它必须有本回合的叙事。WorldIR 抽取是可选的旁证。
- 没有任何非空规则时，没有维护用的模型调用，也不会为此强制运行 WorldIR 抽取。
- WorldIR 抽取存在但失败了，不能理解成“没有变化”。
- 规则和 schema 放在它的 system prompt 的 `<dimension-rules>` 段里，整局不变。冻结的值放在回合上下文的 `<dimension-values>` 里（见 [Prompt 结构](./prompt-structure.md#记账-runtime-的布局)）。
- `<dimension-rules>` 的预算是 24000 字符。预算内直接给出每个有规则的维度的完整规则和 schema，通常一次模型调用就能结算。放不下的维度才改用 `dimension-rule-get`（只在负责的插件内部可用，按冻结的版本分页读完整的规则和 schema）和 `world-dimension-get`。
- tracker 关闭了推理（`agent.reasoning: false`）。
- `update-dimensions` 每条更新的 `expectedVersion` 由工具取这次执行读到的版本，不由模型填写。

**文本长度留了余量。** 给 tracker 看的 schema 里，文本字段的 `maxLength` 是作者所写值的 80%。原因是模型不会数字数，按上限写经常多出几个到几十个字，整次提交被拒之后还要再调用一次模型。留出余量后，写得略超也仍然在作者的上限以内。写入时校验的始终是作者写的上限。

**tracker 读得到世界时钟。** 它有一个可选输入 `world-time-evolution@1`，内容是本回合结算**之后**的时钟（`runtime-inputs.worldTime.value`）：

| 字段                | 含义                     |
| ------------------- | ------------------------ |
| `display`           | 显示用的时间文本         |
| `unit`              | 基础单位                 |
| `elapsedSinceStart` | 开局以来经过的基础单位数 |
| `elapsedThisTurn`   | 本回合经过的基础单位数   |

详见 [World time](./world-time.md#runtime-and-state)。这个输入让 tracker 排在时间结算之后，所以它读到的是本回合的时钟，不是上一回合的。没有插件提供这个契约，或者本回合时间没能结算时，tracker 照常运行，只是没有时钟可读。

**取决于时间的规则怎么写：**

- 能写成时钟的线性函数或分段标签的值（倒计时、期限、阶段），用 [`x-derive`](#由时钟推导的字段)，由代码计算。
- 不能这样表达、但仍取决于时间的规则（例如取决于当前状态的每小时消耗），把规则写成时钟的函数，按 `elapsedThisTurn` 结算。
- 不要写成“减去正文花掉的时间”。正文没有提到时间的回合，这种写法不会更新。

**防止倒计时停住。** 模型在“这一回合什么都没发生”时倾向于直接提交空结果，倒计时就停在原地。所以 `update-dimensions` 要求模型在 `followsClock` 里列出规则取决于时间的维度。时钟在本回合走动了，而列出的维度在 `updates` 里缺一条，这次提交就被拒绝并带回时钟，模型再提交一次（见 [update-dimensions](./tools.md#update-dimensions)）。`followsClock` 只管由模型结算的规则。`x-derive` 字段由代码计算，不需要也不应该列进去。

## 回执、恢复与玩家编辑

**回执。** 叙事保存的时候，宿主登记一条“这一回合的维度待结算”，并记下：原来的 `resultId`、`sourceTurnId`、当时读到的各维度版本（`readVersions`），以及带非空 `updateRule` 的声明。没有规则的静态设定不会复制进每张回执。回执不重复保存正文，原文从那一回合保存下来的结果里读。

状态有五种：`pending-settlement`、`settled`、`no-change`、`manual`、`skipped`，含义见[回合时序与结算回执](./world-model.md#回合时序与结算回执)。

- 失败、没有运行、被调度跳过都不是 `no-change`。
- 自动结算失败时，叙事和待结算义务保留。其他 proposal 按[提交单元](./transactions.md#回合级单事务)隔离：可选单元失败时丢弃该单元及其硬依赖下游，数据库异常仍回滚整次提交。
- 已经解决的回执，每局游戏只保留最近 20 条（登记新回执时清理更早的）。待结算的回执不会被清理。

**tracker 会多试几次。** 待结算会挡住之后的回合，所以这里宁可多试。

- 模型调用超时或遇到瞬时错误时自动重试：`maxRetries: 3`，整个 runtime 最长 120 秒。
- 接了请求却不出字的调用，依次最多等 60、30、15、15 秒（见[插件契约](./plugins.md)的 `agent.loop`）。很快返回的失败最多再试三次。
- 仍然失败才留下待结算。
- 同一回合里别的抽取 runtime 失败不影响结算：tracker 只凭叙事原文就能结算，它成功提交的更新照常生效。

**下一个动作之前自动恢复一次。** 待结算不会让玩家卡在原地。

1. 玩家的下一个动作（`POST /api/actions`，`retry_runtime` / `retry_failed_runtimes` 除外）开始之前，宿主先替玩家做一次和待结算提示里“重试原回合”相同的恢复：以原回合已保存的结果为起点，手动运行 `dimensionRecovery.trackerRuntimeId` 指向的 tracker。
2. 有多条待结算时，按来源回合从早到晚逐条处理。结果写入服务器日志（`[dimension-settlement]`）。
3. 这次重试成功，回合照常进行。
4. 仍然失败才阻止这一回合。错误文字告诉玩家：在待结算提示里重试或跳过之后再发送。

提供维度的是社区插件时不自动重试，因为手动运行需要玩家授权，只能在面板里操作。

**玩家的操作**通过快照里由宿主验证过的恢复信息（recovery metadata），调用已有的 runtime RPC：

- 普通编辑、“已人工处理”和“明确跳过本次结算”调用 `editorRuntimeId`，使用同一种 `dimension.update` 和 `expectedVersion`。
- “重试原回合”直接调用 `trackerRuntimeId`，带上 `retryFromTurnId`。只有同时带着 `sourceTurnId` 和 `retrySeedResults` 的明确重试，才能读到那一回合冻结的输入；普通的手动调用没有回合的输入。恢复用的调用不允许 `recursiveCall`。
- 已经有最终状态的回执不能再补算。手改不会顺带解除待结算。
- 版本冲突使用固定的错误码 `dimension-version-conflict`，并带回当前版本。保存失败的 proposal 用 `code` 字段携带它，宿主不靠解析错误文字来判断。客户端刷新之后由玩家明确重试，不自动合并。

**通知。**

- `dimensions.changed` 只发布已保存的公共值。
- `dimensions.settlement.changed` 单独发布回执状态。
- 通知在事务保存之后才发送，按版本只前进不后退。订阅断开重连后，读取权威的快照。
- `SessionSnapshot.dimensions` 是必有的字段。负责的插件和恢复信息由宿主验证，插件不能靠自己写的数据声称有这些权限。

**界面。**

- 通用的会话面板按 schema 显示标量、字段和记录；可以编辑普通字段，增删 schema 允许的行。复杂的嵌套值提供一个 JSON 入口，校验相同。
- 编辑依据的版本在打开编辑器时固定。
- 世界编辑器改的是声明。修改世界的声明不等于修改某一局游戏的当前值。

**浏览器本地存储。** 浏览器私有存储（BrowserVault）用已有的工作区和原子存档点保留记录、版本、回执和导入账本。只有一个全新的、还没有任何维度记录和账本的开局存档点，才会按声明初始化。恢复和分叉不重置已有的状态。

## 边界与开发数据

- 物品的增加、移除和装备仍然只归库存插件管。好感、角色、世界时间也各归各的插件。它们不会迁移到维度里，也不会两边各存一份。
- 维度的 schema 能表达“一行行物品”，不等于它能代替库存操作。将来要迁移，必须把唯一的负责方切换过去。
- 维度不负责隐藏事件的触发，也不保证事件内容保密。

> [!IMPORTANT]
> 早期“只写一个值”的维度、资料库里的维度副本，以及那时的会话和浏览器存档点都要重新创建。没有迁移，也没有旧格式的兼容读取。

相关页面：[世界声明与导入](./world-data.md)、[World Model](./world-model.md)、[插件](./plugins.md)、[扩展点](./extension-points.md)、[工具](./tools.md)、[API](./api.md)、[协议](./protocol.md)、[事务](./transactions.md)、[提示词结构](./prompt-structure.md)。

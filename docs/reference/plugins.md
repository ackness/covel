# 插件契约参考

Covel 的插件包以根 `PLUGIN.md` 声明身份、版本化契约和贡献，以可选 runtime 执行业务。框架提供存储、事务、调度、工具执行和扩展点；业务含义由插件提供。内置实现以 [plugins/](../../plugins/) 为准，可选插件见[官方社区仓库](https://github.com/covel-ai/covel-plugins)。

当前只支持本页格式。旧平铺 manifest、子目录 `PLUGIN.md`、角色镜像及旧 checkpoint 开发数据需要重新生成，不提供迁移读取或双写。

## 包与运行时文件

```text
example/
├── package.json
├── README.md
├── PLUGIN.md
├── PLUGIN.en.md
├── server/index.js
├── schemas/
├── ui/
└── runtimes/
    └── extract/
        ├── RUNTIME.md
        ├── RUNTIME.en.md
        └── handler.js
```

根文件必需，`id` 必须匹配包目录。单 runtime 放在根 `runtime`，其提示词就是根文件正文；多 runtime 放在 `runtimes/<id>/RUNTIME.md`，逻辑 ID 为 `<pluginId>/<id>`，提示词为各自文件正文。两种布局不能混用，子 runtime 不能声明包级贡献。只有 entry/UI/扩展的包可以没有 runtime。

作者 JSON Schema：

- [plugin-manifest.schema.json](../../packages/shared/schemas/plugin-manifest.schema.json)
- [runtime-manifest.schema.json](../../packages/shared/schemas/runtime-manifest.schema.json)

加载器会编译成内部执行结构。内部 `RuntimeManifest` 字段不是作者格式，不能复制到 `PLUGIN.md` 根层。

## 根 PLUGIN.md

```yaml
---
id: example
kind: plugin
displayName: Example
description: Records useful facts after each story turn.
provides: [example.facts@1]
requires: [narrative-engine@1]
entry: ./server/index.js
contributes:
  tools: [save-facts]
  data:
    facts:
      version: 1
      schema: ./schemas/facts.schema.json
runtime:
  type: agent
  schedule:
    stage: post-turn
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1, cardinality: one }
        select: /narrativeOutput
        required: true
    output: { contract: example.facts@1 }
    visibility: plugin
  agent:
    model: plugin
    tools:
      plugin: [save-facts]
    loop:
      completion: { require: tool-use, afterTools: [save-facts] }
---
Extract facts supported by runtime-inputs.narrative.value, then call save-facts.
```

| 根字段                                          | 含义                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| `id`, `kind`                                    | 包身份；`kind` 为 `core` 或 `plugin`                   |
| `version`, `displayName`, `description`, `tags` | 元数据；不再使用 `role:*` 标签驱动业务                 |
| `provides`                                      | 版本化契约字符串，或 `{contract, default: true}`       |
| `requires`                                      | 必需契约，解析器补入提供者                             |
| `optional`                                      | 可选契约，不强制激活提供者                             |
| `conflicts`                                     | 与提供这些契约的其他插件互斥                           |
| `contracts`                                     | `{contractId: {schema: ./path.json}}` 契约 schema 声明 |
| `entry`                                         | 包根相对的注册模块路径                                 |
| `contributes`                                   | 下表列出的包级贡献                                     |
| `runtime`                                       | 可选的单 runtime 声明                                  |

契约 ID 形如 `narrative-engine@1`。`runtime.io.output.contract` 必须由本包 `provides` 声明，同包不允许两个 runtime 产出同一契约。跨包可以有多个普通提供者，消费者使用 `cardinality: one` 或 `all` 表达选择要求。单提供者扩展点及显式 `conflicts` 另外执行互斥检查。`conflicts` 只允许插件契约；引用内核扩展点或 UI 槽位会得到 `invalid-conflict` 和 `conflicts` 字段位置，内核点的组合由 mode 决定。

### 契约版本策略

契约 ID 中的 `@N` 是版本标识（如 `narrative-engine@1`）。内核采用 **current-only** 策略：只承载当前契约版本，不做版本协商，不同时支持多个版本，也不提供跨版本兼容读取或双写迁移。

- 破坏性变更使用新的契约 ID（例如 `@2`），提供者与消费者在同一个变更中同步升级，旧版本随即失效
- 旧会话快照和排队作业需要重建
- 变更记录在 CHANGELOG 和相关 PR 的迁移说明中

外部插件作者应跟踪框架的 CHANGELOG，在契约变更后同步升级并更新声明的契约版本。

| `contributes` 字段 | 对应注册或资源                                   |
| ------------------ | ------------------------------------------------ |
| `tools`            | `registerTool` 的工具名                          |
| `actions`          | `registerRpc` 的 action 名                       |
| `commands`         | 玩家命令元数据；`action` 必须列入 `actions`      |
| `services`         | `registerService` 的契约 ID                      |
| `extensions`       | `provideExtension` 的 `{point, id}`              |
| `hooks`            | hook 的 `{event, enforce}` 声明                  |
| `wires`, `forms`   | 对应注册 ID                                      |
| `events`           | 插件事件契约                                     |
| `settings`         | 玩家配置项，运行时通过 `ctx.userSettings` 读取   |
| `data`             | 本插件数据 namespace 的 schema、version、accepts |
| `ui`               | 包根相对的 `right/message/left` UI spec 路径     |
| `worldProjections` | 世界数据投影声明                                 |
| `prompt`           | 静态提示词段                                     |

entry 注册与清单双向校验，未声明的注册和未实现的声明都会失败。包级贡献只有根文件拥有，不合并子 runtime 字段。

## Runtime 分组字段

| 字段          | 主要配置                                                      |
| ------------- | ------------------------------------------------------------- |
| `type`        | `agent` 或 `function`                                         |
| `schedule`    | `stage`, `trigger`, `needs`, `after`, `completion`, `manual`  |
| `io`          | `inputs`, `selfData`, `payloadSchema`, `output`, `visibility` |
| `agent`       | `model`, `llm`, `tools`, `advertiseEvents`, `loop`            |
| `function`    | `handler`、可选 `timeoutMs` 和 `tools`                        |
| `guard`       | runtime 相对的 guard 模块                                     |
| `effects`     | 读写资源与 `parallelSafe`                                     |
| `permissions` | 执行权限声明                                                  |

Function runtime 必须声明 `function.handler`，模块必须默认导出函数，不能同时配置 `agent`。Agent runtime 不能配置 `function`。

`schedule.needs`、`schedule.after` 与 `io.inputs.*.from.runtime` 中的 runtime ID 只能属于本包（完整 `<pluginId>/<runtimeId>` 或单 runtime 的包 ID），裸字符串依赖也受此限制。跨包引用必须使用公开的版本化 contract；纯 `after` 不会自动激活提供者。

**跨包 runtime 引用边界**：包内 runtime 引用（`needs/after/inputs`）是合理的实现排序和数据流，允许包内使用具体 runtime ID。跨包依赖必须通过契约（`from.contract`）实现，确保提供者可替换，消费者无需修改。加载器对跨包 runtime 引用执行严格校验并拒绝加载。

runtime 的 `schedule.needs[].contract` 和 `io.inputs.*.from.contract` 必须在根 `requires` 或 `optional` 中声明，加载器对内联和子 runtime 同样校验。包内其他 runtime 提供的契约也需声明，可列入 `optional`，无需激活其他插件；`schedule.after` 只排序，`from.kernel` 是内核输入，两者不产生包激活依赖。

阶段按 `setup → pre-turn → narrative → post-turn → audit` 推进，阶段之间有完成屏障。相同阶段的先后由依赖边决定。`needs` 是成功门控，`after` 只表达排序。调度不能用更晚阶段的输出解锁更早阶段。

包级 `requires` 保证契约提供者被激活，不要求每次执行都重新产生输出。需要在后续执行处理表单的 setup runtime 应用 `after` 排在一次性 setup 提供者之后，并读取已提交状态；不要使用默认 turn scope 的契约 `needs`，否则提供者完成 setup 后不再运行，消费者会被成功门控跳过。`after` 不证明初始化成功；消费者 guard 必须检查所需领域状态，例如新建主角前确认 `ctx.world.characterSchema` 已存在，缺失时明确失败，不生成表单或写入角色。

触发类型包括 `auto`、`scheduled`、`manual` 和 `event`。自动主循环运行时应声明 stage；manual/event 可按请求或事件独立触发。`schedule.manual.execution: background` 使用后台执行，`schedule.completion` 控制回合是否等待，具体限制由 manifest 校验和运行时准入执行。

Agent 的超时、重试和步数在 `agent.loop` 中。`completion.afterTools` 可在指定工具成功后结束；`completion.require: tool-use` 要求有效工具调用。Function 工具白名单在 `function.tools`，控制 `ctx.tools.call`；Function 超时在 `function.timeoutMs`，不要把外部服务执行时限放到 agent 配置中。

### 输入和输出

```yaml
io:
  inputs:
    narrative:
      from: { contract: narrative-engine@1, cardinality: one }
      select: /narrativeOutput
      required: true
      accepts: ./schemas/narrative.schema.json
    previous:
      from: { runtime: example/extract }
      scope: committed
      recordAs: latest-facts
      required: false
    digest:
      from: { kernel: turn-digest@1 }
      required: false
  selfData:
    - namespace: facts
      as: <known-facts>
      format: summary
      maxEntries: 50
  output:
    contract: example.facts@1
    schema: ./schemas/output.schema.json
    recordAs: latest-facts
```

普通输入读同一 execution 的已完成上游结果，`select` 为结果值上的 JSON Pointer。跨 execution 读取使用 `scope: committed` 和 `recordAs`。Schema 可以是本地路径或 `contract:<contractId>`；跨提供者契约 schema 在加载时解析。提示词中的绑定位于 `runtime-inputs.<binding>.value`，不要再依赖旧注入标签。

发布 runtime 输出契约时，在根 `contracts.<contractId>.schema` 声明完整输出的公共 schema。同一契约 ID 的所有提供者必须发布一致的 schema；替代插件的 `provides` 与本插件 runtime 的 `io.output.contract` 必须对齐，其他已安装插件的产出不能替它满足声明。缺少被消费契约的 schema 或只有声明而无产出的提供者会产生加载诊断。

内核在 runtime 最终输出边界校验已发布的契约，失败结果不能提交领域 effects 或写入 `recordAs`。同轮输入在应用 `select` 前再次校验完整输出；`scope: committed` 输入读取冻结的完整 export 后同样校验公共契约，即使没有显式 `accepts`。消费者的 `accepts` 可另加限制，不能关闭公共契约校验。契约发生变化时应重建受影响的开发期会话数据和历史 exports。

Function 的输出契约以 handler 返回的 `value` 为准，可以是标量、数组、对象或 `null`；运行时用 `canonicalValue` 单独保存它，`output` 保留供领域提交使用的物化 effects envelope。同轮输入、公共契约校验与 `recordAs` 发布都读取同一业务值。没有提供 `value` 时不发布 export；不要通过猜测 `output.value` 拆箱。Agent 的契约值仍为最终 `output`。普通输入的 `select` 作用于此业务值；committed 输入读取完整 export，不支持 `select`。

`PostRuntime` 若改变 function 的 `output`，应同时明确提供匹配的 `canonicalValue`，新值会重新接受私有和公共 schema 校验。仅改写 `output` 会撤销业务值，停止 export 与下游值绑定；有公共输出契约时还会因缺失契约值而失败。失败 runtime 的输出事件不触发后继 runtime。普通执行与 resume 共用 agent 输出 schema gate。上述契约变化需要重建旧 function 执行结果、exports 和相关开发期快照。

`ctx.playerMessage` 保持当前输入文本字符串。`ctx.session.lastPlayerInput` 是源执行开始时最近一条 `PlayerInputSubmission | null`，包含 `id/sessionId/turnId/formId/values/createdAt`；它可能来自更早回合，不能把存在该记录解释为本回合提交了表单。

内核输入 `turn-digest@1` 冻结同一份 lastPlayerInput 快照及 `runtimeResults`。后者包含已经观察到的终态 `{runtimeId, status}`，status 为 `success/failed/skipped/suspended`；没有把尚未结束的 runtime 预测为成功。detached worker 消费源执行快照，不重新查询最新表单或回合状态。此输入契约更新后，旧作业与快照需要重建，不做兼容读取。

## World Model 与数据边界

角色 schema、角色和世界记录是内核 World Model。`ctx.world.characterSchema`、`ctx.world.characters` 及 `ctx.world.worldRecord` 为只读视图；同一 execution 的合法上游 proposals 和本 runtime 已缓冲 proposals 对后续读取可见。写入通过 proposals，并在提交时统一校验。

角色类型是 schema 中声明的开放字符串；`player` 为保留语义且每个会话最多一个。角色字段遵守 CharacterSchema 的 attributes。修改 schema 的 proposal 为 `character.schema.set`，payload 直接包含 `types`、`attributes`，版本由内核递增。

插件自有持久数据经绑定的 `ctx.store.getPluginData(namespace, key)`、`listPluginData(namespace?)` 访问。插件不能指定任意 sessionId/pluginId 读其他插件私有数据。跨插件公开数据使用契约、服务或扩展，不扫描对方 namespace。

Lorebook 使用 owner 与 id 的复合身份，owner 为 world、plugin 或 player。HTTP 玩家编辑路径只管理 player owner。不要用字符 ID、插件 ID 或任意 namespace 模拟角色表和 Lorebook 归属。

### 世界数据导入

```yaml
contracts:
  example.facts@1:
    schema: ./schemas/facts.schema.json
contributes:
  data:
    facts:
      version: 1
      schema: ./schemas/facts.schema.json
      accepts: [example.facts@1]
```

World Data 的 source 使用 `schema: contract:example.facts@1`、`to: contract:example.facts@1`。框架查找已激活且声明接受该契约的 namespace，验证 schema 后分发数据，不在框架中识别具体插件 ID。`contracts` 与接收 namespace 的 schema 必须一致。完整结构见 [World Data](world-data.md)。

## 提示词与记忆扩展

静态段放在 `contributes.prompt`，每项包含 `id/content/position`，可选 `role`。位置为 `system`、`pre-history`、`post-history` 或 `{depth: number}`。host 自动注册静态段，无需再次声明扩展；`static-prompt` 为保留注册 ID。

动态提示词使用 `prompt.segment@1`，世界上下文使用 `session.world-context@1`，历史变换使用 `prompt.history-transform@1`，历史压缩使用 `history.compact@1`。详见[插件扩展点](plugin-extensions.md)。这些扩展使用同一个 execution 的快照，不在每次调用时重读清单。

记忆块属于 memory 插件：默认定义经 `memory.block-definitions@1` 服务提供，世界自定义定义经 `memory.blocks@1` 数据契约导入。框架不再聚合 `memoryBlocks` 或 `summaryFocus` 字段，也不维护独立 working_memory 表。

## 会话插件选择

`resolveSessionPlugins` 从 `requested`、`excluded`、授权状态和根契约声明计算 `active/autoAdded/rejected`。

- 显式排除优先，core 也不会被恢复。
- 默认提供者在明确提供者激活时退出。
- 必需契约补入提供者；缺失、歧义、冲突与授权不足返回原因。
- 失去必需提供者的插件和孤立自动依赖会被移除。
- `requested` 与计算出的 `active` 分开持久化，自动依赖不会变成用户的显式选择。

世界的 `pluginPolicy` 使用 `presetId/preferredTags/avoidedTags/requested/recommended/packs`；组合包使用 `requested/recommended`。推荐项不自动启用，也不会覆盖玩家显式排除。`GET /api/worlds/:id/plugin-plan` 的 `defaultPluginIds` 是初始显式请求，准备页和创建端再使用同一解析器计算活动集合。

发现 DTO 区分 `kind`、宿主 `hostState` 与会话 `sessionState`，运行时提供 `outputContract`。未授权社区插件可保留在请求列表，但不能进入执行集合；许可绑定会话身份与审批范围。

## 本地化与验证

根翻译使用 `PLUGIN.<locale>.md`，子 runtime 使用 `RUNTIME.<locale>.md`。只提供需要翻译的正文和自然语言字段即可。结构字段由 canonical 文件决定，翻译不能改变契约、工具、stage、超时、提示词段 ID 或位置。缺少目标语言时使用兼容语言候选、English、canonical；默认中文及其别名保留 canonical。静态提示词的语言版本在加载时捕获。

```sh
pnpm validate:plugin plugins/example
pnpm validate:plugin plugins/example/runtimes/extract/RUNTIME.md
pnpm --filter @covel/plugin-example test
pnpm lint
```

`validate:plugin` 执行静态作者校验，不执行 entry。builtin 的真实注册、声明对齐及发布验收由 `apps/server/tests/bootstrap/builtin-plugin-entries.test.ts` 随全量 `pnpm test` 执行；此验收不执行社区 entry。

新增行为应测试正常输出、无效输入与数据归属，涉及执行失败还应验证 proposals 不会部分提交。社区插件服务端代码在用户授权后加载；manifest 声明不是授权本身。

## 代表性实现

| 需求                 | 内置示例                                                         |
| -------------------- | ---------------------------------------------------------------- |
| 叙事提供者与用户设置 | [narrator](../../plugins/narrator/PLUGIN.md)                     |
| 本地工具和 UI 消息   | [guide](../../plugins/guide/PLUGIN.md)                           |
| World Model 初始化   | [world-init](../../plugins/world-init/PLUGIN.md)                 |
| 角色创建与跟踪       | [char-creator](../../plugins/char-creator/PLUGIN.md)             |
| 函数运行时与公开输出 | [world-time](../../plugins/world-time/PLUGIN.md)                 |
| 历史变换扩展         | [branch-reply](../../plugins/branch-reply/PLUGIN.md)             |
| 记忆定义与提取       | [memory](../../plugins/memory/PLUGIN.md)                         |
| 历史压缩扩展         | [history-compaction](../../plugins/history-compaction/PLUGIN.md) |
| 舞台与媒体记录       | [scene-stage](../../plugins/scene-stage/PLUGIN.md)               |

### 保留的数据命名空间

整个 `_` 前缀保留给内核，插件不能经通用 plugin-data API 或 proposal 写入或删除这些 namespace，包括未知的 `_` 名和旧 `_memory`。插件日志通过受限 logger API 产生；业务数据使用 `blocks`、`definitions` 等普通名称。`__kernel:<subsystem>` 是不同的 owner 分区，插件绑定的读取接口不可访问它。完整清单与读取权限见[存储架构](../architecture/storage.md#plugin-data-ownership-and-reserved-names)。

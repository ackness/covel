# 插件契约参考

Covel 的插件包以根 `PLUGIN.md` 声明身份、版本化契约和贡献，以可选 runtime 执行业务。框架提供存储、事务、调度、工具执行和扩展点；业务含义由插件提供。内置实现以 [plugins/](../../plugins/) 为准，可选插件见[官方社区仓库](https://github.com/covel-ai/covel-plugins)。

当前只支持本页格式。旧平铺 manifest、子目录 `PLUGIN.md`、角色镜像及旧 checkpoint 开发数据需要重新生成，不提供迁移读取或双写。

## 包与运行时文件

```text
example/
├── package.json
├── README.md
├── PLUGIN.md
├── PLUGIN.zh.md
├── locales/
│   └── zh.yaml
├── server/index.js
├── schemas/
├── ui/
└── runtimes/
    └── extract/
        ├── RUNTIME.md
        ├── RUNTIME.zh.md
        └── handler.js
```

根文件必需，`id` 必须匹配包目录。单 runtime 放在根 `runtime`，其提示词就是根文件正文；多 runtime 放在 `runtimes/<id>/RUNTIME.md`，逻辑 ID 为 `<pluginId>/<id>`，提示词为各自文件正文。两种布局不能混用，子 runtime 不能声明包级贡献。只有 entry/UI/扩展的包可以没有 runtime。

所有 `PLUGIN.md`、`RUNTIME.md` 及其语言变体必须使用以独立 `---` 行包围的普通 YAML frontmatter。加载器在解析前拒绝 `---javascript`、`---js` 等 engine 指令；安装、手动放入目录和重载均不能通过元数据执行代码。

作者 JSON Schema 与逐字段说明（由 Zod schema 生成，不手工维护）：

- [plugin-manifest.schema.json](../../packages/shared/schemas/plugin-manifest.schema.json) · [字段表](schema/plugin-manifest.md)
- [runtime-manifest.schema.json](../../packages/shared/schemas/runtime-manifest.schema.json) · [字段表](schema/runtime-manifest.md)

本页下方的表格只概括各组字段的用途；合法字段、类型、是否必填和取值以生成的字段表为准。

TypeScript 校验入口从 `@covel/shared` 导入：`pluginManifestSchema` 校验包清单，`runtimeAuthoringManifestSchema` 校验作者 runtime。用于组合完整校验器的输入/输出配置、命令参数、投影项和绑定引用等细粒度 schema 属于内部实现，不再单独从包入口导出。

加载器会编译成内部执行结构。内部 `RuntimeManifest` 字段不是作者格式，不能复制到 `PLUGIN.md` 根层。

加载结果分为包定义 `ParsedPluginMd` 和执行定义 `ParsedRuntimeMd`。`loadPluginDefinition()` 返回必需的 `packageManifest` 与显式的 `manifests` 数组；数组为空就没有可调度的 runtime。`parsePluginMd()` 只解析包，根内联 runtime 由 `compileInlineRuntime()` 显式编译。包的 entry、UI、事件、命令和扩展只从根定义注册一次，不复制到每个 runtime；runtime 保留执行身份与版本，并继承执行所需的用户设置和数据 schema。

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
    loop:
      completion: { require: tool-use, afterTools: [save-facts] }
---
Extract facts supported by runtime-inputs.narrative.value, then call save-facts.
```

| 根字段                                          | 含义                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`, `kind`                                    | 包身份；`kind` 为 `core` 或 `plugin`                                                                        |
| `version`, `displayName`, `description`, `tags` | 元数据；不再使用 `role:*` 标签驱动业务                                                                      |
| `covel`                                         | 适配的宿主版本范围，如 `">=0.0.45"`；范围之外的宿主不安装也不加载该包                                       |
| `author`, `license`, `homepage`                 | 作者信息，只用于展示；见[作者信息](#作者信息)                                                               |
| `provides`                                      | 版本化契约字符串，或 `{contract, default: true}`                                                            |
| `requires`                                      | 必需契约，解析器补入提供者                                                                                  |
| `optional`                                      | 可选契约，不强制激活提供者                                                                                  |
| `conflicts`                                     | 与提供这些契约的其他插件互斥                                                                                |
| `contracts`                                     | `{contractId: {schema: ./path.json}}` 契约 schema 声明；被 `contributes.data` 的 namespace 接收的契约不用写 |
| `entry`                                         | 包根相对的注册模块路径                                                                                      |
| `contributes`                                   | 下表列出的包级贡献                                                                                          |
| `runtime`                                       | 可选的单 runtime 声明                                                                                       |

契约 ID 形如 `narrative-engine@1`。`runtime.io.output.contract` 必须由本包 `provides` 声明，同包不允许两个 runtime 产出同一契约。跨包可以有多个普通提供者，消费者使用 `cardinality: one` 或 `all` 表达选择要求。单提供者扩展点及显式 `conflicts` 另外执行互斥检查。`conflicts` 只允许插件契约；引用内核扩展点或 UI 槽位会得到 `invalid-conflict` 和 `conflicts` 字段位置，内核点的组合由 mode 决定。

### 作者信息

插件、世界（`world.yaml`）和合集（`covel-collection.yaml`）用同一组可选字段说明“谁做的、去哪找”。它们只用于展示：宿主不据此做任何判断，其中的文字不进入提示词。

```yaml
version: 1.2.0
author:
  name: Jane Doe
  url: https://example.com
  about: I write small mystery worlds. A new one comes out every month.
  links:
    - label: Community
      url: https://example.com/community
    - label: Support my work
      url: https://example.com/support
license: CC-BY-4.0
homepage: https://example.com/tidefall
```

| 字段           | 说明                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| `author.name`  | 作者或团队名，最多 80 字符。在任何语言下都按原样显示，不翻译              |
| `author.url`   | 作者自己的页面                                                            |
| `author.about` | 作者写给玩家的一段话：自我介绍、其他作品、支持方式。纯文本，最多 500 字符 |
| `author.links` | 带标签的链接，最多 6 条；`label` 最多 40 字符                             |
| `license`      | 许可证：SPDX 标识或简短名称，最多 64 字符                                 |
| `homepage`     | 包自己的页面，例如仓库或文档                                              |

- **链接只接受 `https`**，不能带用户名和密码；`http:`、`javascript:`、`file:` 等地址在清单校验时被拒绝。这些链接是作者提供的第三方地址，宿主没有审核。玩家点开任何一个之前，界面先显示完整地址和域名并说明这一点，确认后才在浏览器中打开。域名以 ASCII 形式显示，其他文字写成的仿冒域名会显示为 `xn--…`。
- **展示位置**：世界列表（作者 · 版本）、世界详情、开局准备页的世界卡片和插件行、设置里的已安装插件。安装预览只显示作者名，不显示链接。进入游玩后的界面不显示这些内容。
- **翻译**：插件在 `locales/<locale>.yaml` 的 `PLUGIN.md` 一节翻译 `author.about` 和 `author.links` 的 `label`（链接按顺序对应）；世界在 `world.<locale>.yaml` 里翻译同样两处。作者名和许可证不翻译，`pnpm i18n` 不把它们算作待翻译文本。
- **版本号**：列表显示清单里的 `version`。插件同时带 `package.json` 时两处的版本必须相同，`pnpm validate:plugin` 会检查：安装预览读的是 `package.json`，宿主读的是 `PLUGIN.md`。`version` 变化会让已有会话重跑该插件的 setup runtime，setup 的 guard 或 handler 必须对已完成的工作返回跳过。

### 契约版本策略

契约 ID 中的 `@N` 是版本标识（如 `narrative-engine@1`）。内核采用 **current-only** 策略：只承载当前契约版本，不做版本协商，不同时支持多个版本，也不提供跨版本兼容读取或双写迁移。

- 破坏性变更使用新的契约 ID（例如 `@2`），提供者与消费者在同一个变更中同步升级，旧版本随即失效
- 旧会话快照和排队作业需要重建
- 变更记录在 CHANGELOG 和相关 PR 的迁移说明中

外部插件作者应跟踪框架的 CHANGELOG，在契约变更后同步升级并更新声明的契约版本。

| `contributes` 字段 | 对应注册或资源                                           |
| ------------------ | -------------------------------------------------------- |
| `tools`            | `registerTool` 的工具名                                  |
| `actions`          | `registerRpc` 的 action 名                               |
| `commands`         | 玩家命令元数据；`action` 必须列入 `actions`              |
| `services`         | `registerService` 的契约 ID                              |
| `extensions`       | `provideExtension` 的 `{point, id}`                      |
| `hooks`            | hook 的 `{event, enforce}` 声明                          |
| `wires`, `forms`   | 对应注册 ID                                              |
| `events`           | 插件事件契约                                             |
| `settings`         | 玩家配置项，运行时通过 `ctx.userSettings` 读取           |
| `data`             | 本插件数据 namespace 的 schema、version、accepts、search |
| `ui`               | 包根相对的 `right/message/left` UI spec 路径             |
| `worldProjections` | 世界数据投影声明                                         |
| `prompt`           | 静态提示词段                                             |

entry 注册与清单双向校验，未声明的注册和未实现的声明都会失败。包级贡献只有根文件拥有，不合并子 runtime 字段。

## Runtime 分组字段

| 字段          | 主要配置                                                                   |
| ------------- | -------------------------------------------------------------------------- |
| `type`        | `agent` 或 `function`                                                      |
| `schedule`    | `stage`, `trigger`, `needs`, `after`, `completion`, `manual`               |
| `io`          | `inputs`, `selfData`, `payloadSchema`, `output`, `visibility`, `concealed` |
| `agent`       | `model`, `llm`, `history`, `tools`, `advertiseEvents`, `loop`              |
| `function`    | `handler`、可选 `model`、`timeoutMs` 和 `tools`                            |
| `guard`       | runtime 相对的 guard 模块                                                  |
| `effects`     | 读写资源与 `parallelSafe`                                                  |
| `permissions` | 执行权限声明                                                               |

只有一个内联 runtime 的包（runtime ID 等于插件 ID）里，没有写 `agent.tools.plugin` 的 agent 自动获得 `contributes.tools` 的全部工具；写 `plugin: []` 表示一个也不给。给这样的包新增一个只想让界面动作使用的工具时，要同时给 agent 写明白名单。多 runtime 的包每个 runtime 都要自己声明工具。

Function runtime 必须声明 `function.handler`，模块必须默认导出函数，不能同时配置 `agent`。Agent runtime 不能配置 `function`。`function.model` 声明 handler 内 `ctx.gateway` 调用使用的模型 slot（如 `memory`）：detached 后台任务在领取前用它判断凭证就绪，不声明时按系统默认 preset 判断，可能把请求级 slot 绑定漏掉，导致任务一直排队直到 `maxQueueMs` 超时。

Agent 的 guard 在调用模型前执行。返回 `{ skip: false }` 时照常运行；返回 `{ skip: true, ...fields }` 时不调用模型，结果记为 `skipped`，`skip` 之外的字段就是本 runtime 的输出：声明 `io.output.contract` 时按契约校验，并照常绑定给消费者，`skip` 标记本身不进入校验和绑定。需要在本轮放弃工作时，返回契约允许的最小输出，例如 `story-events/plot` 关闭时返回空计划 `{ skip: true, events: [] }`。

`io.concealed: true` 用于处理隐藏内容的 runtime（例如在剧情中策划隐藏事件的 agent）。框架在写入 trace 和推送实时流之前去掉它的提示词、模型回复、工具参数、工具结果和输出，只保留 runtime / 工具名、状态、耗时与用量；`/turns` 和手动 RPC 返回的执行结果也会清空它的输出与工具内容。runtime 失败时，发给玩家的失败原因（回合流、trace、返回的结果）换成固定的通用提示，真实原因只写入服务端控制台日志。持久化的执行记录保留完整内容，供重试使用。隐藏只覆盖上面列出的范围，不覆盖对话日志：隐藏 runtime 的输出里若带文字（`narrativeOutput` 或 `content`），这段文字仍会写入对话日志，并随之进入其他 runtime 的提示词历史、消息接口和“重建提示词”接口。因此隐藏 runtime 不应产生文字输出。

`schedule.needs`、`schedule.after` 与 `io.inputs.*.from.runtime` 中的 runtime ID 只能属于本包（完整 `<pluginId>/<runtimeId>` 或单 runtime 的包 ID），裸字符串依赖也受此限制。跨包引用必须使用公开的版本化 contract；纯 `after` 不会自动激活提供者。

**跨包 runtime 引用边界**：包内 runtime 引用（`needs/after/inputs`）是合理的实现排序和数据流，允许包内使用具体 runtime ID。跨包依赖必须通过契约（`from.contract`）实现，确保提供者可替换，消费者无需修改。加载器对跨包 runtime 引用执行严格校验并拒绝加载。

runtime 的 `schedule.needs[].contract` 和 `io.inputs.*.from.contract` 必须在根 `requires` 或 `optional` 中声明，加载器对内联和子 runtime 同样校验。包内其他 runtime 提供的契约也需声明，可列入 `optional`，无需激活其他插件；`schedule.after` 只排序，`from.kernel` 是内核输入，两者不产生包激活依赖。

阶段按 `setup → pre-turn → narrative → post-turn → audit` 推进，阶段之间有完成屏障。相同阶段的先后由依赖边决定。`needs` 是成功门控，`after` 只表达排序。调度不能用更晚阶段的输出解锁更早阶段。

同轮事件链中，每个深度实际匹配的同步 event runtime 也按 `needs`、`after` 和 `io.inputs` 建 DAG：层内独立执行，层间合并结果，再检查下游成功门控和输入。环及被环阻塞的下游记为 `skipped: dependency-cycle`，独立分支继续执行。依赖声明不会触发未匹配事件的提供者；后台 event follower 是独立作业，不参与这份同步 DAG。

前一阶段或事件深度已满足的提供者也可满足 `needs` 的单提供者契约需求，避免当前批次中的另一候选提供者造成假循环；它不撤销 `after`、全提供者需求或输入绑定的排序边。

包级 `requires` 保证契约提供者被激活，不要求每次执行都重新产生输出。需要在后续执行处理表单的 setup runtime 应用 `after` 排在一次性 setup 提供者之后，并读取已提交状态；不要使用默认 turn scope 的契约 `needs`，否则提供者完成 setup 后不再运行，消费者会被成功门控跳过。`after` 不证明初始化成功；消费者 guard 必须检查所需领域状态，例如新建主角前确认 `ctx.world.characterSchema` 已存在，缺失时明确失败，不生成表单或写入角色。

setup runtime 的完成状态按根 `PLUGIN.md` 的 `version` 记录。发布新版本（`version` 变化）后，已有会话会在下一次玩家动作时重跑该 setup runtime：仍在 setup 阶段的会话在 setup 带重跑，已进入主循环的会话经 late-setup 通道在 pre-turn 之前补跑，并重新计算重试预算。因此 setup runtime 的 guard 必须对已完成的工作返回 `{ skip: true }`（例如主角已存在、schema 已写入），否则升级会让玩家重新看到欢迎信息或表单。不声明 `version` 的插件按 `0.0.0` 处理，永远不会因升级重跑。

触发类型包括 `auto`、`scheduled`、`manual` 和 `event`。自动主循环运行时应声明 stage；manual/event 可按请求或事件独立触发。`schedule.manual.execution: background` 使用后台执行，`schedule.completion` 控制回合是否等待，具体限制由 manifest 校验和运行时准入执行。

`agent.history: {maxTurns}` 把 agent 的提示词历史限定为最近 N 个回合（按 `turnId` 计数，`0` 为不带历史），同时去掉压缩摘要、不参与本轮压缩屏障；省略时沿用会话共享视图。当前回合不计入 N：当前玩家输入和本次执行已产出的故事正文始终发送（见 [Prompt 结构](prompt-structure.md#本回合正文)）。只消费本轮输入的提取类 runtime 应声明它，避免提示词随会话增长。

Agent 的超时、重试和步数在 `agent.loop` 中。流式的模型调用按无输出时间限时：首次输出前最多等待 `firstTokenTimeoutMs`，之后两次输出之间最多静默 `idleTimeoutMs`（默认各 120 秒）；持续输出的模型不会被截断，输出所用的时间也不计入 `timeoutMs`。回复在模型的输出上限处被截断（`finishReason: length`）时，被截断的工具调用和 JSON 不能使用：这次调用以新的尝试重试一次，附一句"只写任务需要的内容"的提示；再次被截断才判为失败，错误提示调大输出上限。打转或重复输出的模型重来一次通常就能写完，额度真的太小时第二次也写不完。唯一的例外是 `io.visibility: story` 的 runtime 只输出了正文、没有工具调用：正文保留并提交，玩家看到一条"可能停在半句"的提示。流式调用在已有输出之后中断（连接断开、静默超过 `idleTimeoutMs`）时，`io.visibility: story` 的 runtime 不重试，因为玩家已经读到那段文字；其他 runtime 的输出没有给任何人看，丢弃后按 `maxRetries` 重试，已写的时间同样不计入 `timeoutMs`，之后的静默计入。非流式调用没有进度信号，由 `callTimeoutMs` 限制单次调用的总时长。`maxRetries`（默认 1，最大 5）是一次模型调用拿不到回复时的重试次数：调用超时、网络错误、限流、5xx、服务商报告的生成错误、上面所说的输出中途中断和一次截断；4xx 和输出 schema 不符不重试。被工具拒绝的调用不占这个次数，模型读到错误后在下一步重新调用，受步数限制。重试之间没有等待，并且和首次调用共用 `timeoutMs` 以及一次逻辑调用的请求预算（默认 120 秒、8 个 HTTP 请求，见 [slots.md](slots.md#http-retry-cleanup)）：`callTimeoutMs` 为 60 秒、`timeoutMs` 为 120 秒时，卡住不返回的调用只够再试一次；每次都用满传输层重试的 5xx 也只够两轮；很快返回、只占一个 HTTP 请求的失败（连接在应答中途断开、生成错误）才用得上更多次数。内置的记账和开局 agent 设为 3。`completion.afterTools` 可在指定工具成功后结束；`completion.require: tool-use` 要求有效工具调用，即至少一次执行成功的业务工具调用；失败的调用不算。纯文本回答或调用 `runtime-done` 时若还没有这样的调用，先注入一次纠正提示，仍未完成才判为失败，因此"无变化"也要通过业务工具提交空结果。纠正之后的那次请求要求模型必须调用工具（`toolChoice: "required"`，manifest 指名的工具保持不变；模型处于思考模式时服务商不接受强制选择，仍由模型自选），模型调用工具后恢复自选。判定在循环返回处统一进行，普通执行与 resume 的所有结束方式都适用：文本回答、`runtime-done`、`afterTools` 自动完成、`PostToolUse` Hook 终止，以及步数用尽。Function 工具白名单在 `function.tools`，控制 `ctx.tools.call`；Function 超时在 `function.timeoutMs`，不要把外部服务执行时限放到 agent 配置中。

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

普通输入读同一 execution 的已完成上游结果，`select` 为结果值上的 JSON Pointer。跨 execution 读取使用 `scope: committed` 和 `recordAs`。Schema 可以是本地路径或 `contract:<contractId>`；跨提供者契约 schema 在加载时解析。提示词中的绑定位于 `runtime-inputs.<binding>.value`，不要再依赖旧注入标签。叙事之后运行的 agent 绑定的若是本回合的故事正文，这个 `value` 是一句指向对话里那条正文消息的话，正文本身不重复（见 [Prompt 结构](prompt-structure.md#本回合正文)）。 输入绑定名称只匹配显式声明的 schema 和 slot；`constructor`、`toString` 这样的名称不读取 JavaScript 继承属性。

CLI 和安装器的静态校验同样检查 `scope: turn` 与 `scope: committed` 的输入：本地 `accepts` 文件必须存在且为有效 JSON，直接引用的 producer runtime 必须存在于同一插件包。`scope: committed` 不允许声明 `select`（包括空字符串），错误定位到 `io.inputs.<binding>.select`；普通 turn 输入仍支持 JSON Pointer。可选外部契约不因此要求 provider 已安装。

`select` 遵循 RFC 6901：数组索引使用 `0` 或无前导零的十进制整数，`/01`、`/+1` 等不匹配数组元素。`required: false` 的输入在静态 schema 不兼容或实际值未通过校验时省略该槽位，消费者仍运行并解析其他输入。静态 pattern 证明只处理完整的锚定字面前缀（如 `^audio/`）；含分组、量词或分支的正则交给实际值校验，不截取表面前缀来拒绝有效输入。

发布 runtime 输出契约时，在根 `contracts.<contractId>.schema` 声明完整输出的公共 schema。同一契约 ID 的所有提供者必须发布一致的 schema；替代插件的 `provides` 与本插件 runtime 的 `io.output.contract` 必须对齐，其他已安装插件的产出不能替它满足声明。缺少被消费契约的 schema 或只有声明而无产出的提供者会产生加载诊断。

内核在 runtime 最终输出边界校验已发布的契约，失败结果不能提交领域 effects 或写入 `recordAs`。同轮输入在应用 `select` 前再次校验完整输出；`scope: committed` 输入读取冻结的完整 export 后同样校验公共契约，即使没有显式 `accepts`。消费者的 `accepts` 可另加限制，不能关闭公共契约校验。`required: false` 的输入若把 `accepts` 指向 `contract:<id>`，而没有已安装的包发布该契约，runtime 照常加载：发布它的插件本身是可选的。此时无法校验的值不会注入，诊断为 `accepts-contract-unresolved`；必填输入遇到同样情况仍然加载失败。`cardinality: one` 的 `accepts` 校验单个业务值；`all` 校验按 runtime ID 排序的业务值数组，包括数组长度和唯一性约束，公共契约仍分别校验每个提供者。契约发生变化时应重建受影响的开发期会话数据和历史 exports。

内部 `RuntimeResult` 分别保存 `output`（业务输出）、`effects`（显式副作用）和 `completion`（`done` / `pending`）。提交、事件后继和待处理交互读取 `effects`，setup 完成判断读取 `completion`。`outputKind: story` 的 `output.narrativeOutput` 仍按声明发布叙事。

Function 的输出契约以 handler 返回的 `value` 为准，可以是标量、数组、对象或 `null`。运行时用 `canonicalValue` 保存原始业务值；对象投影为 `output`，标量、数组和 `null` 投影为 `{ value }`，缺省值投影为空对象。业务值中的 `events`、`pluginData`、`interactions` 或 `preGameDone` 等同名字段不会发起副作用或完成 setup；这些意图必须通过 `HandlerResult.effects` 和 `HandlerResult.completion` 表达。`effects.interactions`、`effects.notifications` 与 `effects.statePatches` 必须为数组，条目及 `effects.ui[].parts` 必须是对象：function 返回非数组通道或非对象条目时以 `output-schema-invalid` 失败，其他途径带入的同类内容在提交时作为该 runtime 被拒绝的写入处理（见[事务参考](transactions.md)）。同轮输入、公共契约校验与 `recordAs` 发布都读取同一业务值。没有提供 `value` 时不发布 export；不要通过猜测 `output.value` 拆箱。普通输入的 `select` 作用于此业务值；committed 输入读取完整 export，不支持 `select`。

Agent 继续使用现有的提示词输出协议。执行边界统一将声明的副作用和工具结果归入 `effects`，将 `preGameDone: true` 转为 `completion: "done"`；包含 `topic` 的事件归入副作用，WorldIR 的业务事件保留在 `output.events`。Agent 的公共契约值为拆分后的业务 `output`，普通执行与 resume 使用相同边界。

Agent 最终输出里声明的副作用（`statePatches`、`pluginData`、`notifications`、`interactions`、带 `topic` 的 `events` 等）不经过工具，因此不受 `agent.tools` 白名单限制；`effects` 声明只对分离执行的 runtime 在提交前强制核对。`pluginData` 的归属由内核按来源插件确定，写不到别的插件；`statePatches` 写的是全会话共享的状态表（见 [Proposal 类型](tools.md#proposal-类型)）。只读用途的 agent 应在提示词的输出协议里不声明这些字段。

`PostRuntime` 若改变 function 的 `output`，应同时明确提供匹配的 `canonicalValue`，新值会重新接受私有和公共 schema 校验。仅改写 `output` 会撤销业务值，停止 export 与下游值绑定；有公共输出契约时还会因缺失契约值而失败。修改副作用或完成信号应直接修改 `effects` 或 `completion`。失败 runtime 的副作用不提交，事件不触发后继 runtime。普通执行与 resume 共用 agent 输出 schema gate；非 story agent 声明私有 `io.output.schema` 后，先校验候选协议输出，再拆分业务值与副作用，最终无正文或空正文也接受校验，不符合 schema 即失败，暂停时积累的写入不提交。Story agent 保留独立的叙事正文检查，不使用私有 schema gate。

上述内部结果结构变化需要重建受影响的开发期执行结果、exports、后台作业及快照；不兼容读取旧的平铺副作用结果。

`ctx.playerMessage` 保持当前输入文本字符串。`ctx.logicalTurn`（函数 handler 与插件工具上下文均有）是调度器的逻辑回合：已提交的主循环玩家回合数加一，setup 与开场续写和第一条玩家消息同为第 1 回合，`startTurn` / `interval` 也以它计数；工具上下文的 `turnNumber` 则是会话中已记录的玩家消息数（含 setup 表单提交）。`ctx.session.lastPlayerInput` 是源执行开始时最近一条 `PlayerInputSubmission | null`，包含 `id/sessionId/turnId/formId/values/createdAt`；它可能来自更早回合，不能把存在该记录解释为本回合提交了表单。

`ctx.random` 是宿主提供的随机源，函数 handler、agent guard、插件工具和 RPC action 的上下文里都有。骰子和其他游戏内的随机取数用 `ctx.random.int(min, max)`（返回 `min <= n < max` 的整数，与 `node:crypto` 的 `randomInt` 相同），不要直接用 `node:crypto` 或 `Math.random`。平时它就是 `randomInt`；测试服务端设置 `COVEL_RANDOM_SEED` 后，同一个 runtime（或同一个 RPC action）取的第 n 个数每次运行都相同，脚本会话因此可以重复（见 [环境变量](../guide/env-registry.md#runtime-contract) 与 [录制与回放](../guide/e2e-plugin-verify.md#录制与回放)）。`shortId` / `shortIdBatch` 的第四个参数接受它，ID 的随机部分也随之可重复。

**记录里的簿记字段不给模型。** 会话 ID、行 / 回合 / 结果的 UUID 和写入时间对模型没有用：占 token，抄回来容易抄错，时间戳在行每次重写时都会改变提示词，同一个会话跑两遍它们也各不相同。内核把记录写进提示词时会去掉它们：`io.selfData` 的每一行是 `- <key> | <值的 JSON>`（`summary` 格式截断到 200 字符），不带行的 `updatedAt`，值里与 key 相同的 `id` 也不再重复；`<runtime-inputs>` / `<runtime-exports>` 的值、`{{ world.schema }}`、`{{ characters.npcs }}` 的 fields、SDK `characterSheetSegments()` 的玩家表与 NPC fields，以及没有 `_text` 的工具结果在交给模型前也经过同一个投影。属性名和取值都符合才算：名为 `id` 或以 `Id` / `Ids` 结尾且取值是 UUID（或全是 UUID 的数组），名为 `timestamp` 或以 `At` 结尾且取值是 ISO 时间，以及 `sessionId`。`id: "npc-lin-yao"`、`date: "1943-06-01T08:00:00Z"` 这样的值保留。这个判断只看名字和取值的形状，分不出剧情里的时间：故事内的时刻若存成 `diedAt: "1943-06-01T08:00:00Z"`（名字以 `At` 结尾或叫 `timestamp`，取值是 ISO 时间），模型同样看不到它，而且没有任何报错。要给模型看的剧情时间换一个名字（`date`、`diedOn`），或者不写成 ISO 时间（`"1943 年 6 月 1 日清晨"`）；世界包里的数据和插件自己存的数据都适用。代码读到的记录不变：`ctx.inputs`、`ctx.pluginData`、`ctx.tools.call` 的返回值都是完整的。插件自己拼提示词（例如直接调用 `ctx.gateway`）时用 `@covel/plugin-handlers-utils` 导出的 `modelFacingJson(value)` 做同样的事；工具要把一个不透明句柄交给模型时写在 `_text` 里。

内核输入 `turn-digest@1` 冻结同一份 lastPlayerInput 快照及 `runtimeResults`。后者包含已经观察到的终态 `{runtimeId, status}`，status 为 `success/failed/skipped/suspended`；没有把尚未结束的 runtime 预测为成功。detached worker 消费源执行快照，不重新查询最新表单或回合状态。此输入契约更新后，旧作业与快照需要重建，不做兼容读取。

## World Model 与数据边界

角色 schema、角色和世界记录是内核 World Model。`ctx.world.characterSchema`、`ctx.world.characters` 及 `ctx.world.worldRecord` 为只读视图；这些领域的合法上游 proposals 和本 runtime 已缓冲 proposals 对后续读取可见。写入通过 proposals，并在提交时统一校验。`ctx.world.dimensions` 则是提供者发布的公共当前值快照，遵守下方独立的冻结边界。

角色类型是 schema 中声明的开放字符串；`player` 为保留语义且每个会话最多一个。角色字段遵守 CharacterSchema 的 attributes。修改 schema 的 proposal 为 `character.schema.set`，payload 直接包含 `types`、`attributes`，版本由内核递增。

插件自有持久数据经绑定的 `ctx.store.getPluginData(namespace, key)`、`listPluginData(namespace?)` 访问。插件不能指定任意 sessionId/pluginId 读其他插件私有数据。跨插件公开数据使用契约、服务或扩展，不扫描对方 namespace。

Lorebook 使用 owner 与 id 的复合身份，owner 为 world、plugin 或 player。HTTP 玩家编辑路径只管理 player owner。不要用字符 ID、插件 ID 或任意 namespace 模拟角色表和 Lorebook 归属。

### 动态维度

`world.dimensions@1` 发布 `{id: {name, description?, schema, value, version}}`。插件读取 `ctx.world.dimensions.<id>.value`；不要从 `worldRecord.dimensions` / `metadata.dimensions` 取当前值，那里是作者 definition 与初值，也不要扫描另一个插件的 `_dimensions`。

捆绑的 `world-init` 使用三个 runtime：

| Runtime             | 阶段              | 职责                                                                                                                             |
| ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `dimension-context` | pre-turn function | 不调用模型，读取已提交值并发布 `world.dimensions@1`                                                                              |
| `dimension-tracker` | post-turn agent   | 必须绑定本轮叙事，按作者规则维护；WorldIR 为可选辅证；`toolChoice: required`，无变化也以 `update-dimensions({updates: []})` 结算 |
| `edit-dimensions`   | manual function   | 玩家改值、确认人工处理或明确跳过                                                                                                 |

同一次执行的公共 dimension 读取冻结。setup 初始化和写入者自身 proposal 可形成局部预览，但不替换公共快照，不泄露给并行 sibling。公共 builtin `world-dimension-get/list` 始终读取冻结快照，不叠加自身写入，也不回退初值。模板选取 `{{ world.dimensions.<id>.value }}`；默认提示词段是预算内投影，而非全量记录。

写入使用 `dimension.initialize` / `dimension.update` 领域 proposal；只有受信属主可写，更新带 `expectedVersion` 并整批 CAS。普通 `plugin.data`、batch、delete 或 action RPC store 写入不能触碰 `_dimensions` / `_dimension-settlements`。维护工具的来源及读取版本集由框架获取，模型只提交新值；没有变化也调用 `update-dimensions({updates: []})`，不能以 runtime 成功推断已结算。

自动维护失败或未运行保留 `pending-settlement` 回执，下一次叙事前须解决。恢复元数据由 `session.world-context@1` 提供并经 host 验证：editor 为 manual runtime RPC，重试直接调用 tracker 加 `retryFromTurnId`。普通手改不自动解决源回合义务，已终结回执不重复补算。完整状态与接口见 [World Model](world-model.md#回合时序与结算回执)和 [API](api.md#维度编辑与待结算恢复)。

> **BREAKING CHANGE**：旧九类 raw dimension 格式和旧副本读取移除。世界作者使用[统一 definition](world-data.md#动态世界维度dimensions)，开发世界、会话与快照需重建。这里不提供 #97 的隐藏事件触发层，也不改变角色、背包、好感或时间的权威属主。

### 世界数据导入

```yaml
contributes:
  data:
    facts:
      version: 1
      schema: ./schemas/facts.schema.json
      accepts: [example.facts@1]
```

namespace 接收某个契约，就说明了这个契约的记录长什么样，所以它的 `schema` 也就是该契约的公共 schema，不需要在根 `contracts` 里再写一遍。只有两种情况要写 `contracts.<id>`：契约不是数据契约（例如 runtime 输出契约），或者两个 namespace 以不同的 schema 接收同一个契约（这时必须说明哪一份是公共的）。

接收世界数据的 namespace 还可以声明 `authoring`（`title`、`summary`、`hint`、`example`、`source`、`generate`），说明世界作者该如何提供这份内容，以及应用内生成器能否生成它；只有列出 `accepts` 的 namespace 才能声明它。`pnpm describe:authoring` 汇总所有已扫描插件的声明，`--check` 按 namespace 的 schema 校验每份 `example`。字段见 [Plugin manifest 字段表](schema/plugin-manifest.md)。

World Data 的 source 使用 `to: contract:example.facts@1`（`schema` 省略时就是目标契约的 schema）。框架查找已激活且声明接受该契约的 namespace，验证 schema 后分发数据，不在框架中识别具体插件 ID。`contracts` 与接收 namespace 的 schema 必须一致。完整结构见 [World Data](world-data.md)。

### 可检索的数据

```yaml
contributes:
  data:
    facts:
      version: 1
      schema: ./schemas/facts.schema.json
      search:
        text: text
```

namespace 声明 `search` 后，它的记录进入框架的记忆检索（[`memory-search`](tools.md) 的 archival 范围），结果的 `source` 是 `archival:plugin_data`，并带 `pluginId`、`namespace` 和记录的 key。`search.text` 是记录值里存放待检索文字的字段名；该字段不是非空字符串的记录不参与检索。只有插件在当前会话启用时才读取，没有声明的 namespace 框架不读。配置了 embedding 模型时，这些记录和 lorebook、角色记录一起写入向量索引，插件不需要另做处理。

检索由框架完成，插件只决定记什么。插件要在自己的代码里给一批文字排序（例如在 `prompt.segment@1` 里挑出与玩家输入有关的记录），用 SDK 的 `rankTexts(query, texts, { limit, minCoverage })`：它和框架检索是同一份 BM25 实现，不调用模型。返回的 `coverage`（0 到 1）表示文本回答了查询的多少，可用来丢掉只沾到常见词的结果；`matched` 是文本含有的查询词个数，除以 `searchTerms(query).length` 就是查询有多大比例落在这条文本上，一句长查询只和文本共有一个日常用词时这个比例很小；`searchTerms` 和 `searchExcerpt` 是配套的切词与摘录函数。

世界包把 source 声明为 `visibility: hidden` 时，同一份数据会导入到接收插件的 `_hidden.<namespace>`（例如 `_hidden.facts`）。插件 runtime 通过 `ctx.pluginData.list("_hidden.facts")` 读取；扩展点、模型工具、`io.selfData` 和公共 API 都读不到它。揭示应通过本回合的 runtime 输出完成，详见 [World Data · 隐藏数据](world-data.md#隐藏数据visibility-hidden)。

插件自己的代码（function runtime 的 `ctx.pluginData.set`、插件本地工具产生的 `plugin.data` 提案）也可以写入自己的 `_hidden.<namespace>`，用于在剧情中追加隐藏内容；写入总是归属提案来源插件，碰不到其他插件的隐藏数据。REST 接口和内置 `plugin-data-set` / `plugin-data-set-batch` 工具仍然不能写任何 `_` 命名空间。

## 提示词与记忆扩展

静态段放在 `contributes.prompt`，每项包含 `id/content/position`，可选 `role`。位置为 `system`、`pre-history`、`post-history` 或 `{depth: number}`。host 自动注册静态段，无需再次声明扩展；`static-prompt` 为保留注册 ID。

动态提示词使用 `prompt.segment@1`，世界上下文使用 `session.world-context@1`，历史变换使用 `prompt.history-transform@1`，历史压缩使用 `history.compact@2`。详见[插件扩展点](plugin-extensions.md)。这些扩展使用同一个 execution 的快照，不在每次调用时重读清单。

记忆块属于 memory 插件：默认定义经 `memory.block-definitions@1` 服务提供，世界自定义定义经 `memory.blocks@1` 数据契约导入。框架不再聚合 `memoryBlocks` 或 `summaryFocus` 字段，也不维护独立 working_memory 表。

## 会话插件选择

`resolveSessionPlugins` 从 `requested`、`excluded`、授权状态和根契约声明计算 `active/autoAdded/rejected`。

- 显式排除优先，core 也不会被恢复。
- 默认提供者在明确提供者激活时退出。
- 必需契约补入提供者；缺失、歧义、冲突与授权不足返回原因。
- 失去必需提供者的插件和孤立自动依赖会被移除。
- `requested` 与计算出的 `active` 分开持久化，自动依赖不会变成用户的显式选择。
- 世界的 `pluginPolicy.requires` 作为 `requiredContracts` 传入，世界与插件一样是依赖方：唯一提供者自动加入且不被当作孤立依赖移除。无法满足的需求在 `unmet` 中返回，原因为 `missing-provider`、`ambiguous-provider`、`approval-required` 或 `excluded`；前两种阻止创建会话，后两种是玩家的选择，不阻止。

世界的 `pluginPolicy` 使用 `presetId/preferredTags/avoidedTags/requested/recommended/packs`；组合包使用 `requested/recommended`。推荐项不自动启用，也不会覆盖玩家显式排除。`GET /api/worlds/:id/plugin-plan` 的 `defaultPluginIds` 是初始显式请求，准备页和创建端再使用同一解析器计算活动集合。该接口返回的各 `requested` 与 `defaultPluginIds` 只含已安装插件；世界或组合包请求但未安装的插件列在 `missing`，由准备页提示，不进入创建请求。

准备页切换玩法包会替换上一个包贡献的请求，包括世界初始选中的包。初始默认请求中同时被初始包请求的插件归该包所有，即使它也命中世界的 `preferredTags`：切换后只有新包请求它才保留，所以新包的叙事引擎能替换旧包的引擎。其他初始默认请求、世界 `requested` 和玩家手动添加的请求保留，显式排除继续优先。手动修改会清除包卡片高亮，但旧包来源仍保留，下一次切换不会累加旧包；手动重新启用的包内插件作为手选保留。世界的 `requires` 仍由解析器独立校验，不能把 `requested` 当作不可取消的必需项。

发现 DTO 区分 `kind`、宿主 `hostState` 与会话 `sessionState`，运行时提供 `outputContract`。未授权社区插件可保留在请求列表，但不能进入执行集合；许可绑定会话身份与审批范围。

## 本地化与验证

目录级 `pnpm validate:plugin <dir>` 与 ZIP 安装共用静态文件和 runtime 检查：引用的 entry、handler、guard、JSON Schema 和 UI 文件必须存在于包内；自动/定时 runtime 必须有 stage；builtin 工具名和插件工具声明、包内 runtime 引用以及根契约依赖必须一致。这些检查不执行插件代码，不能替代启动时的注册一致性检查。

`agent.history.includeSummaries: true` 可让有限 `maxTurns` 窗口继续读取持久摘要；默认仍不带摘要。带窗口的 runtime 不触发共享历史压缩。内置 guide 使用最近两个回合和摘要；其余内置记账 agent 的窗口是 0 或 1 个回合，取法见 [Prompt 结构](prompt-structure.md#记账-runtime-的布局)。

canonical `PLUGIN.md` / `RUNTIME.md` 的正文和 `contributes.prompt` 固定段必须是 English。只有简体中文有变体：根文件用 `PLUGIN.zh.md`，子 runtime 用 `RUNTIME.zh.md`，其中只写正文和固定段的 `content`，frontmatter 可以为空。结构字段由 canonical 文件决定，变体不能改变契约、工具、stage、超时、提示词段 ID 或位置。简体中文会话读取中文变体，其余语言（包括繁体中文）读取 canonical；其他语言的变体文件不被读取。`COVEL_INSTRUCTION_LOCALE=en|zh` 可以为所有会话固定指令语言。玩家可见的标签（`displayName`、`description`、`label`、`title`、`summary`、`about`）在主清单里写 English，译文放在插件根目录的 `locales/<locale>.yaml`，按清单文件分节、只写译文，可以是任意语言；加载器把它们编译成 locale map。标签文件只能翻译这些字段，写到契约字段或提示词内容上的条目会被忽略，`pnpm validate:plugin` 报为错误；主清单里的内联 locale map 同样报错。同一个文件的 `messages` 一节翻译 UI spec 和代码里的文字（English 原文 → 译文）：界面文字的规则见 [UI 面板](./ui-panels.md#插件-ui-文本规范)，代码用 `translate(ctx, …)` / `labelText(ctx, …)` 读取。格式见 [i18n](./i18n.md#2-本地化插件)。

内置插件里模型会读取的提示词（agent 正文和固定段）必须有中文变体；function runtime 的正文是说明文档，只写 English；社区插件只需要 English。两种语言必须提到同一组工具、注入块和 `runtime-inputs.<name>`；`pnpm check:prompts` 检查这一点，并用 `plugins/prompt-variants.lock.json` 发现“英文改了、中文没跟”的情况。两边都更新后运行 `pnpm prompts:lock`。完整规则见 [i18n](./i18n.md#内置语言与扩展边界)。

静态提示词与 runtime 正文的语言版本都在 definition/generation 加载时捕获。执行按有效 locale 从该快照选择正文，不重新读取正在热更新的文件；语言选择不能改变 canonical manifest 的权限或执行合同。

```sh
pnpm validate:plugin plugins/example
pnpm validate:plugin plugins/example/runtimes/extract/RUNTIME.md
pnpm check:prompts
pnpm --filter @covel/plugin-example test
pnpm lint
```

`validate:plugin` 执行静态作者校验，不执行 entry。builtin 的真实注册、声明对齐及发布验收由 `apps/server/tests/bootstrap/builtin-plugin-entries.test.ts` 随全量 `pnpm test` 执行；此验收不执行社区 entry。

新增行为应测试正常输出、无效输入与数据归属，涉及执行失败还应验证 proposals 不会部分提交。社区插件服务端代码在用户授权后加载；manifest 声明不是授权本身。

## 代表性实现

| 需求                 | 内置示例                                                           |
| -------------------- | ------------------------------------------------------------------ |
| 叙事提供者与用户设置 | [narrator](../../plugins/narrator/PLUGIN.md)                       |
| 本地工具和 UI 消息   | [guide](../../plugins/guide/PLUGIN.md)                             |
| World Model 初始化   | [world-init](../../plugins/world-init/PLUGIN.md)                   |
| 角色创建与跟踪       | [char-creator](../../plugins/char-creator/PLUGIN.md)               |
| 函数运行时与公开输出 | [world-time](../../plugins/world-time/PLUGIN.md)                   |
| 历史变换扩展         | [branch-reply](../../plugins/branch-reply/PLUGIN.md)               |
| 状态摘要槽位         | [core-quest](../../plugins/core-quest/PLUGIN.md)                   |
| 记忆定义与提取       | [memory](../../plugins/memory/PLUGIN.md)                           |
| 历史压缩扩展         | [history-compaction](../../plugins/history-compaction/PLUGIN.md)   |
| 舞台与媒体记录       | [scene-stage](../../plugins/scene-stage/PLUGIN.md)                 |
| 背景音乐调度         | [soundtrack](../../plugins/soundtrack/PLUGIN.md)                   |
| 世界数据进入叙事提示 | [character-blueprint](../../plugins/character-blueprint/PLUGIN.md) |
| 隐藏世界数据与策划   | [story-events](../../plugins/story-events/PLUGIN.md)               |

### 保留的数据命名空间

整个 `_` 前缀保留给内核，插件不能经通用 plugin-data API 或 proposal 写入或删除这些 namespace，包括未知的 `_` 名和旧 `_memory`。`_hidden.<namespace>` 存放 `visibility: hidden` 世界数据和插件在剧情中追加的隐藏内容，只有所属插件的 runtime 能读，也只有所属插件自己的代码能写。插件日志通过受限 logger API 产生；业务数据使用 `blocks`、`definitions` 等普通名称。`__kernel:<subsystem>` 是不同的 owner 分区，插件绑定的读取接口不可访问它。完整清单与读取权限见[存储架构](../architecture/storage.md#plugin-data-ownership-and-reserved-names)。

World data authoring sources may declare `localeArrayKeys` (for example `[label]`) alongside `key`. These additional identity fields match nested object lists to sparse translations after the source key and `id`; keep each matching key in the locale file. See [World Data](./world-data.md#语言文件namelocaleext).

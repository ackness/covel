# 插件契约参考

这一页列出插件包能写的全部声明：根 `PLUGIN.md` 的字段、runtime 的字段、输入输出的规则，以及随 Covel 内置的插件清单。写插件、改插件或审查插件时来这里查。第一次写插件请先读[第一个插件](../plugins/first-plugin.md)和[插件要点](../plugins/essentials.md)。

一个插件包做三件事：

- 在根 `PLUGIN.md` 里说明自己是谁、提供和需要哪些契约、贡献了什么（工具、数据、界面等）。
- 用零个或多个 runtime 执行工作。runtime 是一次可被调度的执行单元，要么由模型驱动（`agent`），要么是一段 JavaScript（`function`）。
- 存储、事务、调度、工具执行和扩展点由框架提供，玩法含义由插件提供。

内置插件的源码在 [plugins/](../../plugins/)，可选插件在[官方社区仓库](https://github.com/covel-ai/covel-plugins)。

> [!IMPORTANT]
> Covel 只支持本页描述的格式。平铺的旧清单、放在子目录里的 `PLUGIN.md`、角色镜像和旧 checkpoint 开发数据都读不了，需要重新生成；没有迁移读取，也没有双写。

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

布局规则：

- 根 `PLUGIN.md` 必须有，它的 `id` 必须和包目录同名。`framework` 留给框架自己，不能用作 `id`。
- 只有一个 runtime 时，写在根文件的 `runtime` 里，根文件的正文就是它的提示词。
- 有多个 runtime 时，每个放在 `runtimes/<id>/RUNTIME.md`，逻辑 ID 是 `<pluginId>/<id>`，各自文件的正文是各自的提示词。
- 两种布局不能混用。子 runtime 不能声明包级贡献。
- 只有 entry、UI 或扩展的包可以一个 runtime 都没有。

`runtimes/` 的每个实际子目录都必须有大小写准确的 `RUNTIME.md`；共享代码放在插件根目录的 `lib/`。缺少清单时，加载器报告路径并继续加载包内其他 runtime；静态校验和安装拒绝该布局。runtime 子目录的符号链接不参与发现或本地化扫描。

所有 `PLUGIN.md`、`RUNTIME.md` 和它们的语言变体，开头必须是用单独一行 `---` 包起来的普通 YAML。`---javascript`、`---js` 这类会执行代码的写法在解析前就被拒绝，所以安装、手动放入目录和重载都不能借元数据运行代码。

字段的完整清单由 Zod schema 生成，不手工维护：

- [plugin-manifest.schema.json](../../packages/shared/schemas/plugin-manifest.schema.json) · [字段表](./schema/plugin-manifest.md)
- [runtime-manifest.schema.json](../../packages/shared/schemas/runtime-manifest.schema.json) · [字段表](./schema/runtime-manifest.md)

本页的表格只概括每组字段的用途。哪些字段合法、类型、是否必填和取值，以生成的字段表为准。

写代码校验清单时，从 `@covel/shared` 导入两个入口：`pluginManifestSchema` 校验包清单，`runtimeAuthoringManifestSchema` 校验作者写的 runtime。更细的 schema（输入输出配置、命令参数、投影项、绑定引用等）是内部实现，不从包入口单独导出。

加载器怎样处理这些文件：

- 作者写的格式会被编译成内部的执行结构 `RuntimeManifest`。内部结构的字段不是作者格式，不能抄到 `PLUGIN.md` 的根层。
- 加载结果分成两部分：包定义 `ParsedPluginMd` 和执行定义 `ParsedRuntimeMd`。
- `loadPluginDefinition()` 返回必有的 `packageManifest` 和一个 `manifests` 数组。数组为空，就没有可调度的 runtime。
- `parsePluginMd()` 只解析包。根文件里的内联 runtime 由 `compileInlineRuntime()` 显式编译。
- 包的 entry、UI、事件、命令和扩展只从根定义注册一次，不会复制到每个 runtime。runtime 保留自己的执行身份和版本，并继承执行需要的用户设置和数据 schema。

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
| `version`, `displayName`, `description`, `tags` | 元数据；标签用于准备页的分组和筛选，不决定运行时调度                                                        |
| `covel`                                         | 适配的宿主版本范围，如 `">=0.0.45"`；范围之外的宿主不安装也不加载该包                                       |
| `author`, `license`, `homepage`                 | 作者信息，只用于展示；见[作者信息](#作者信息)                                                               |
| `provides`                                      | 版本化契约字符串，或 `{contract, default: true}`                                                            |
| `requires`                                      | 必需契约，解析器补入提供者                                                                                  |
| `optional`                                      | 可选契约，不强制激活提供者                                                                                  |
| `conflicts`                                     | 与提供这些契约的其他插件互斥                                                                                |
| `contracts`                                     | `{contractId: {schema: ./path.json}}` 契约 schema 声明；被 `contributes.data` 的 namespace 接收的契约不用写 |
| `entry`                                         | 包根相对的注册模块路径                                                                                      |
| `contributes`                                   | 包级贡献，见 [contributes 字段](#contributes-字段)                                                          |
| `runtime`                                       | 可选的单 runtime 声明                                                                                       |

契约是一个带版本的名字，形如 `narrative-engine@1`。插件之间靠它互相找到对方，而不是靠插件 ID。几条规则：

- `runtime.io.output.contract` 必须出现在本包的 `provides` 里。
- 同一个包里，两个 runtime 不能产出同一个契约。
- 不同的包可以提供同一个契约。消费者用 `cardinality: one` 或 `all` 说明要一个还是全部。
- 只允许一个提供者的扩展点，以及显式写出的 `conflicts`，另外做互斥检查。
- `conflicts` 只能写插件契约。写内核扩展点或 UI 槽位会得到 `invalid-conflict`，并指出 `conflicts` 字段的位置。内核扩展点怎样组合由它的 mode 决定。

准备页按插件声明的第一个标签分组，组名直接显示标签原文；没有标签的插件放入“无标签”。每个插件只出现一次，后续标签仍可用于筛选。`kind: core` 的徽章显示“默认启用”，不表示锁定；会话列表的“内置”只表示来源。

### contributes 字段

| `contributes` 字段 | 对应注册或资源                                           |
| ------------------ | -------------------------------------------------------- |
| `tools`            | `registerTool` 的工具名                                  |
| `actions`          | `registerRpc` 的 action 名                               |
| `commands`         | 玩家命令元数据；`action` 必须列入 `actions`              |
| `services`         | `registerService` 的契约 ID                              |
| `extensions`       | `provideExtension` 的 `{point, id}`                      |
| `hooks`            | hook 的 `{event, enforce}` 声明，见 [Hooks](./hooks.md)  |
| `wires`, `forms`   | 对应注册 ID                                              |
| `events`           | 插件事件契约                                             |
| `settings`         | 玩家配置项，运行时通过 `ctx.userSettings` 读取           |
| `data`             | 本插件数据 namespace 的 schema、version、accepts、search |
| `ui`               | 包根相对的 `right/message/left` UI spec 路径             |
| `worldProjections` | 世界数据投影声明                                         |
| `prompt`           | 静态提示词段                                             |

entry 里的注册和清单里的声明双向核对：注册了却没声明，或者声明了却没实现，加载都会失败。包级贡献只属于根文件，不会合并子 runtime 的字段。

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

- **链接只接受 `https`**，不能带用户名和密码。`http:`、`javascript:`、`file:` 等地址在清单校验时被拒绝。这些链接是作者提供的第三方地址，宿主没有审核。玩家点开任何一个之前，界面先显示完整地址和域名并说明这一点，确认后才在浏览器中打开。域名以 ASCII 形式显示，用其他文字写成的仿冒域名会显示为 `xn--…`。
- **展示位置**：世界列表（作者 · 版本）、世界详情、开局准备页的世界卡片和插件行、设置里的已安装插件。安装预览只显示作者名，不显示链接。进入游玩后的界面不显示这些内容。
- **翻译**：插件在 `locales/<locale>.yaml` 的 `PLUGIN.md` 一节翻译 `author.about` 和 `author.links` 的 `label`（链接按顺序对应）。世界在 `world.<locale>.yaml` 里翻译同样两处。作者名和许可证不翻译，`pnpm i18n` 不把它们算作待翻译文本。
- **版本号**：列表显示清单里的 `version`。插件同时带 `package.json` 时两处的版本必须相同，`pnpm validate:plugin` 会检查：安装预览读的是 `package.json`，宿主读的是 `PLUGIN.md`。`version` 变化会让已有会话重跑该插件的 setup runtime，所以 setup 的 guard 或 handler 必须对已完成的工作返回跳过。

### 契约版本策略

契约 ID 中的 `@N` 是版本标识（如 `narrative-engine@1`）。内核只承载当前版本（current-only）：不做版本协商，不同时支持多个版本，也不提供跨版本的兼容读取或双写迁移。

- 破坏性变更使用新的契约 ID（例如 `@2`）。提供者和消费者在同一个变更里一起升级，旧版本随即失效。
- 旧会话的快照和排队中的作业需要重建。
- 变更记录在 CHANGELOG 和相关 PR 的迁移说明里。

外部插件的作者应跟踪框架的 [CHANGELOG](../CHANGELOG.md)，契约变更后同步升级，并更新自己声明的契约版本。

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

根 `PLUGIN.md` 也可以写 `permissions.http`。它管 `entry` 模块的代码：社区包的 `covel.http`（工具、钩子、RPC、服务、扩展、wire 里都用它）只能访问根文件和各 runtime 的 `permissions.http` 里列出的源和方法。wire 还能访问它正在服务的那个用途的端点。没有声明的请求在发出之前就失败：`http permission denied: …`。

```yaml
permissions:
  http:
    - origin: https://api.example.com
      methods: [POST]
```

### 两种 runtime

- **Function runtime** 必须声明 `function.handler`，这个模块必须默认导出一个函数，不能同时配置 `agent`。
- **Agent runtime** 不能配置 `function`。
- `function.model` 说明 handler 里的 `ctx.gateway` 调用使用哪个模型 slot（如 `memory`）。后台（detached）任务在领取前用它判断凭证是否就绪。不声明时按系统默认 preset 判断，可能漏掉请求级的 slot 绑定，任务就会一直排队，直到 `maxQueueMs` 超时。
- `agent.model` 和 `function.model` 只写用途（slot）的名字。插件不能指定服务商、模型、地址或协议：这些由玩家的模型设置决定（见[实际选择优先级](./slots.md#实际选择优先级)）。插件目录里的 `llm.toml` 不会被读取。

### Agent 能用哪些工具

- 包里只有一个内联 runtime（runtime ID 等于插件 ID）时，没有写 `agent.tools.plugin` 的 agent 自动获得 `contributes.tools` 的全部工具。写 `plugin: []` 表示一个也不给。
- 给这样的包新增一个只想让界面动作使用的工具时，要同时给 agent 写明白名单，否则模型也能调用它。
- 多 runtime 的包里，每个 runtime 都要自己声明工具。

### Agent 的 guard

Agent 的 guard 在调用模型之前执行。

- 返回 `{ skip: false }`：照常运行。
- 返回 `{ skip: true, ...fields }`：不调用模型，结果记为 `skipped`。`skip` 之外的字段就是本 runtime 的输出。声明了 `io.output.contract` 时，这份输出按契约校验，并照常绑定给消费者；`skip` 标记本身不进入校验和绑定。

需要在本轮放弃工作时，返回契约允许的最小输出。例如 `story-events/plot` 关闭时返回空计划 `{ skip: true, events: [] }`。

### 隐藏内容的 runtime（`io.concealed`）

`io.concealed: true` 用于处理隐藏内容的 runtime，例如在剧情中策划隐藏事件的 agent。

- 框架在写入 trace 和推送实时流之前，去掉它的提示词、模型回复、工具参数、工具结果和输出，只保留 runtime 名、工具名、状态、耗时和用量。
- `/turns` 和手动 RPC 返回的执行结果也会清空它的输出和工具内容。
- runtime 失败时，发给玩家的失败原因（回合流、trace、返回的结果）换成一句固定的通用提示，真实原因只写入服务端控制台日志。
- 持久化的执行记录保留完整内容，供重试使用。
- 它输出里的文字（`narrativeOutput` 或 `content`）不写入对话日志，所以不会进入其他 runtime 的提示词历史、消息接口和“重建提示词”接口。它主动展示给玩家的内容（交互表单、UI 块）照常写入。
- 不能和 `io.visibility: story` 同时声明：story runtime 的文字就是玩家读到的正文。这样的清单在加载时被拒绝。
- 隐藏 runtime 通过 `io.output` 契约或 `effects` 把结果交给其他 runtime，由作者决定谁能读到。

### 依赖和引用的范围

`schedule.needs`、`schedule.after` 和 `io.inputs.*.from.runtime` 里写的 runtime ID 只能属于本包：写完整的 `<pluginId>/<runtimeId>`，单 runtime 的包写包 ID。不带前缀的字符串依赖会被拒绝，诊断会建议补全为 `<pluginId>/<runtimeId>`；只有其他包的完整 runtime ID 才建议改用契约。

**跨包 runtime 引用边界**：

- 包内引用（`needs`、`after`、`inputs`）是合理的实现排序和数据流，可以写具体的 runtime ID。
- 跨包依赖必须通过契约（`from.contract`）。这样提供者可以被替换，消费者不用改。
- 加载器严格检查跨包的 runtime 引用，发现就拒绝加载。
- 只写 `after` 不会自动激活提供者。

runtime 的 `schedule.needs[].contract` 和 `io.inputs.*.from.contract` 必须写进根 `requires` 或 `optional`。内联 runtime 和子 runtime 都这样检查。

- 包内其他 runtime 提供的契约也要声明。可以列入 `optional`，不需要激活别的插件。
- `schedule.after` 只排序，`from.kernel` 是内核输入。这两者都不会让别的包被激活。

### 阶段和调度顺序

阶段按 `setup → pre-turn → narrative → post-turn → audit` 推进。一个阶段全部结束后才进入下一个阶段。

- 同一阶段里的先后由依赖边决定。`needs` 是成功门控：上游成功，下游才运行。`after` 只表达先后。
- 更晚阶段的输出不能用来解锁更早的阶段。

同一回合的事件链也按同样的方式排序。每一层里实际匹配到的同步 event runtime，按 `needs`、`after` 和 `io.inputs` 建成一张依赖图：

- 同一层内互不依赖的 runtime 各自执行；一层结束后合并结果，再检查下游的成功门控和输入。
- 出现环时，环上的 runtime 和被它挡住的下游记为 `skipped: dependency-cycle`，其他分支继续执行。
- 依赖声明不会触发没有匹配到事件的提供者。
- 后台的 event follower 是独立作业，不参与这张同步的依赖图。

更早的阶段或事件层里已经成功的提供者，也可以满足 `needs` 对“单个提供者”契约的要求。这样当前这一批里的另一个候选提供者不会造成假的循环。它不撤销 `after`、“全部提供者”的要求和输入绑定带来的排序边。

### setup runtime 的注意事项

包级的 `requires` 保证契约的提供者被激活，但不要求提供者每次执行都重新产出。

- 要在后续执行里处理表单的 setup runtime，应该用 `after` 排在一次性的 setup 提供者之后，并读取已提交的状态。
- 不要用默认 turn scope 的契约 `needs`：提供者完成 setup 后不再运行，消费者会被成功门控跳过。
- `after` 不证明初始化成功。消费者的 guard 必须自己检查需要的领域状态。例如新建主角前先确认 `ctx.world.characterSchema` 已存在；不存在就明确失败，不生成表单，也不写入角色。

setup runtime 的完成状态按根 `PLUGIN.md` 的 `version` 记录。发布新版本（`version` 变了）之后，已有会话会在下一次玩家动作时重跑它：

- 还在 setup 阶段的会话，在 setup 阶段里重跑。
- 已经进入主循环的会话，经 late-setup 通道在 pre-turn 之前补跑，并重新计算重试预算。

所以 setup runtime 的 guard 必须对已完成的工作返回 `{ skip: true }`（例如主角已存在、schema 已写入）。否则升级会让玩家重新看到欢迎信息或表单。不声明 `version` 的插件按 `0.0.0` 处理，永远不会因升级重跑。

### 触发方式

触发类型有 `auto`、`scheduled`、`manual` 和 `event`。

- 自动进入主循环的 runtime 应声明 stage。`manual` 和 `event` 按请求或事件单独触发。
- `schedule.manual.execution: background` 让手动运行在后台执行。
- `schedule.completion` 控制回合是否等它结束。具体限制由清单校验和运行时准入检查执行。

### 历史窗口（`agent.history`）

`agent.history: {maxTurns}` 把 agent 提示词里的历史限定为最近 N 个回合。

- 按 `turnId` 计数，`0` 表示不带历史。
- 同时去掉压缩摘要，不参与本轮的压缩屏障。
- 省略时沿用会话共享的历史视图。
- 当前回合不计入 N：当前玩家输入和本次执行已经产出的故事正文始终发送（见 [Prompt 结构](./prompt-structure.md#本回合正文)）。

只读本轮输入的提取类 runtime 应该声明它，免得提示词随会话越来越长。

### 超时、重试和完成条件（`agent.loop`）

Agent 的超时、重试和步数都在 `agent.loop` 里。

**流式调用按“多久没有输出”限时。**

- `firstTokenTimeoutMs`：第一次输出之前最多等多久。
- `idleTimeoutMs`：之后两次输出之间最多静默多久，默认 120 秒。
- 一直在输出的模型不会被截断，输出所用的时间也不计入 `timeoutMs`。

**首次输出等多久。**

- 写了 `firstTokenTimeoutMs`：每次尝试都按这个值等待。
- 没有写：一次尝试最多等 120 秒，并且要给 `maxRetries` 还允许的重试留出时间。最后一次尝试可以用完 `timeoutMs` 剩下的全部时间。之前的尝试等待“剩余时间 ÷ 剩余尝试次数”；这个值不足 60 秒时等 60 秒，但不超过剩余时间的一半。

| `timeoutMs` | `maxRetries` | 各次尝试最多等待  |
| ----------- | ------------ | ----------------- |
| 120 秒      | 3            | 60、30、15、15 秒 |
| 240 秒      | 1            | 120、120 秒       |

所以服务商接了请求却一直不出字时，重试来得及发出。首个输出本来就慢的模型（不流出推理过程的推理模型）应该显式设置 `firstTokenTimeoutMs`，并把 `timeoutMs` 设得足够大。

**回复被截断（`finishReason: length`）。** 回复在模型的输出上限处被截断时，被截断的工具调用和 JSON 不能用。

- 这次调用以一次新的尝试重试一遍，附一句“只写任务需要的内容”的提示。打转或重复输出的模型重来一次通常就能写完。
- 再次被截断才判为失败，错误信息提示调大输出上限。额度真的太小时，第二次也写不完。
- 唯一的例外：`io.visibility: story` 的 runtime 只输出了正文、没有工具调用。这时正文保留并提交，玩家看到一条“可能停在半句”的提示。

**服务商没说清为什么停（`finishReason: other`）。** 回复可能停在任何地方。和截断一样，`io.visibility: story` 的 runtime 只输出了正文、没有工具调用时，正文保留并提交，玩家会看到提示：这段没写完，可以重试这一回合。其他情况判为失败，不重试。详见 [slots.md](./slots.md#结束原因诊断与拒绝)。

**流式调用在已有输出之后中断**（连接断开，或静默超过 `idleTimeoutMs`）。

- `io.visibility: story` 的 runtime 不重试，因为玩家已经读到那段文字。
- 其他 runtime 的输出没有给任何人看，丢弃后按 `maxRetries` 重试。已经写出内容的那段时间同样不计入 `timeoutMs`，之后的静默计入。

**非流式调用**没有进度信号，由 `callTimeoutMs` 限制单次调用的总时长。

**`maxRetries`**（默认 1，最大 5）是一次模型调用拿不到回复时的重试次数。

- 会重试：调用超时、网络错误、限流、5xx、服务商报告的生成错误、上面说的输出中途中断，以及一次截断。
- 不重试：4xx 和输出 schema 不符。
- 被工具拒绝的调用不占这个次数。模型读到错误后在下一步重新调用，受步数限制。
- 重试之间没有等待。重试和首次调用共用 `timeoutMs`，也共用一次逻辑调用的请求预算（默认 120 秒、8 个 HTTP 请求，见 [slots.md](./slots.md#http-retry-cleanup)）。

预算决定了重试实际能用上几次：

- 非流式调用的 `callTimeoutMs` 为 60 秒、`timeoutMs` 为 120 秒时，卡住不返回的调用只够再试一次。流式调用按上面的首次输出等待规则重试。
- 每次都用满传输层重试的 5xx 也只够两轮。
- 很快返回、只占一个 HTTP 请求的失败（连接在应答中途断开、生成错误）才用得上更多次数。
- 内置的记账 agent 和开局 agent 设为 3。

**完成条件。**

- `completion.afterTools`：指定的工具成功后就结束。
- `completion.require: tool-use`：声明了非空的 `afterTools` 时，至少一个列出的完成工具必须成功。没有列表时，任意成功的业务工具调用都算。失败的调用和 `runtime-done` 不算。
- 模型只回了纯文本，或者调用了 `runtime-done`，而这时还没有这样的调用：框架先注入一次纠正提示，仍未完成才判为失败。所以“无变化”也要通过业务工具提交一个空结果。
- 纠正之后的那次请求要求模型必须调用工具（`toolChoice: "required"`，清单指名的工具保持不变）。模型调用工具后恢复自选。模型处于思考模式时服务商不接受强制选择，这时仍由模型自选。
- 这个判定在循环返回处统一进行，普通执行和 resume 的所有结束方式都适用：文本回答、`runtime-done`、`afterTools` 自动完成、`PostToolUse` Hook 终止，以及步数用尽。

### Function 的工具和超时

- Function 的工具白名单在 `function.tools`，它控制 `ctx.tools.call` 能调用什么。
- Function 的超时在 `function.timeoutMs`。不要把外部服务的执行时限写到 agent 配置里。
- Function 通过 `ctx.gateway` 发出的文本调用（`generateText`、`generateObject`、`evaluate`）不是流式的，没有进度信号。模型接了请求却一直不答复时，宿主在 `function.timeoutMs` 剩余时间的一半处（至少 60 秒）放弃这次调用并重发一次，第二次用剩下的时间。
- 剩余时间不够放第二次（不超过 60 秒）时只发一次，由 `function.timeoutMs` 结束。
- 被服务商拒绝的请求仍由网关的传输层重试和后备模型处理，不在这里重发。
- 单次调用确实需要更久的 handler 应该调大 `function.timeoutMs`。

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

#### 输入怎样读取

- 普通输入读同一次执行里已完成的上游结果。`select` 是结果值上的 JSON Pointer。
- 要读更早的执行留下的结果，用 `scope: committed` 加 `recordAs`。
- schema 可以是本地路径，也可以写 `contract:<contractId>`。跨提供者的契约 schema 在加载时解析。
- 在提示词里，一个输入位于 `runtime-inputs.<binding>.value`。不要依赖旧的注入标签。
- 叙事之后运行的 agent 如果绑定的是本回合的故事正文，这个 `value` 是一句指向对话里那条正文消息的话，正文本身不重复（见 [Prompt 结构](./prompt-structure.md#本回合正文)）。
- 输入绑定的名字只匹配显式声明的 schema 和 slot。`constructor`、`toString` 这样的名字不会读到 JavaScript 的继承属性。

#### 静态检查

CLI 和安装器的静态校验对 `scope: turn` 和 `scope: committed` 的输入都检查：

- 本地的 `accepts` 文件必须存在，而且是有效的 JSON。
- 直接引用的 producer runtime 必须在同一个插件包里。
- `scope: committed` 不允许写 `select`（空字符串也不行），错误定位到 `io.inputs.<binding>.select`。普通的 turn 输入仍然支持 JSON Pointer。
- 可选的外部契约不会因此要求提供者已安装。

#### `select` 和可选输入

- `select` 遵循 RFC 6901。数组索引写 `0` 或没有前导零的十进制整数；`/01`、`/+1` 不匹配数组元素。
- `required: false` 的输入，在静态 schema 不兼容或实际值没有通过校验时，这个槽位被省略。消费者照常运行，并解析其他输入。
- 静态的 pattern 证明只处理完整的、带锚点的字面前缀（如 `^audio/`）。含分组、量词或分支的正则交给实际值校验，不会截取表面的前缀来拒绝有效输入。

#### 发布输出契约

发布 runtime 的输出契约时，在根 `contracts.<contractId>.schema` 声明完整输出的公共 schema。

- 同一个契约 ID 的所有提供者必须发布一致的 schema。
- 公共 schema 同时覆盖模型输出和 guard 跳过输出。例如 `world-init` 的 `world-data-provider@1` 允许作者提供少于 15 项的属性结构；生成至少 15 项的要求留在 `initialize-world` 的工具参数中。
- 替代插件的 `provides` 必须和它自己 runtime 的 `io.output.contract` 对齐。其他已安装插件的产出不能替它满足声明。
- 被消费的契约缺少 schema，或者提供者只有声明而没有产出，都会产生加载诊断。

#### 契约在哪里被校验

- 内核在 runtime 最终输出的边界校验已发布的契约。失败的结果不能提交领域 effects，也不能写入 `recordAs`。
- 同一轮的输入在应用 `select` 之前，再校验一次完整输出。
- `scope: committed` 的输入读取冻结的完整 export 之后，同样校验公共契约，即使没有显式写 `accepts`。
- 消费者的 `accepts` 可以再加限制，但不能关闭公共契约的校验。
- `cardinality: one` 的 `accepts` 校验单个业务值。`all` 校验按 runtime ID 排序的业务值数组，包括数组长度和唯一性约束；公共契约仍然分别校验每个提供者。
- `required: false` 的输入如果把 `accepts` 指向 `contract:<id>`，而没有任何已安装的包发布这个契约，runtime 照常加载，因为发布它的插件本身是可选的。这时无法校验的值不会注入，诊断为 `accepts-contract-unresolved`。必填输入遇到同样的情况，仍然加载失败。

契约发生变化时，应该重建受影响的开发期会话数据和历史 exports。

#### 结果的三个部分

内部的 `RuntimeResult` 把三样东西分开保存：

| 部分         | 是什么              | 谁读它                         |
| ------------ | ------------------- | ------------------------------ |
| `output`     | 业务输出            | 下游输入、契约校验、`recordAs` |
| `effects`    | 显式的副作用        | 提交、事件后继、待处理的交互   |
| `completion` | `done` 或 `pending` | setup 是否完成的判断           |

`outputKind: story` 的 `output.narrativeOutput` 仍然按声明发布为叙事。

#### Function 的输出

Function 的输出契约以 handler 返回的 `value` 为准。它可以是标量、数组、对象或 `null`。

- 运行时用 `canonicalValue` 保存原始的业务值。对象投影为 `output`；标量、数组和 `null` 投影为 `{ value }`；没有值时投影为空对象。
- 业务值里叫 `events`、`pluginData`、`interactions` 或 `preGameDone` 的字段不会发起副作用，也不会完成 setup。这些意图必须通过 `HandlerResult.effects` 和 `HandlerResult.completion` 表达。
- `effects.interactions`、`effects.notifications` 和 `effects.statePatches` 必须是数组，其中的条目以及 `effects.ui[].parts` 必须是对象。function 返回了不是数组的通道或不是对象的条目时，以 `output-schema-invalid` 失败。其他途径带进来的同类内容，在提交时作为该 runtime 被拒绝的写入处理（见[事务参考](./transactions.md)）。
- 同一轮的输入、公共契约校验和 `recordAs` 发布，读的都是同一个业务值。
- 没有提供 `value` 时不发布 export。不要靠猜 `output.value` 来拆箱。
- 普通输入的 `select` 作用在这个业务值上。committed 输入读完整的 export，不支持 `select`。

#### Agent 的输出

Agent 的副作用只来自工具：模型能写什么，以 `agent.tools` 白名单为准。

- 执行边界把工具结果里的副作用（工具返回的 proposal、`emit-event` 发出的事件、表单和 UI 块）归入 `effects`，把最终输出里的 `preGameDone: true` 或 `completion` 转成完成信号。
- 模型在最终 JSON 里写的 `statePatches`、`pluginData`、`notifications`、`assetGenerations`、`interactions`、`ui` 和带 `topic` 的 `events` 不起作用，和 function 业务值里的同名字段一样。这些字段在拆分时被去掉，服务端日志记一条带 runtime 名和字段名的警告。
- 不带 `topic` 的 `events`（例如 WorldIR 的业务事件）保留在 `output.events`。
- 结束工具自己的返回值作为输出时，其中的副作用字段照常生效，因为它出自白名单里的工具。
- Agent 的公共契约值是拆分之后的业务 `output`。普通执行和 resume 用同一条边界。

#### Hook 改写结果和 schema 检查

- `PostRuntime` 如果改变 function 的 `output`，应该同时明确提供匹配的 `canonicalValue`。新值会重新接受私有和公共 schema 的校验。
- 只改写 `output` 会撤销业务值，停止 export 和下游的值绑定。有公共输出契约时，还会因为缺少契约值而失败。
- 要修改副作用或完成信号，直接改 `effects` 或 `completion`。
- 失败 runtime 的副作用不提交，它的事件不触发后继 runtime。
- 普通执行和 resume 共用 agent 的输出 schema 检查。非 story 的 agent 声明私有 `io.output.schema` 后，先校验候选的协议输出，再拆分业务值和副作用。最终没有正文或正文为空也接受校验；不符合 schema 就失败，暂停期间积累的写入不提交。
- Story agent 保留独立的叙事正文检查，不使用私有 schema 检查。

> [!NOTE]
> 内部结果结构变化之后，受影响的开发期执行结果、exports、后台作业和快照需要重建。旧的平铺副作用结果读不了。

#### handler 上下文里的回合信息

| 字段                          | 含义                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.playerMessage`           | 当前输入的文本字符串                                                                                                                                                     |
| `ctx.logicalTurn`             | 调度器的逻辑回合：已提交的主循环玩家回合数加一。函数 handler 和插件工具的上下文里都有。setup、开场续写和第一条玩家消息同为第 1 回合，`startTurn` / `interval` 也按它计数 |
| 工具上下文的 `turnNumber`     | 会话里已记录的玩家消息数，包括 setup 的表单提交                                                                                                                          |
| `ctx.session.lastPlayerInput` | 源执行开始时最近的一条 `PlayerInputSubmission \| null`，包含 `id/sessionId/turnId/formId/values/createdAt`                                                               |
| `ctx.execution.origin`        | 这次执行因何而起：`player`、`continuation`、`manual`、`background`、`recursive` 或 `resume`。agent guard 没有 `ctx.execution`                                            |
| `ctx.execution.sourceTurnId`  | 重试一个已提交的回合时，是那个回合的 ID。用它做键，重试时复用上次的掷骰和揭示，不重新抽                                                                                  |
| `ctx.recursionDepth`          | 顶层执行是 `0`，`ctx.recursiveCall` 每嵌套一层加一                                                                                                                       |

`ctx.session.lastPlayerInput` 可能来自更早的回合。有这条记录不等于本回合提交了表单。

#### 会话视图（`store.getSession()`）

`ctx.store.getSession()`（工具里是 `context.store.getSession()`，action 里是 `context.store.getSession()`）返回当前会话的只读视图 `PluginSessionView`，不是会话记录本身：

| 字段                   | 含义                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `phase`                | `setup` 或 `playing`                                                                                                                                                                             |
| `completedPlayerTurns` | 已提交的主循环玩家回合数；setup 和开场不算                                                                                                                                                       |
| `locale`               | 这一局的内容语言                                                                                                                                                                                 |
| `setupRuntimes`        | 每个 setup runtime 的进度，键是 runtime ID：`{ state: "pending", lastError? }`、`{ state: "done", resolution: "completed" \| "waived", warning? }` 或 `{ state: "blocked", reason, lastError? }` |

#### 随机数（`ctx.random`）

`ctx.random` 是宿主提供的随机源。函数 handler、agent guard、插件工具和 RPC action 的上下文里一定有它，类型上也是必有的字段。

- 骰子和其他游戏内的随机取数用 `ctx.random.int(min, max)`。它返回 `min <= n < max` 的整数，和 `node:crypto` 的 `randomInt` 相同。
- 不要直接用 `node:crypto` 或 `Math.random`。
- 平时它就是 `randomInt`。测试服务端设置 `COVEL_RANDOM_SEED` 后，同一个 runtime（或同一个 RPC action）取的第 n 个数每次运行都相同，脚本会话因此可以重复（见[环境变量](./env-registry.md#runtime-contract)和[录制与回放](../ship/real-model.md#录制与回放)）。
- `shortId` / `shortIdBatch` 的第四个参数必须传它，ID 的随机部分也随之可以重复。SDK 里没有别的随机来源可以退回。

#### 模型看不到的簿记字段

**记录里的簿记字段不给模型。** 会话 ID，行、回合、结果的 UUID，还有写入时间，对模型没有用：它们占 token，抄回来容易抄错；时间戳在行每次重写时都会改变提示词；同一个会话跑两遍，它们也各不相同。

内核把记录写进提示词时会去掉它们：

- `io.selfData` 的每一行是 `- <key> | <值的 JSON>`（`summary` 格式截断到 200 字符）。不带行的 `updatedAt`，值里和 key 相同的 `id` 也不重复。
- 下面这些内容在交给模型之前经过同一个投影：`<runtime-inputs>` / `<runtime-exports>` 的值、`<runtime-activation>` 的载荷、`{{ world.schema }}`、`{{ characters.npcs }}` 的 fields、SDK `characterSheetSegments()` 的玩家表和 NPC fields，以及没有 `_text` 的工具结果。

属性名和取值都符合才会被去掉：

| 属性名                       | 取值                        | 结果 |
| ---------------------------- | --------------------------- | ---- |
| `id`，或以 `Id` / `Ids` 结尾 | UUID，或全是 UUID 的数组    | 去掉 |
| `timestamp`，或以 `At` 结尾  | ISO 时间                    | 去掉 |
| `sessionId`                  | 任意                        | 去掉 |
| `id`                         | `"npc-lin-yao"` 这类可读 ID | 保留 |
| `date`                       | `"1943-06-01T08:00:00Z"`    | 保留 |

> [!WARNING]
> 这个判断只看名字和取值的形状，分不出剧情里的时间。故事内的时刻如果存成 `diedAt: "1943-06-01T08:00:00Z"`（名字以 `At` 结尾或叫 `timestamp`，取值是 ISO 时间），模型同样看不到它，运行时也没有任何报错。要给模型看的剧情时间请换一个名字（`date`、`diedOn`），或者不写成 ISO 时间（`"1943 年 6 月 1 日清晨"`）。世界包里的数据和插件自己存的数据都适用。世界包里的这类字段，`pnpm validate:world` 会给出 `model-hidden-field` 提醒；插件运行时自己存的数据不在检查范围内。

代码读到的记录不变：`ctx.inputs`、`ctx.activation`、`ctx.pluginData`、`ctx.tools.call` 的返回值都是完整的。

- 插件自己拼提示词（例如直接调用 `ctx.gateway`）时，用 `@covel/plugin-handlers-utils` 导出的 `modelFacingJson(value)` 做同样的事。
- 工具要把一个不透明的句柄交给模型时，写在 `_text` 里。

#### 内核输入 `turn-digest@1`

内核输入 `turn-digest@1` 冻结源回合的事实。前台 runtime 和后台作业读到同一个值，SDK 里的类型是 `PluginTurnDigest`：

| 字段                | 含义                                                   |
| ------------------- | ------------------------------------------------------ |
| `turnId`            | 源回合的 ID                                            |
| `playerMessage`     | 玩家这一回合的输入                                     |
| `lastPlayerInput`   | 和 `ctx.session.lastPlayerInput` 同一份快照，或 `null` |
| `narrativeText`     | 这一回合成功的 story runtime 写的正文，用空行连接      |
| `toolCallSummaries` | 成功、可见的工具调用，每次一行简短摘要                 |
| `runtimeResults`    | 已结束的 runtime：`{ runtimeId, status }`              |
| `locale`            | 这一局的内容语言（有时才有）                           |

- `runtimeResults` 是已经观察到的终态 `{runtimeId, status}`，`status` 为 `success/failed/skipped/suspended`。还没结束的 runtime 不会被预测为成功。
- 后台（detached）worker 读的是源执行的快照，不重新查询最新的表单或回合状态。
- 这个输入契约更新之后，旧作业和快照需要重建，不做兼容读取。

## World Model 与数据边界

角色 schema、角色和世界记录属于内核的 World Model。插件只读它，写入要走 proposal。

- `ctx.world.characterSchema`、`ctx.world.characters` 和 `ctx.world.worldRecord` 是只读视图。读到的对象是冻结的（`Object.freeze`，嵌套对象也是），修改它会抛 `TypeError`。要排序或改动，先自己复制（`[...ctx.world.characters]`、`structuredClone`）。
- 在本次执行缓冲新的写入之前，重复读取返回的是同一份对象。循环里逐个查角色不会每次复制整份列表。
- 这些领域里合法的上游 proposals，以及本 runtime 已经缓冲的 proposals，对后续的读取可见。
- 写入通过 proposals，在提交时统一校验。
- `ctx.world.dimensions` 不一样：它是提供者发布的公共当前值快照，遵守下面[动态维度](#动态维度)里单独的冻结规则。

**按名字找角色。** 角色除 `name` 外可以有 `aliases`（同一个人的其他叫法）。

- 把模型写的名字对应到角色时，用 SDK 的 `resolveCharacter(ctx.world.characters, name)`，不要自己比较字符串。它按 ID、名字、别名依次匹配；名字有歧义或不存在时，分别返回 `ambiguous` / `missing`（带最相近的角色）。
- 插件按名字保存自己的记录（好感、关系节点、图鉴条目）时，先解析出角色，用它的 `name` 作键。这样同一个人的两种叫法不会变成两条记录。
- `characterNameKey` 给出比较用的归一形式，`mergeCharacterAliases` 合并别名列表。
- 要从一段文字里找出提到了哪些角色（选角、检索），用 `mentionedCharacterIds(text, characters)`。以空格分词的文字要求词边界（`Rin` 不在 `spring` 里）；被另一个角色更长的名字盖住的命中不算（`会长` 不在 `副会长` 里）。

规则见[别名与按名字解析](./world-model.md#别名与按名字解析)。

**角色类型和 schema。**

- 角色类型是 schema 里声明的开放字符串。`player` 是保留的类型，每个会话最多一个。
- 角色字段遵守 CharacterSchema 的 attributes。
- 修改 schema 的 proposal 是 `character.schema.set`，payload 直接包含 `types` 和 `attributes`，版本由内核递增。

**插件自己的数据。**

- 插件自有的持久数据经绑定的 `ctx.store.getPluginData(namespace, key)` 和 `listPluginData(namespace)` 访问。
- 插件不能指定任意的 sessionId 或 pluginId 去读其他插件的私有数据。
- 要跨插件公开数据，用契约、服务或扩展，不要扫描对方的 namespace。

**Lorebook。** Lorebook 条目的身份由 owner 和 id 两部分组成，owner 是 world、plugin 或 player。HTTP 的玩家编辑路径只管理 owner 为 player 的条目。不要用字符 ID、插件 ID 或任意 namespace 来模拟角色表和 Lorebook 的归属。

### 动态维度

`world.dimensions@1` 发布 `{id: {name, description?, schema, value, version}}`。

- 插件读当前值用 `ctx.world.dimensions.<id>.value`。
- 不要从 `worldRecord.dimensions` / `metadata.dimensions` 取当前值，那里是作者的定义和初值。
- 不要扫描另一个插件的 `_dimensions`。

内置的 `world-init` 有四个和维度有关的 runtime。`dimension-clock` 排在时间结算和 `dimension-tracker` 之后。

| Runtime             | 阶段               | 职责                                                                                                                                                                                         |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dimension-context` | pre-turn function  | 不调用模型，读取已提交值并发布 `world.dimensions@1`                                                                                                                                          |
| `dimension-tracker` | post-turn agent    | 必须绑定本轮叙事，按作者规则维护；WorldIR 为可选辅证，本轮结算后的世界时钟（`world-time-evolution@1`）为可选输入；`toolChoice: required`，无变化也以 `update-dimensions({updates: []})` 结算 |
| `dimension-clock`   | post-turn function | 不调用模型，按本轮结算后的世界时钟（`world-time-evolution@1`，可选输入）计算 schema 里带 `x-derive` 的字段，值有变化时提交 `dimension.update`                                                |
| `edit-dimensions`   | manual function    | 玩家改值、确认人工处理或明确跳过                                                                                                                                                             |

**读取。**

- 同一次执行里，公共的维度读取是冻结的。
- setup 初始化和写入者自己的 proposal 可以形成局部预览。预览不替换公共快照，也不泄露给并行的其他 runtime。
- 内置工具 `world-dimension-get` / `world-dimension-list` 始终读冻结的快照，不叠加调用者自己的写入，也不回退到初值。
- 模板里用 `{{ world.dimensions.<id>.value }}` 取值。默认的提示词段是预算内的投影，不是全量记录。

**写入。**

- 用领域 proposal `dimension.initialize` / `dimension.update`。只有受信的属主可以写。更新带 `expectedVersion`，整批做版本比对（CAS）。
- 普通的 `plugin.data`、batch、delete 或 action RPC 的 store 写入不能碰 `_dimensions` / `_dimension-settlements`。
- 维护工具的来源和读取版本集由框架获取，模型只提交新值。
- 没有变化也要调用 `update-dimensions({updates: []})`。不能因为 runtime 成功就推断已经结算。

**结算失败之后。**

- 自动维护失败或没有运行时，保留一张 `pending-settlement` 回执，下一次叙事之前必须解决。
- 下一个玩家动作开始前，宿主先自动重试一次。仍然失败才阻止并提示玩家。
- 恢复用的元数据由 `session.world-context@1` 提供，并经宿主验证。editor 是 manual runtime RPC；重试直接调用 tracker 并带上 `retryFromTurnId`。
- 普通的手改不会自动解决源回合的义务。已经终结的回执不会重复补算。

完整状态和接口见 [World Model](./world-model.md#回合时序与结算回执)和 [API](./api.md#维度编辑与待结算恢复)。

> [!IMPORTANT]
> **BREAKING CHANGE**：旧的九类 raw dimension 格式和旧副本读取已经移除。世界作者使用[统一 definition](./world-data.md#动态世界维度dimensions)；开发期的世界、会话和快照需要重建。维度不提供隐藏事件的触发层，也不改变角色、背包、好感或时间由谁负责。

### 世界数据导入

```yaml
contributes:
  data:
    facts:
      version: 1
      schema: ./schemas/facts.schema.json
      accepts: [example.facts@1]
```

namespace 接收某个契约，就说明了这个契约的记录长什么样。所以它的 `schema` 就是该契约的公共 schema，不需要在根 `contracts` 里再写一遍。只有两种情况要写 `contracts.<id>`：

- 契约不是数据契约（例如 runtime 的输出契约）。
- 两个 namespace 用不同的 schema 接收同一个契约。这时必须说明哪一份是公共的。

接收世界数据的 namespace 还可以声明 `authoring`（`title`、`summary`、`hint`、`example`、`source`、`references`、`generate`）。它告诉世界作者怎样提供这份内容，以及应用内的生成器能不能生成它。

请求期读取示例或准备可生成契约的 schema 失败时，只略过该契约并报告插件、namespace 和原因，不会停用整个插件或阻止其他内容生成。`pnpm describe:authoring --check` 仍把损坏的示例报给作者。

- 只有列出了 `accepts` 的 namespace 才能声明它。
- `pnpm describe:authoring` 汇总所有已扫描插件的声明；加 `--check` 会按 namespace 的 schema 校验每份 `example`。
- 字段见 [Plugin manifest 字段表](./schema/plugin-manifest.md)。

记录里有些值写的是世界角色属性的 `id`。用 `references` 把它们声明出来，`pnpm validate:world` 就会在开局之前检查这些值：

```yaml
authoring:
  references:
    - path: attributes[].id
      to: character-attribute
      type: number
      within: [base, max]
```

- `path`：值在每条记录里的位置。字段名用 `.` 连接，字段是列表时在后面加 `[]`。
- `to`：值指向什么。目前只有 `character-attribute`，即世界 `characterSchema` 顶层属性的 `id`。
- `type`（可选）：被指向的属性必须是这个类型。
- `within`（可选）：和这个值同级的数字字段，必须落在该属性的 `min` 和 `max` 之内。

不符合的值报为 `attribute-reference` 错误。世界没有写 `characterSchema` 时不检查，因为属性要到开局时才生成。只声明插件运行时确实会拒绝的规则，否则合法的世界会被误报。

世界数据的 source 写 `to: contract:example.facts@1`（省略 `schema` 时就是目标契约的 schema）。框架找到已激活、并声明接受这个契约的 namespace，验证 schema 后把数据分发过去。框架里不识别具体的插件 ID。`contracts` 和接收 namespace 的 schema 必须一致。完整结构见 [World Data](./world-data.md)。

世界数据的 source 可以在 `key` 之外声明 `localeArrayKeys`（例如 `[label]`）。它是附加的身份字段：在 source 的 `key` 和 `id` 之后，用来把嵌套的对象列表和只写了译文的语言文件对上。语言文件里要保留每一个用来匹配的键。见 [World Data](./world-data.md#语言文件namelocaleext)。

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

namespace 声明 `search` 之后，它的记录进入框架的记忆检索（[`memory-search`](./tools.md) 的 archival 范围）。

- 结果的 `source` 是 `archival:plugin_data`，并带 `pluginId`、`namespace` 和记录的 key。
- `search.text` 是记录值里存放待检索文字的字段名。这个字段不是非空字符串的记录不参与检索。
- 只有插件在当前会话启用时才读取。没有声明的 namespace，框架不读。
- 配置了 embedding 模型时，这些记录和 lorebook、角色记录一起写入向量索引，插件不需要另做处理。

**在插件自己的代码里排序。** 检索由框架完成，插件只决定记什么。要在自己的代码里给一批文字排序（例如在 `prompt.segment@1` 里挑出和玩家输入有关的记录），用 SDK 的 `rankTexts(query, texts, { limit, minCoverage })`。它和框架检索是同一份 BM25 实现，不调用模型。

- `coverage`（0 到 1）表示文本回答了查询的多少，可以用来丢掉只沾到常见词的结果。
- `matched` 是文本含有的查询词个数。除以 `searchTerms(query).length`，就是查询有多大比例落在这条文本上。一句长查询只和文本共有一个日常用词时，这个比例很小。
- `searchTerms` 和 `searchExcerpt` 是配套的切词和摘录函数。

**隐藏数据。** 世界包把 source 声明为 `visibility: hidden` 时，同一份数据导入到接收插件的 `_hidden.<namespace>`（例如 `_hidden.facts`）。

- 插件 runtime 通过 `ctx.pluginData.list("_hidden.facts")` 读取。
- 扩展点、模型工具、`io.selfData` 和公共 API 都读不到它。
- 揭示应该通过本回合的 runtime 输出完成，详见 [World Data · 隐藏数据](./world-data.md#隐藏数据visibility-hidden)。
- 插件自己的代码（function runtime 的 `ctx.pluginData.set`、插件本地工具产生的 `plugin.data` 提案）也可以写入自己的 `_hidden.<namespace>`，用于在剧情中追加隐藏内容。写入总是归属提案来源的插件，碰不到其他插件的隐藏数据。
- REST 接口和内置的 `plugin-data-set` / `plugin-data-set-batch` 工具不能写任何 `_` 开头的命名空间。

## 提示词与记忆扩展

- **静态段**放在 `contributes.prompt`。每项包含 `id/content/position`，可选 `role`。位置是 `system`、`pre-history`、`post-history` 或 `{depth: number}`。宿主自动注册静态段，不需要再声明扩展。`static-prompt` 是保留的注册 ID。
- **动态内容**用扩展点：动态提示词用 `prompt.segment@1`，世界上下文用 `session.world-context@1`，历史变换用 `prompt.history-transform@1`，历史压缩用 `history.compact@2`。详见[插件扩展点](./plugin-extensions.md)。这些扩展使用同一次执行的快照，不在每次调用时重读清单。
- **记忆块**属于 memory 插件。默认定义经 `memory.block-definitions@1` 服务提供，世界自定义的定义经 `memory.blocks@1` 数据契约导入。框架不聚合 `memoryBlocks` 或 `summaryFocus` 字段，也没有单独的 working_memory 表。

## 会话插件选择

每个会话启用哪些插件，由 `resolveSessionPlugins` 计算。它读四样东西：玩家明确要的（`requested`）、明确不要的（`excluded`）、授权状态，以及各插件根清单里的契约声明。结果是 `active/autoAdded/rejected`。

- 显式排除优先。被排除的 core 插件也不会被恢复。
- 有明确的提供者被激活时，默认提供者退出。
- 必需的契约会自动补入提供者。缺失、歧义、冲突和授权不足都会返回原因。
- 一个事件 topic 在一个会话里只有一个声明者。两个活动插件的 `contributes.events` 含同一个 topic 时，后被接受的那个以 `event-topic-conflict` 被拒绝，原因里写出 topic 和两个插件的 ID（显式请求先于自动依赖，其余按请求顺序）。topic 是会话内全局的名字，发出者和订阅者往往属于别的插件，所以它只能对应一份 payload schema。两个插件可以同时安装，只是不能进同一个会话。给自己的 topic 加上和插件相关的前缀可以避免撞名。
- 失去必需提供者的插件，以及没人再需要的自动依赖，会被移除。
- `requested` 和计算出的 `active` 分开保存。自动依赖不会变成玩家的显式选择。
- 世界的 `pluginPolicy.requires` 作为 `requiredContracts` 传入。世界和插件一样是依赖方：唯一的提供者自动加入，而且不会被当作没人需要的依赖移除。无法满足的需求在 `unmet` 里返回，原因是 `missing-provider`、`ambiguous-provider`、`approval-required` 或 `excluded`。前两种阻止创建会话；后两种是玩家的选择，不阻止。

**世界和玩法包怎样给出初始请求。**

- 世界的 `pluginPolicy` 使用 `presetId/preferredTags/avoidedTags/requested/recommended/packs`。玩法包使用 `requested/recommended`。
- 推荐项不自动启用，也不会覆盖玩家的显式排除。
- `GET /api/worlds/:id/plugin-plan` 的 `defaultPluginIds` 是初始的显式请求。准备页和创建端再用同一个解析器计算活动集合。
- 这个接口返回的各 `requested` 和 `defaultPluginIds` 只含已安装的插件。世界或玩法包请求了但没有安装的插件列在 `missing` 里，由准备页提示，不进入创建请求。

**在准备页切换玩法包。**

- 切换会替换上一个包贡献的请求，包括世界初始选中的包。
- 初始默认请求里同时被初始包请求的插件归该包所有，即使它也命中世界的 `preferredTags`。切换后只有新包也请求它才保留，所以新包的叙事引擎能替换旧包的引擎。
- 其他初始默认请求、世界的 `requested` 和玩家手动添加的请求保留。显式排除继续优先。
- 手动修改会清除包卡片的高亮，但旧包的来源仍然记着，下一次切换不会把旧包累加进来。手动重新启用的包内插件作为手选保留。
- 世界的 `requires` 仍由解析器独立校验。不能把 `requested` 当作不可取消的必需项。

**存档固定玩家确认的那一组。**

- 创建会话、启用或停用插件时，解析结果写进会话的 `activePlugins`。这就是玩家确认的集合。
- 插件列表、斜杠命令和执行器都用同一个函数 `resolveConfirmedSessionPlugins` 读它：从 `activePlugins` 出发，用当前安装的版本检查，不补入任何插件。后来新装的插件，`kind: core` 的也一样，不会自己加进旧存档。
- 没有安装、加载失败、当前版本缺少必需的提供者，或者和前面的成员冲突的插件，暂时不运行。原因列在 `GET /api/sessions/:id/plugins` 的 `unavailable` 里，游戏界面给出提示。其他插件照常运行。`activePlugins` 不被改写，插件恢复后它也跟着恢复。
- 不运行就是处处等于停用：不加载它的 runtime，不触发它的钩子，不接受它的服务调用、动作和表单校验，不显示它的面板，记忆检索也不读它的数据。直接调用它的动作返回 `404 plugin_not_active`，错误信息写明原因。
- 授权不影响这个集合。社区插件的代码在获准前不运行，由信任门禁按会话单独检查。
- 想按当前安装的插件重新计算，启用或停用一个插件即可。这两个操作按 `requested` 和 `excluded` 重新解析，再写回 `activePlugins`。

**发现和授权。** 插件发现接口返回的数据区分 `kind`、宿主的 `hostState` 和会话的 `sessionState`，运行时提供 `outputContract`。没有授权的社区插件可以留在请求列表里，但获准前它的代码不运行。许可绑定会话身份和审批范围。

## 本地化与验证

### 静态检查查什么

目录级的 `pnpm validate:plugin <dir>` 和 ZIP 安装共用同一套静态文件和 runtime 检查：

- 引用的 entry、handler、guard、JSON Schema 和 UI 文件必须在包里。
- 每份 JSON UI spec 声明 `view` 或 `webview` 中的一个；`view` 里的组件名必须在[组件目录](./ui-components.md)里；`repeat.statePath` 和 `$item` 的写法必须合法（见 [UI 面板](./ui-panels.md#json-render-绑定速查)）。报错给出 spec 文件和节点的路径。
- 自动和定时的 runtime 必须有 stage。
- 内置工具名和插件工具声明、包内的 runtime 引用，以及根契约依赖必须一致。

目录级检查还会在插件根目录有 `llm.toml` 时给出提醒：这个文件不会被读取，不影响通过。

这些检查不执行插件代码，不能代替启动时的注册一致性检查。

### 历史窗口里的摘要

`agent.history.includeSummaries: true` 让有限的 `maxTurns` 窗口继续读取持久摘要；默认不带摘要。带窗口的 runtime 不触发共享历史压缩。内置的 guide 使用最近两个回合加摘要；其余内置记账 agent 的窗口是 0 或 1 个回合，取法见 [Prompt 结构](./prompt-structure.md#记账-runtime-的布局)。

### 提示词正文的语言

- 主文件 `PLUGIN.md` / `RUNTIME.md` 的正文，以及 `contributes.prompt` 的固定段，必须是 English。
- 只有简体中文有变体：根文件用 `PLUGIN.zh.md`，子 runtime 用 `RUNTIME.zh.md`。里面只写正文和固定段的 `content`，frontmatter 可以为空。
- 结构字段由主文件决定。变体不能改变契约、工具、stage、超时、提示词段的 ID 或位置。
- 简体中文会话读中文变体。其余语言（包括繁体中文）读主文件。其他语言的变体文件不会被读取。
- `COVEL_INSTRUCTION_LOCALE=en|zh` 可以为所有会话固定指令语言。

### 玩家看到的文字

- 玩家可见的标签（`displayName`、`description`、`label`、`title`、`summary`、`about`）在主清单里写 English。
- 译文放在插件根目录的 `locales/<locale>.yaml`，按清单文件分节，只写译文，可以是任意语言。加载器把它们编译成 locale map。
- 标签文件只能翻译这些字段。写到契约字段或提示词内容上的条目会被忽略，`pnpm validate:plugin` 报为错误。主清单里的内联 locale map 同样报错。
- 同一个文件的 `messages` 一节翻译 UI spec 和代码里的文字（English 原文 → 译文）。界面文字的规则见 [UI 面板](./ui-panels.md#插件-ui-文本规范)，代码用 `translate(ctx, …)` / `labelText(ctx, …)` 读取。
- 格式见 [i18n](./i18n.md#2-本地化插件)。

### 内置插件的额外要求

- 内置插件里模型会读的提示词（agent 正文和固定段）必须有中文变体。function runtime 的正文是说明文档，只写 English。社区插件只需要 English。
- 两种语言必须提到同一组工具、注入块和 `runtime-inputs.<name>`。`pnpm check:prompts` 检查这一点，并用 `plugins/prompt-variants.lock.json` 发现“英文改了、中文没跟”的情况。两边都更新后运行 `pnpm prompts:lock`。
- 完整规则见 [i18n](./i18n.md#内置语言与扩展边界)。

静态提示词和 runtime 正文的各语言版本，都在加载定义（definition / generation）时捕获。执行时按有效的 locale 从这份快照里选正文，不重新读取正在热更新的文件。语言选择不能改变主清单的权限或执行合同。

### 命令

以内置的 `world-init` 为例：

```sh
pnpm validate:plugin plugins/world-init
pnpm validate:plugin plugins/world-init/runtimes/dimension-tracker/RUNTIME.md
pnpm check:prompts
pnpm --filter @covel/plugin-world-init test
pnpm lint
```

第一条命令的输出：

```text
✓ Static package validation: /Users/you/covel/plugins/world-init
  languages: text en, zh; instructions en, zh
```

- `validate:plugin` 只做静态的作者校验，不执行 entry。
- 内置插件的真实注册、声明对齐和发布验收由 `apps/server/tests/bootstrap/builtin-plugin-entries.test.ts` 检查，随全量 `pnpm test` 运行。这项验收不执行社区插件的 entry。
- 新增行为应该测试正常输出、无效输入和数据归属。涉及执行失败时，还要验证 proposals 不会部分提交。
- 社区插件的服务端代码在玩家授权之后才加载。清单里的声明不是授权本身。

## 内置插件一览

下面是 [plugins/](../../plugins/) 里随 Covel 内置的全部插件（不含 `_archive/`）。`core` 是基础功能，`plugin` 是可选玩法。“runtime”一列里，“内联”表示只有根文件里的一个 runtime，“无”表示只有 entry、扩展或界面。

| ID                                                                 | 名称         | `kind`   | 提供的契约                                           | runtime                                                                                      | 做什么                                                    |
| ------------------------------------------------------------------ | ------------ | -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [affinity](../../plugins/affinity/README.md)                       | 好感度       | `plugin` | 无                                                   | 内联                                                                                         | 追踪玩家和 NPC 之间的数值好感度，右栏显示分数、档位和变化 |
| [branch-reply](../../plugins/branch-reply/README.md)               | 回复变体     | `plugin` | `branch-reply@1`                                     | 内联                                                                                         | 提供多条可切换的回复                                      |
| [char-creator](../../plugins/char-creator/README.md)               | 角色创建     | `core`   | `character-creation@1`（默认提供者）                 | `player-init`、`character-tracker`                                                           | 创建主角，并在故事中记录重要角色的变化                    |
| [character-blueprint](../../plugins/character-blueprint/README.md) | 角色资料     | `plugin` | `character-blueprint@1`、`character-presence@1`      | `presence`                                                                                   | 保存世界预设的人物资料，以及头像、立绘和声音              |
| [chat-mode-narrator](../../plugins/chat-mode-narrator/README.md)   | 对话叙事     | `plugin` | `narrative-engine@1`                                 | 内联                                                                                         | 让故事更像角色对话                                        |
| [codex](../../plugins/codex/README.md)                             | 设定图鉴     | `plugin` | 无                                                   | 内联                                                                                         | 整理新发现的地点、人物、物品和传闻                        |
| [core-quest](../../plugins/core-quest/README.md)                   | 任务日志     | `plugin` | `world-ir.vocabulary@1`                              | `log`、`vocabulary`                                                                          | 从叙事中登记和推进任务                                    |
| [dice-check](../../plugins/dice-check/README.md)                   | 骰子判定     | `plugin` | `action-check@1`                                     | `roller`、`recorder`                                                                         | 为有失败风险的行动做骰子判定                              |
| [guide](../../plugins/guide/README.md)                             | 行动建议     | `plugin` | `scene-prompts@1`                                    | 内联                                                                                         | 每轮故事后回顾前情，给出可直接采用的行动短句              |
| [history-compaction](../../plugins/history-compaction/README.md)   | 历史压缩     | `core`   | `history.compact@2`（默认提供者）                    | 无                                                                                           | 把较早的对话整理成分段摘要                                |
| [inventory](../../plugins/inventory/README.md)                     | 行囊         | `plugin` | `world-ir.vocabulary@1`                              | `ledger`、`vocabulary`                                                                       | 记录物品得失和装备变化                                    |
| [living-world-rules](../../plugins/living-world-rules/README.md)   | 世界规则     | `plugin` | `living-world-rules@1`、`world-info@1`               | 无                                                                                           | 展示世界包里长期生效的规则，并让叙事遵守                  |
| [memory](../../plugins/memory/README.md)                           | 故事记忆     | `core`   | 无                                                   | `extract`                                                                                    | 记住剧情、场景、人物关系和主角状态                        |
| [narrator](../../plugins/narrator/README.md)                       | 叙事         | `core`   | `narrative-engine@1`（默认提供者）                   | 内联                                                                                         | 根据玩家的行动推进故事                                    |
| [npc-graph](../../plugins/npc-graph/README.md)                     | 关系图谱     | `plugin` | `npc-graph@1`、`graph-rag@1`                         | `extractor`、`rag-retriever`                                                                 | 记录人物之间的关系                                        |
| [pregame](../../plugins/pregame/README.md)                         | 开局准备     | `core`   | `session.opening@1`                                  | 内联                                                                                         | 开局时读取世界资料，准备第一段冒险                        |
| [scene-stage](../../plugins/scene-stage/README.md)                 | 场景舞台     | `plugin` | `stage-direction@1`、`scene-stage@1`、`scene-cast@1` | `seed`、`direction`、`resolver`、`cast`                                                      | 跟踪当前场景、昼夜和在场角色，供舞台背景和立绘使用        |
| [soundtrack](../../plugins/soundtrack/README.md)                   | 配乐         | `plugin` | 无                                                   | `scene`、`cue`                                                                               | 播放世界自带的背景音乐，随场景和情绪切换                  |
| [story-events](../../plugins/story-events/README.md)               | 隐藏事件     | `plugin` | `story-event-cue@1`、`story-event.plan@1`            | `intake`、`evaluate`、`plot`                                                                 | 条件满足前隐藏世界包声明的剧情，满足时交给叙事演出        |
| [tabletop-rules](../../plugins/tabletop-rules/README.md)           | 跑团规则     | `plugin` | `tabletop-check@1`                                   | `creation`、`check`                                                                          | 开局配点，并用程序结算属性检定                            |
| [world-init](../../plugins/world-init/README.md)                   | 世界维度     | `core`   | `world-data-provider@1`、`world.dimensions@1`        | `schema-gen`、`dimension-context`、`dimension-tracker`、`dimension-clock`、`edit-dimensions` | 初始化角色属性和世界维度，并持续维护                      |
| [world-ir](../../plugins/world-ir/README.md)                       | 世界事实提取 | `plugin` | `world-ir-provider@1`                                | 内联                                                                                         | 从本轮故事里提取人物、关系、事件和线索，供其他插件复用    |
| [world-time](../../plugins/world-time/README.md)                   | 世界时间     | `core`   | `world-time-evolution@1`、`world-time-context@1`     | `context`、`advance`                                                                         | 维护日期、时段和时间流向，按本轮故事结算时间变化          |

每个插件的细节以它自己的 `PLUGIN.md` 和 README 为准。

## 代表性实现

想看某种写法的真实例子，从这里找：

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

所有以 `_` 开头的 namespace 都保留给内核。

- 插件不能通过通用的 plugin-data API 或 proposal 写入或删除它们，包括没见过的 `_` 名字和旧的 `_memory`。
- `_hidden.<namespace>` 存放 `visibility: hidden` 的世界数据，以及插件在剧情中追加的隐藏内容。只有所属插件的 runtime 能读，也只有所属插件自己的代码能写。
- 插件日志通过受限的 logger API 产生。业务数据使用 `blocks`、`definitions` 这样的普通名字。
- `__kernel:<subsystem>` 是另一种 owner 分区，插件绑定的读取接口访问不到它。

完整清单和读取权限见[存储架构](../internals/storage.md#plugin-data-ownership-and-reserved-names)。

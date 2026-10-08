# Covel 插件开发指南

先选择扩展入口，再写插件包。需要生成文字时使用 agent runtime；确定性的计算、导入或外部 API 调用使用 function runtime；提示词片段、历史变换、压缩和世界上下文使用公开扩展点。

代码作者使用公开 `@covel/plugin-handlers-utils` 的入口、function/guard 类型和结果 helper。工具通过 entry 注入的 `covel.toolkit` 构造；`@covel/tools` 的 registry、内置工具装配以及 `@covel/plugin-loader` 的加载阶段属于宿主实现。发布独立插件时应将使用到的 SDK 运行代码打包进插件，安装器不会执行 npm 安装。

本指南对应当前作者格式。根文件为 `PLUGIN.md`，多 runtime 子文件为 `RUNTIME.md`。旧平铺字段、子目录 `PLUGIN.md`、`relations` 和框架记忆专用字段均不再接受；旧开发会话和 checkpoint 应重建。

## 三条路径

| 需求                             | 指南                                          |
| -------------------------------- | --------------------------------------------- |
| 只写 YAML 和提示词               | [零代码插件](plugin-authoring-zero-code.md)   |
| agent 配合本地工具或 RPC         | [Agent 与本地代码](plugin-authoring-agent.md) |
| 多 runtime、数据契约、权限和发布 | [高级作者指南](plugin-authoring-advanced.md)  |

完整字段和内置示例见[插件契约参考](../reference/plugins.md)，公开扩展点见[插件扩展点](../reference/plugin-extensions.md)。

Function runtime 通过 `ctx.gateway` 调用模型时，可在 `function.model` 声明所用 slot，并在 gateway 调用中使用相同的 `presetId`。例如调用 `presetId: "memory"` 的后台任务应声明 `function.model: memory`，让 detached worker 用该 slot 判断凭证是否就绪；这一声明不会自动改写 handler 的 gateway 参数。

## 最小闭环

```sh
# 独立插件：生成到用户插件目录（默认 ~/.covel/plugins），不需要安装依赖
pnpm create-plugin my-plugin
pnpm validate:plugin ~/.covel/plugins/my-plugin
pnpm test:runtime -- my-plugin --pretty

# 仓库内置插件：生成到 plugins/my-plugin，带本地工具和单元测试
pnpm create-plugin my-plugin --with-tools
pnpm install
pnpm validate:plugin plugins/my-plugin
pnpm --filter @covel/plugin-my-plugin test
```

生成器没有交互提示：默认生成一个 function runtime 加一个 agent runtime 的示例，`-r name:type,...` 自定义 runtime 列表，`-t <dir>` 指定目标目录，`--with-tools` 生成仓库内的单 runtime 插件。包至少包含 `package.json`、`PLUGIN.md`，并为维护者提供 `README.md`。根清单的 `id` 必须与目录一致，单 runtime 使用根 `runtime`，多 runtime 使用 `runtimes/<id>/RUNTIME.md`，不要同时声明两种布局。

要让玩家知道插件是谁做的，在根清单写 `version`、`author`、`license`、`homepage`：作者名、一段写给玩家的话和几个 `https` 链接会显示在开局准备页和已安装列表里，玩家点开链接前会看到第三方链接提示。字段和限制见[作者信息](../reference/plugins.md#作者信息)。

```yaml
---
id: my-plugin
kind: plugin
description: Adds a brief observation after narration.
requires: [narrative-engine@1]
runtime:
  type: agent
  schedule:
    stage: post-turn
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1 }
        select: /narrativeOutput
        required: true
    visibility: plugin
  agent:
    model: plugin
---
Write one observation grounded in runtime-inputs.narrative.value.
```

通过校验后从插件管理界面安装并启用。社区插件的服务端代码需要授权，作者清单本身不会授予权限。安装位置和包管理流程见[插件安装](../reference/plugin-installation.md)。

## 声明与实现对齐

所有包级贡献写在根 `contributes`。entry 模块注册工具、RPC action、服务、扩展、hook、wire 或 form 时，名称必须与清单一致。`contributes.commands` 是玩家命令元数据，实际 RPC 名还必须列在 `contributes.actions`。

只在运行时需要的工具放进 `agent.tools`。这份白名单控制 agent 能调用什么；`contributes.tools` 声明包实际注册什么。两者用途不同。只有一个 runtime 的包（根 `runtime:`）不写 `agent.tools.plugin` 时，这个 runtime 得到 `contributes.tools` 的全部工具，不用重复列一遍；写了就以写的为准，`plugin: []` 表示一个都不给。多 runtime 的包里每个 runtime 仍然各自列出自己的工具。

跨插件调用使用版本化契约，例如 `narrative-engine@1`。根 `requires` 驱动会话依赖解析，`io.inputs` 绑定执行结果，`schedule.needs` 控制运行条件。普通契约可以有多个提供者；用 `cardinality: one/all` 指定输入要求，用显式 `conflicts` 或单提供者扩展点表达互斥。

runtime 处理玩家不该提前看到的内容（隐藏剧情、谜底）时声明 `io.concealed: true`。它的提示词、工具参数、工具结果和输出不会进入 trace、实时流和玩家可见的执行历史，只留下名称、状态、耗时和用量。需要把隐藏内容交给其他插件时，用契约输出传递，由接收插件写入它自己的 `_hidden.<namespace>`；参见 [story-events 的 plot runtime](../../plugins/story-events/runtimes/plot/RUNTIME.md) 与 [World Data · 隐藏数据](../reference/world-data.md#隐藏数据visibility-hidden)。

**跨包依赖边界**：`needs`、`after` 和 `io.inputs` 的跨包引用必须使用版本化契约（如 `narrative-engine@1`），不允许直接引用其他插件的 runtime 名称（如 `other-plugin/some-runtime`）。包内多个 runtime 之间可以使用 runtime 名称建立排序和输入关系，但跨包必须通过公开契约解耦。违反此规则的 manifest 加载时会被拒绝。

同轮事件链的同步订阅者可以声明同次依赖：同一深度实际匹配的订阅者按 DAG 分层，先合并上游结果，再执行下游 gate 和 input binding。`needs` 要求上游成功，`after` 只等待执行结束；独立订阅者仍并行。依赖不会替作者触发未匹配的 topic，后台订阅者也不会因这份 DAG 与其他后台作业建立依赖。需要跨作业接力时，使用后续事件或已提交输出。

## 数据归属

角色和角色 schema 读取 `ctx.world`，角色写入通过 proposals。不要把角色复制到本插件的 `characters` namespace，也不要扫描其他插件私有 schema。

插件私有数据使用绑定 store：`getPluginData(namespace, key)`、`listPluginData(namespace?)`。不同插件共享数据必须声明公开契约。可导入世界数据的 namespace 在 `contributes.data` 声明 `version/schema/accepts`，其契约 schema 放在根 `contracts`；再用 `authoring` 声明标题、写作提示、示例和约定路径，世界作者和创作工具通过 `pnpm describe:authoring` 读到它（见[进阶指南](./plugin-authoring-advanced.md#数据契约与世界导入)）。见 [World Data](../reference/world-data.md)。

记忆语义由 memory 插件和其 `memory.block-definitions@1` 服务拥有。世界自定义记忆块通过 `memory.blocks@1` 导入。不要新增 `memoryBlocks` 或 `summaryFocus` 根字段。

## 提示词与本地化

Agent 正文放在相应 `PLUGIN.md` 或 `RUNTIME.md`。静态附加段用根 `contributes.prompt`，动态内容用 `prompt.segment@1`。同包静态段不按 runtime 筛选，多 runtime 的局部规则应写在各自正文中。

标签（名称、说明）和正文都用 English 写在主文件里；标签的译文放在 `locales/<locale>.yaml`，任何语言都可以加。正文和固定段用 English 写在 canonical 文件里。需要中文指令时加 `PLUGIN.zh.md` / `RUNTIME.zh.md`（内置插件的 agent 提示词必须加，社区插件可选），只写正文和固定段的 `content`，未出现的字段继承 canonical；其他语言不需要也不会读取变体文件，那些会话使用 English 正文并按会话语言输出。工具、依赖、契约、提示词段 ID 和位置不能由变体覆盖。正文不需要再写“用什么语言输出”：框架在每个 agent 的系统提示词开头给出输出语言指令，改写上下文的 hook 也去不掉它（见 [Prompt Structure](../reference/prompt-structure.md)）。修改任一语言后运行 `pnpm check:prompts`，两边都更新完再运行 `pnpm prompts:lock`。运行时生成的消息使用 `ctx.locale` 选择文案；不要只翻译清单而遗漏工具返回值。 正文怎么写（契约区与文风区、句长、用词）见 [提示词写法](./prompt-style.md)。

## 验证与发现

- `pnpm validate:plugin <目录 | PLUGIN.md | RUNTIME.md>` 验证整个包，包括其他子 runtime。
- `GET /api/plugins/:id` 返回包的契约、设置、runtime、工具、UI 和数据声明。
- `GET /api/framework/capabilities` 返回框架原语和发现入口。
- `GET /api/worlds/:id/plugin-plan` 返回世界策略和显式默认请求。
- 根清单可用 `covel: ">=0.0.45"` 声明适配的宿主版本范围，`pnpm create-plugin` 生成的独立插件已把创建时的宿主版本写成下限；范围之外的宿主拒绝安装，也不加载已安装的包；语法见[合集指南](./collections.md#版本范围)。把插件和世界一起发布见同一页。

测试应验证用户可观察的结果、非法输入、数据归属，以及失败时不发生部分提交。CI 前运行项目的 `pnpm lint` 和 `pnpm test`；涉及玩家 UI 流程时补相应浏览器验收。

公开 SDK 提供 `resolveI18nText` / `resolveI18nDeep`、locale registry、`estimateTokens`、表单工具和角色字段校验。`world.dimensions@1` 的提供者使用 `@covel/plugin-handlers-utils/dimensions` 的 schema 与 materializer。Node 插件用 `@covel/plugin-handlers-utils/prompts` 的 `createPromptLoader(root)` 加载自己的模板；该子入口不进入浏览器根模块。`shared` / `tools` / `context` 复用这些实现，插件代码只依赖 SDK。

默认 analyst 示例在 `post-turn` 自动运行，读取本回合叙事绑定；note 示例保留手动函数入口。记录 ID 来自 `ctx.random`，时间戳由代码或存储写入，agent 只提交稳定的事实 key 和内容。

当 `contributes.data.<namespace>.authoring.source` 的数据包含使用其他稳定键的嵌套列表时，可声明 `localeArrayKeys: [label]`。译文保留该键，主文件插入或调整列表顺序后仍匹配同一条记录。自定义 worldData descriptor 的 source 使用同名字段。

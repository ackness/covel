# 工具注册表

工具是模型在一次运行中可以调用的函数：模型给出名字和参数，框架执行它，把结果回给模型。本页列出全部工具、每个工具的参数和返回，以及怎样写自己的工具、工具怎样把数据写进存储。写 runtime 提示词或写工具的插件作者需要它。

工具分两类：

- **builtin**：框架自带，任何插件都可以用。
- **plugin**：插件在自己的 `entry` 模块里注册，只有这个插件能用。

> [!NOTE]
> 下文表格和审批规则里的 `local` 是执行器内部使用的来源标签，指“由插件 entry 注册成功的工具”。它不是清单字段。清单里没有 `tools.local`，写了它的清单加载失败。

> [!NOTE]
> 表里的 DashScope / OpenAI 生图工具由[官方社区插件仓库](https://github.com/covel-ai/covel-plugins)提供。安装并在会话里授权之后，对应的工具和界面才会注册。

## 概览

| 工具名                                | 来源    | 所属插件            | 审批策略   | 描述                                                                                               |
| ------------------------------------- | ------- | ------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| create-form                           | builtin | —                   | auto-allow | 创建玩家表单                                                                                       |
| create-choices                        | builtin | —                   | auto-allow | 创建选项列表                                                                                       |
| create-notification                   | builtin | —                   | auto-allow | 显示通知消息                                                                                       |
| render-ui                             | builtin | —                   | auto-allow | 渲染带独立 part 状态的 UI 块                                                                       |
| plugin-data-set                       | builtin | —                   | auto-allow | 写入插件持久化数据（单条）                                                                         |
| plugin-data-set-batch                 | builtin | —                   | auto-allow | 批量写入插件持久化数据                                                                             |
| plugin-data-get                       | builtin | —                   | auto-allow | 读取当前插件持久化数据                                                                             |
| plugin-data-list                      | builtin | —                   | auto-allow | 列出当前插件持久化数据                                                                             |
| **create-character**                  | builtin | —                   | auto-allow | 创建世界模型角色，类型按 schema 校验，写入 characters                                              |
| **update-character**                  | builtin | —                   | auto-allow | 按 id、名字或别名更新角色描述/字段（shallow merge）并可追加别名，自动 version++                    |
| **sync-characters**                   | builtin | —                   | auto-allow | 原子批量创建/更新角色；新角色 ≤5、已有角色更新 ≤10                                                 |
| **list-characters**                   | builtin | —                   | auto-allow | 列出本 session 所有角色（session 作用域，跨插件可见）                                              |
| **get-character**                     | builtin | —                   | auto-allow | 按 id、名字或别名查找单个角色                                                                      |
| **get-character-schema**              | builtin | —                   | auto-allow | 读取当前会话的角色属性 schema，支持跨回合恢复创角                                                  |
| **world-dimension-get**               | builtin | —                   | auto-allow | 按 ID/path 分页读取回合冻结的当前维度值                                                            |
| **world-dimension-list**              | builtin | —                   | auto-allow | 列出开放维度 ID、名称、类型与版本，不倾倒值或规则                                                  |
| **emit-event**                        | builtin | —                   | auto-allow | 发射当前 session 已声明的领域事件（一次一个 topic），校验 topic + payload schema                   |
| **suspend**                           | builtin | —                   | auto-allow | 挂起当前 runtime 等待玩家输入，写 `suspensions` 表，可通过 resume API 恢复                         |
| **runtime-done**                      | builtin | —                   | auto-allow | Agent 工具循环的结束信号——业务工具调用完毕后调用以结束本 runtime                                   |
| **search-tools**                      | 注入    | —                   | auto-allow | 延迟工具搜索——manifest 声明 `tools.defer` 时框架自动注入，BM25 检索并激活未预载工具                |
| **memory-search**                     | builtin | —                   | auto-allow | 搜索记忆：对话历史与历史摘要(recall) + 长期知识库(archival，含 lorebook/角色/插件声明可检索的数据) |
| initialize-world                      | local   | world-init          | auto-allow | 组合角色属性 schema 与维度声明初始化                                                               |
| create-character-form                 | local   | char-creator        | auto-allow | 创建开场角色表单：只收集角色名与声明过的字符串/枚举属性，数值与复合属性保留默认值                  |
| update-affinity                       | local   | affinity            | auto-allow | 批量应用本回合玩家对 NPC 的好感度变化；未知名字按 0 分新建，分数跨回合累计并限制在 [-100, 100]     |
| advance-world-time                    | local   | world-time          | auto-allow | 结算本回合叙事经过的世界时间：提交时长而非日历算术，随机模式省略数量，随故事一并提交               |
| set-world-schema                      | local   | world-init          | auto-allow | `initialize-world` 的内部 schema 写入原语                                                          |
| set-world-dimensions                  | local   | world-init          | auto-allow | 采纳维度声明，不重置会话进度                                                                       |
| dimension-rule-get                    | local   | world-init          | auto-allow | 维护时分页读取私有规则或值 schema                                                                  |
| update-dimensions                     | local   | world-init          | auto-allow | 绑定本轮叙事，整批 CAS 更新或明确结算无变化                                                        |
| submit-world-facts                    | local   | world-ir            | auto-allow | 以 Function Calling 参数提交并校验完整 `contract:world-ir@1`                                       |
| sync-codex-entries                    | local   | codex               | auto-allow | 一次提交本轮图鉴变化，按标题新建或补充条目                                                         |
| generate-guide                        | local   | guide               | auto-allow | 原子写入前情摘要、当前决策与玩家口吻快捷回复                                                       |
| upsert-npc-graph                      | local   | npc-graph           | auto-allow | 批量写入 NPC 节点与关系边（按 name 引用，工具内部去重并分配短 ID）                                 |
| list-npc-graph                        | local   | npc-graph           | auto-allow | 兼容读取工具；当前 extractor 已通过 prompt 注入读取图，不向模型声明                                |
| plan-story-events                     | local   | story-events        | auto-allow | 校验剧情策划的后续隐藏事件（≤2/次，可撤回未发生的计划）                                            |
| submit-dashscope-text-prompt          | local   | dashscope-image-gen | auto-allow | 提交文本画面提示并发射固定 DashScope 出图事件                                                      |
| submit-dashscope-structured-prompt    | local   | dashscope-image-gen | auto-allow | 提交结构化画面提示并发射固定 DashScope 出图事件                                                    |
| submit-openai-image-text-prompt       | local   | openai-image-gen    | auto-allow | 提交文本画面提示并发射固定 OpenAI-compatible 出图事件                                              |
| submit-openai-image-structured-prompt | local   | openai-image-gen    | auto-allow | 提交结构化画面提示并发射固定 OpenAI-compatible 出图事件                                            |

每个内置插件的工具都必须出现在这张表里，`apps/server/tests/lib/reference-tables.test.ts` 会检查。

## 工具调用方向

本页以这三处的实现为准：`apps/server/src/routes/api/bootstrap/tools.ts`、`packages/tools/src/builtin/`、`plugins/**/tools/`。

### 选择顺序

要给 runtime 一种能力时，按这个顺序选：

1. 通用、重复、多个插件都会用的能力：用现成的 builtin 工具，在 runtime 的 `tools.builtin` 里列出名字。
2. 插件专属的能力（自己的 schema、检索、NPC 关系维护、图鉴整理等）：在插件的 `entry` 模块里用 `covel.registerTool()` 注册，再在 runtime 清单的 `tools.plugin` 里按名字列出，让模型看得到。
3. 多个插件长期共用、约定已经稳定的能力：升级成一个新的 builtin 工具。

### 一个可复制的最小插件

下面的插件有一个工具 `echo-value`，把收到的值原样返回。它用到三样东西：`entry` 模块、`covel.toolkit.tool()`，以及清单里的 `agent.tools.plugin`。

```text
plugins/echo-demo/
├── package.json
├── PLUGIN.md
└── server/index.js
```

```json
{
  "name": "@covel/plugin-echo-demo",
  "version": "0.0.1",
  "private": true,
  "type": "module"
}
```

`package.json` 是仓库内置插件的要求。如果只是放在 `~/.covel/plugins/echo-demo/` 当本地用户插件，加载器只要求 `PLUGIN.md` 和它实际引用的文件。

```yaml
# PLUGIN.md
---
id: echo-demo
kind: plugin
description: Echoes one short value for a smoke test.
entry: ./server/index.js
contributes:
  tools: [echo-value]
runtime:
  type: agent
  schedule:
    trigger: { type: manual }
  agent:
    loop: { maxSteps: 2 }
    tools:
      plugin: [echo-value]
---
When manually triggered, read `payload.value` from the `<runtime-activation>`
block, call `echo-value` once, then call `runtime-done`.
```

```js
// server/index.js
export default function (covel) {
  covel.registerTool(
    covel.toolkit.tool({
      name: "echo-value",
      description: "Echo one short value.",
      parameters: covel.toolkit.z.object({
        value: covel.toolkit.z
          .string()
          .min(1)
          .max(80)
          .describe("Value to echo (1-80 characters)."),
      }),
      execute: async ({ value }) => ({ ok: true, value }),
    }),
  );
}
```

要点：

- `PLUGIN.md` 的 `id`、`kind`、`description` 是必需字段。`entry` 必须是插件根目录内的相对 `.js` 路径。
- `tools.plugin` 只是让模型看到这个工具。工具的实现必须先由 entry 调用 `registerTool()` 注册。
- 用框架给的 `covel.toolkit.tool` 和 `covel.toolkit.z`。这样插件不用自己依赖 Zod，参数 schema 和运行时的 `VALIDATION_ERROR` 也来自同一套工具。不要在同一个定义里混用插件自己打包的另一份 Zod。

运行时会发生什么：

- agent 调用 `echo-value` 成功时，得到 `{ "ok": true, "value": "..." }`。
- 参数先由 `tool()` 生成 JSON Schema 给模型看，执行时再用同一个 Zod schema 校验。缺少 `value`、空字符串或超过 80 个字符时，模型得到 `VALIDATION_ERROR`，`execute` 不会被调用。

两件相关的事：

- **要保存数据**：改用 builtin 的 `plugin-data-set`（列在 `tools.builtin` 里）。它返回 `{ success, namespace, key }`，并把写入作为一条 `plugin.data` proposal 交给回合末的提交流程。
- **要让界面或 HTTP 主动触发插件的一个动作**：那不是工具。在 entry 里用 `covel.registerRpc(action, handler)` 注册，通过 `POST /api/sessions/:id/plugin-rpc` 调用。RPC 不给模型用，不要写进 `tools.plugin`。

#### 模型写错的参数 JSON

模型写出的参数 JSON 有几种反复出现的笔误，而且每种只有一个合理的意思。框架在解析时直接改正它们，省掉让模型重交的一轮。改正后的内容仍然要通过工具的 schema。

| 笔误                           | 例子                                                   | 怎么改                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 末尾多出收尾括号               | `{"updates":[{"id":1}]}]}`                             | 一个完整的 JSON 值后面多出至多四个 `]` / `}` 时，去掉它们。括号前的值是完整的，去掉多余括号不改变其中任何内容。                                                                                                                      |
| 字符串值里的引号没有转义       | `"note": "铭文把它叫作"锁"而不是灯。"`                 | 结束一个 JSON 字符串的引号后面只能是 `,`、`}`、`]`、`:` 或文本结尾。后面跟着其他文字的引号属于值本身，按 `\"` 处理。只有引号成对出现时才这样处理，键名从不改动。引号多一个或少一个（`"name": "Mira"", …`）是结构错误，不属于这一类。 |
| 数组元素没有收尾就开始了下一个 | `[{"id":"a","attributes":{"kind":"lamp"}, {"id":"b"}]` | 元素的最后一个字段是对象时，模型只收了这个字段的括号。对象内部逗号后面只能是键名，出现 `{` 说明它是外层数组的下一个元素，缺的 `}` 补在逗号前。                                                                                       |
| 收尾括号和正开着的括号对不上   | `[{"id":"a"},{"id":"b"}}]`、`[{"id":"a"},{"id":"b"}}`  | 没有对象开着的地方多了一个 `}`，去掉它。文本最后一个括号写错了种类，换成对的那个。两种情况都不改变任何值，也不添加文本里没有的内容。中间位置写错种类的括号（`{"a":[1,2},"b":3}`）不属于这一类。                                      |
| 对象的开头写了两遍             | `[{"id":"a"},{"{"id":"b"}]`                            | 合法 JSON 里键名前不会出现 `{"{"`，去掉重复的 `{"`。                                                                                                                                                                                 |

几条限制：

- 表里后三条各自单独尝试，不叠加，并且改正后必须原样通过解析。
- 为什么不叠加：第三条的位置还有另一种读法，即模型漏写了键名（`"summary":"…", {"role":"…"}}]`）。两种读法里只有一种的括号数目对得上。叠加修补会把“漏写键名”的文本读成两个元素。所以按另一种读法写出的文本仍然报错。
- 这些规则对整段调用参数和字段内的 JSON 文本都适用。
- 其他错误不猜：输出被截断、两个字符串之间缺逗号、值里的引号后面紧跟 `,` 或 `:`，都不修。整段参数仍不是合法 JSON 时，调用以 `INVALID_ARGS` 失败，模型要重新给出参数。

**把数组或对象写成了一段 JSON 文本。** schema 在某个位置要求数组或对象，模型却给了一个字符串时，`tool()` 先按上面的规则解析这段文本，再校验一次。解析出的内容仍然要通过同一个 schema。

这种字段内的文本多一条规则：**文本结尾还开着的括号会被补上**（`[{"id":"a"},{"id":"b"}`）。理由是外层参数已经解析成功，说明这段文本是模型自己写完的，不是输出被截断。补完后同样必须原样通过解析；没写完的值（`[{"id":"a"},{"id":`）仍然报错。整段调用参数不做这一步，因为它可能真的是被截断的输出。

文本解析不了时，`VALIDATION_ERROR` 会写明解析失败的原因和位置，并要求模型直接传数组或对象本身。

**带 Unicode 属性转义的正则。** `tool()` 生成给模型的 JSON Schema 时，会去掉含 `\p{Letter}` 这类写法的 `pattern`。原因：JSON Schema 的 `pattern` 不带正则标志，而这类写法只有在 `u` 标志下才是作者想要的意思。会校验工具 schema 的服务商会以“不是合法正则”拒绝整个请求，带这个工具的每次调用都会失败。Zod 仍按原来的正则校验参数值。把规则本身写进字段的 `describe()`，让模型看得到。

### 失败定位与验证

| 现象                             | 原因和检查                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具不在模型的工具清单里         | 检查 runtime 是否在 `tools.builtin` 或 `tools.plugin` 里写了正确的名字。plugin 工具还要确认 entry 加载成功，并且没有插件内重名，也没有占用框架保留名。                                       |
| `UNAUTHORIZED`                   | 最终的工具名不在该 runtime 的授权集合里，或 Hook 把名字换成了授权之外的工具。先看 runtime 清单，再看 trace 里最终的 tool name。                                                              |
| `VALIDATION_ERROR`               | 错误行和 `details` 都写明了字段路径和 Zod 消息。不要用同一组参数盲目重试。                                                                                                                   |
| RPC 返回 `401` / `403`           | 检查会话的 owner / operator token。                                                                                                                                                          |
| RPC 返回 `202 approval-required` | 社区插件第一次执行通常是这样。批准后重试原请求。                                                                                                                                             |
| RPC 返回 `404`                   | 通常是 session、action 或 runtime 不存在。                                                                                                                                                   |
| RPC 返回 `409`                   | 常见于会话不是 active、锁竞争，或审批范围已经变化。                                                                                                                                          |
| 写入看似成功但没有落库           | 工具返回成功只代表 proposal 已经缓冲。检查 `execution.completed.committed`。runtime 结果是 `failed` 或 `suspended` 时 proposal 不提交。提交失败可以在 action stream 里查 `proposal.failed`。 |

最小验证命令（仓库根目录）：

```bash
pnpm validate:plugin plugins/echo-demo
pnpm --filter @covel/tools test
pnpm --filter @covel/runtime exec vitest run tests/proposal-type-contract.test.ts
```

`validate:plugin` 只检查清单。工具的参数和返回，要用插件自己的 Vitest 测试来保证。proposal 提交的约定可以参考 `packages/runtime/tests/proposal-type-contract.test.ts`。

### Builtin 的职责

builtin 工具是系统级的积木，适合被多个插件直接复用。例如：

- `plugin-data-*`
- `render-ui`
- `create-form`
- `create-choices`
- `create-character`
- `world-dimension-get` / `world-dimension-list`

### Plugin tool 的职责（内部来源标签：`local`）

plugin 工具封装插件自己的业务。它的 schema、文案和数据结构由插件包自己定义和维护。例如：

- `generate-guide`
- `upsert-npc-graph`
- `sync-codex-entries`

### 目录与访问边界

- plugin 工具在插件的 `entry` 模块里用 `covel.registerTool()` 注册。`entry` 是清单 frontmatter 的字段，按插件根目录解析。
- 启动时会检查 entry 路径，只加载插件目录内的文件。
- 工具按 `(pluginId, name)` 注册。不同插件可以用同一个名字。同一个插件里重名，或用了框架保留名，会让这一批注册全部失败并撤回。
- `tools.plugin` 的声明不注册实现。一次调用要过两关：这个 runtime 的工具白名单，以及调用方插件自己的注册表。没注册的名字不会落到别的插件的同名实现上。
- 模型、`ctx.tools.call`、`tools.defer` 都用工具原来的名字。
- 要跨插件公开的能力用 `ctx.services`。

### 不是 Tool：`FunctionHandlerContext` 上的框架能力

`ctx.gateway`、`ctx.media`、`ctx.images`、`ctx.utils` 不是工具。它们是函数 runtime 的 handler 代码直接调用的 JavaScript API，**不经过**工具注册表和审批流程，模型也调用不到它们。

图像生成尤其如此：不要声明一个 `generate-image` 工具让模型调用。在 `handler.js` 里直接写 `await ctx.images.generate({...})`。

完整的 `ctx` 能力表和图像生成的约定见[进阶 § 后台工作与失败](../plugins/advanced.md#后台工作与失败)。

### Function runtime 调用工具

函数 runtime 用 `await ctx.tools.call(name, args)` 调用工具。能调用的是清单 `tools.builtin` / `tools.plugin` 白名单里的工具。它和模型调用工具走同一套流程：参数校验、工具审批、`PreToolUse` / `PostToolUse` Hook、审计、proposal 提交。

规则：

- 调用按顺序执行。后面的工具能读到前面还没提交的写入。
- **任何一次调用失败，这个 runtime 就失败。** 即使 handler 捕获了异常，也不会提交部分写入。
- 参数无法序列化（例如 BigInt、循环引用）同样让整个 runtime 失败。
- runtime 超时或结束后，这个调用句柄作废。
- 只有成功的 runtime 才把领域写入和 `ctx.pluginData` 一起交给执行事务。
- 这个接口只给函数 runtime，不给 agent 的 guard。

`PostToolUse` 返回 `terminate` 时：当前这次调用的结果保留，handler 后面再发起的工具调用被拒绝。handler 可以正常返回当前结果。但被拒绝的后续调用同样让 runtime 失败。

工具里的 `context.logicalTurn` 和 handler 的 `ctx.logicalTurn` 是同一个值，即这次执行开始时定下的回合号。它不按工具调用次数或消息数变化，也不会在执行中重新读取。独立的轻量宿主没有提供回合号时，这个字段可以省略。

### 当前代码状态

- plugin 工具可以读取每次调用注入的 `context.store`。持久化写入通过 `withPendingProposals(...)` 交给提交流程。
- 确定性的函数 handler 用 `ctx.tools.call()` 调用声明过的工具，用 `ctx.pluginData` 写自己的数据。
- 社区插件的 handler 拿不到完整的可写 `store`。

插件对 runtime 公开的稳定约定，建议留在插件目录内，由插件自己维护测试。

## Builtin 工具

框架自带的工具，定义在 `packages/tools/src/builtin/*.ts`。任何插件在 `tools.builtin` 里写上名字就能用，不用写代码。

公开 SDK 导出 `FRAMEWORK_TOOL_NAMES`。工具注册和插件静态校验用的是同一份名字表。

### create-form

创建一张需要玩家填写的表单。框架渲染它；玩家提交后，结果进入下一轮的上下文。

手动 runtime 通过插件界面打开的表单也一样：模板在事务内保存，刷新后可以继续填，服务端也会校验。没有交互的手动输出不写入对话历史。

| 参数              | 类型        | 必需 | 描述                                |
| ----------------- | ----------- | ---- | ----------------------------------- |
| formId            | string      | ✓    | 表单唯一标识                        |
| title             | string      | ✓    | 表单标题                            |
| fields            | FormField[] | ✓    | 表单字段列表                        |
| submitLabel       | string      | ✓    | 提交按钮文本                        |
| narrativeTemplate | string      | ✓    | 叙事模板，含 `{{fieldName}}` 占位符 |
| validation        | object      |      | `{ name, data? }`，见下             |
| submitBehavior    | object      |      | `{ echoFilledNarrative? }`          |
| notice            | string      |      | 字段上方的提示，见下                |

**FormField**: `{ type, name, label, placeholder?, options?, required?, defaultValue?, min?, max?, step? }`

- type: `text` | `textarea` | `select` | `checkbox` | `number`

字段的取值规则：

- `number` 的默认值和提交值是有限数字，`checkbox` 是布尔值，其余类型是字符串。
- 数字字段支持 `min`、`max` 和正数 `step`。步长从 `min ?? 0` 起算。
- 前端保留数值类型。服务端再校验一遍，并把收到的数字字符串规范成数字。
- 数字字段被清空时，不会变成 0，也不会重新套用默认值。它是必填项时，提交被拒绝。
- 没有提交的字段使用默认值，包括 0 和 false。文本和选择字段提交空字符串时也使用默认值。
- `placeholder` 只用于展示。
- `select` 的默认值必须是选项之一。
- 默认值写成有限数字字符串或 `"true"` / `"false"` 也能用，提交时统一规范化。新插件应直接写数字和布尔值。

#### 自定义校验 `validation`

`validation: { name, data? }` 指向发出表单的插件自己的一个校验函数。这个函数要做两件事才生效：在根 `PLUGIN.md` 的 `contributes.forms` 里声明，并用 `covel.registerFormValidator(name, validator)` 注册。它必须是同步的纯函数。

函数收到三个参数：

1. 规范化后的 `values`。
2. 表单的 `data`（提交时不可修改）。
3. `{ locale, messages }`：会话语言，以及插件在该语言下的翻译。可以直接传给 `translate`。

返回值：

| 返回                                                         | 效果                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `undefined`                                                  | 通过。                                                                            |
| 字符串                                                       | 整张表单的错误。                                                                  |
| `{ field, message }`，或它们的数组（类型 `PluginFormIssue`） | 消息显示在名为 `field` 的字段下面。`field` 不是表单字段时，按整张表单的错误处理。 |

错误是给玩家看的。用 `translate(context, "...")` 写成会话语言，说明哪里不对、该怎么改。

提交时的行为：

- 来源插件由已提交消息的 `sourcePluginId` 决定，客户端指定不了。框架用 `findCommittedInteraction` 定位已提交的表单，授权和校验用的是同一份来源记录。
- 所有字段校验和跨字段校验都通过之后，整个提交批次才落库。
- 插件必须仍处于启用和授权状态。找不到校验器不会被悄悄跳过。

提交可能得到的回应：

| 情况                                                     | 回应                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件的校验器不通过                                       | 400，`code: "form_rejected"`。不写入任何内容，玩家在原表单上修改后可以再次提交。                                                                              |
| 框架自己的字段校验不通过（必填、数字、范围、步长、选项） | 同样是 400 和 `form_rejected`。错误文字用字段的 `label` 和会话语言写成，每个出错的字段一条。响应的 `details.issues` 逐条带上字段名（见 [api.md](./api.md)）。 |
| 未知字段、找不到已提交的表单                             | 400，没有 `form_rejected` 这个错误码。这是客户端不该发出的请求。                                                                                              |
| 已经回答过的交互再次提交                                 | 400，`code: "interaction_already_submitted"`（见 [api.md](./api.md)）。                                                                                       |
| 表单引用了没有声明的校验器                               | 400，`form_validator_undeclared`。需要重新生成表单，授权修不好它。                                                                                            |
| 服务重启过，或授权被撤销                                 | 提交接口先请求来源插件的 server-code 授权（202）。授权后重试原提交。                                                                                          |
| 插件已被禁用或卸载                                       | 400。                                                                                                                                                         |

> [!WARNING]
> `validation.data` 是表单块的一部分。它随 SSE 事件和会话视图发到玩家的客户端，并保存在会话消息里（浏览器私有存档的检查点也含它）。不要把玩家不该看到的内容放进去。需要比较保密的值时，存加盐摘要，不存原值。`char-creator` 的 `player-name` 校验器就是这样比较角色名的。

#### 提示 `notice`

`notice` 是一个字符串，用会话语言写。客户端把它显示在字段上方，用来说明这张表单为什么又出现了。

- 第一次发出的表单不带它。
- 一次已被接受的提交后来用不了、需要重新发出表单时，插件设置它，并把上一次的值作为字段的 `defaultValue`。
- 工具返回的 `interaction` 里有同名字段。runtime 直接通过 `effects.interactions` 发出表单时，同样写在表单对象上（SDK 类型 `PluginFormInteraction`）。

#### 角色创建表单

角色创建用专用的 `create-character-form` 工具。它只收集必填的姓名，以及世界声明的字符串或枚举属性。

- 模型不能为它指定校验器：参数里没有 `validation`，传了也会被丢弃。工具自己挂上 `char-creator` 注册的 `player-name` 校验器，拒绝和世界里已有角色的名字或别名相同的角色名（见 [World Model](./world-model.md)）。其余字段约束由工具和提交接口校验。
- 一张已被接受的角色表单不会让会话卡在 setup：
  - 世界属性的默认值不符合它自己的类型时，建角时不写入这个默认值。
  - 表单发出之后属性类型变了，玩家提交的值不再被接受时，下一次 setup 运行重新发出表单。仍然有效的旧答案已经填好，并带一条 `notice`。

**使用者**: char-creator

### create-choices

创建一组选项让玩家选。适用于决策点、分支剧情、NPC 对话选项。

| 参数     | 类型     | 必需 | 描述                         |
| -------- | -------- | ---- | ---------------------------- |
| choiceId | string   | ✓    | 选项组唯一标识               |
| prompt   | string   | ✓    | 引导文本（如"你要怎么做？"） |
| choices  | Choice[] | ✓    | 选项列表（至少 2 个）        |

**Choice**: `{ id, label, description?, category? }`

- category: `safe` | `aggressive` | `creative` | `wild` 等

**使用者**: 通用交互插件。内置的 `guide` 没有用它：`guide` 走 `generate-guide` 加 `ui.message` 的路径，用插件自己的界面展示更完整的内容，并通过 `stage.choices@1` 把同一组短句交给舞台模式。

### create-notification

在前端显示一条通知。适用于状态变化、获得物品、触发事件等。

| 参数    | 类型   | 必需 | 描述                                     |
| ------- | ------ | ---- | ---------------------------------------- |
| level   | enum   | ✓    | `info` / `success` / `warning` / `error` |
| title   | string | ✓    | 通知标题                                 |
| message | string | ✓    | 通知内容                                 |

工具返回一个 `ui` 块，内容是 `Alert` 组件的规格。它经 `ui.render` proposal 提交后显示在消息流里。前端的 `Alert` 组件只渲染 level、title 和 message。

**使用者**: codex

### render-ui

渲染一个 `ui.render` 块。块由若干 part 组成，每个 part 有自己的状态。适合把叙事文本、图片、卡片、音频混排输出。

| 参数   | 类型           | 必需 | 描述                           |
| ------ | -------------- | ---- | ------------------------------ |
| parts  | UIRenderPart[] | ✓    | UI part 列表                   |
| layout | enum           |      | `stream` / `split` / `overlay` |

**UIRenderPart**:

```typescript
type UIPartStatus = "pending" | "streaming" | "success" | "error" | "paused";

interface UIRenderPart {
  id: string;
  type: string;
  status: UIPartStatus;
  content: unknown;
  retry?: { count: number; lastError?: string };
}
```

工具返回 `{ ui: [{ parts, layout? }] }`，框架据此生成 `ui.render` proposal。返回 `{ ui: [{ type, ...content }] }` 这种没有 `parts` 的形状时，框架自动把它包成一个 `success` 状态的 part。

### plugin-data-set

把一条数据写进插件的持久化存储。数据按 `(sessionId, pluginId, namespace, key)` 隔离。同一个 `(namespace, key)` 再写一次会覆盖旧值。

| 参数      | 类型    | 必需 | 描述                                             |
| --------- | ------- | ---- | ------------------------------------------------ |
| namespace | string  | ✓    | 数据命名空间（如 `schema`, `entries`, `config`） |
| key       | string  | ✓    | 数据键名                                         |
| value     | unknown | ✓    | 要存储的 JSON 数据                               |

**输出**: `{ success, namespace, key }`

**治理路径**: 写入不是立即落库。它经会话内核的提交流程提交，和其他写入一样经过 `PreStateCommit` / `PostStateCommit`、trace 和存储事务。

#### 单个值的大小上限

一个值序列化成 JSON 后不得超过 **256 KiB**（UTF-8 字节；`MAX_PLUGIN_DATA_VALUE_BYTES`，`packages/shared/src/utils/plugin-data-limits.ts`）。

超出时发生什么：

- `plugin-data-set` / `plugin-data-set-batch` 在调用时就报错：`The value for <namespace>/<key> is N bytes; the limit for one value is 262144 bytes. …`。批量里有一条超限，整个调用失败。模型据此少写或拆分，不用等到提交时连同这个 runtime 的其他写入一起被丢掉。
- 其他入口上写入失败。错误写明插件 ID、`namespace/key`、实际字节数和上限。已存的值不变，也不会被截断。

同一个上限适用于所有写入口：

| 入口                                             | 超限时                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| 工具 `plugin-data-set` / `plugin-data-set-batch` | 调用时报错                                                                    |
| `plugin.data` / `plugin.data.batch` 的提交       | 提交失败                                                                      |
| `ctx.pluginData.set`、RPC handler 的 store view  | 写入失败                                                                      |
| REST `PUT /api/sessions/:id/plugin-data/...`     | 返回 `413`                                                                    |
| 世界包导入                                       | 该记录得到一条 error 诊断，导入失败、不截断。`pnpm validate:world` 同样报告。 |

作为参照，内置世界里最大的一条种子记录约 7 KB。要存更多内容时，拆成多个 key，或只保留之后的回合会读的部分。

#### 保留命名空间

`_` 开头的 namespace 属于框架自己的记账，插件不能写。例如 `_jobs`（旧的后台任务）、`_runtime_jobs`（detached 作业）、`_logs`（runtime 日志环）。读取不受影响。

这条限制由 `reservedPluginDataNamespaceError()`（`packages/shared/src/utils/plugin-data-namespace.ts`）统一实施，覆盖插件一侧的全部写入口：

- REST `PUT /api/sessions/:id/plugin-data/...`
- `plugin.data` / `plugin.data.batch` 的提交，包括由函数 runtime 的输出规范化出来的 proposal
- 函数 runtime 的 `ctx.pluginData`
- RPC handler 的 store view。所有插件的 RPC action（包括内置插件的）都通过 `createRpcHandlerStoreView()` 得到一个绑定了会话和插件的即时写入能力
- 内置函数 runtime 和 agent guard 通过 `createTrustedHandlerStore()` 得到的显式提案写入能力

两类插件句柄都不暴露宿主的事务、会话生命周期或关闭存储的方法。框架自己的特权写入者（后台任务运行器、runtime 日志）直接调用 store，不走这些入口。

### plugin-data-set-batch

一次调用写入多条数据。模型不用逐条调用，省掉很多轮往返。适合一次要写入大量条目的场景，例如世界初始化。

| 参数  | 类型                           | 必需 | 描述                     |
| ----- | ------------------------------ | ---- | ------------------------ |
| items | Array<{namespace, key, value}> | ✓    | 要批量写入的数据条目数组 |

每个 item:

| 字段      | 类型    | 必需 | 描述               |
| --------- | ------- | ---- | ------------------ |
| namespace | string  | ✓    | 数据命名空间       |
| key       | string  | ✓    | 数据键名           |
| value     | unknown | ✓    | 要存储的 JSON 数据 |

**输出**: `{ success, count, items: [{ namespace, key }] }`

**治理路径**: 和单条写入一样经提交流程提交。整个批次是一条 proposal，Hook、trace 和事务的处理与单条写入一致。

**设计原则**: 这是通用的批量写入。专用场景（例如世界初始化）建议插件写自己的工具，用更精确的 schema 引导模型生成结构正确的数据。

### plugin-data-get

从**当前插件**的存储里读一条数据。不允许跨插件读取。

| 参数      | 类型   | 必需 | 描述         |
| --------- | ------ | ---- | ------------ |
| namespace | string | ✓    | 数据命名空间 |
| key       | string | ✓    | 数据键名     |

**输出**: `{ found, namespace, key, value?, updatedAt? }`

**能读到自己刚写的。** 写入要到执行完成时才提交。但读取会把本次执行里还没提交的 `plugin.data` / `plugin.data.batch` / `plugin.data.delete` 叠加上去：

- 只叠加**当前会话、当前插件**的待提交操作。
- 同一个 key 按 proposal 的顺序应用，最后一次为准。删除后读取返回 `found: false`；之后再写入，读到新值。
- 写入 `null` 是存了一个值，不等于删除。
- 不同 runtime 各有自己的缓冲区，这里不会把它们合并。

**读不到的东西。**

- 隐藏世界数据（`_hidden.<namespace>`，来自 `visibility: hidden` 的 source，或插件在剧情中追加的）不会返回给模型，读取一律是 `found: false`。
- 任何 `_` 开头的内核 namespace 都不向模型暴露。
- `plugin-data-set` / `plugin-data-set-batch` 拒绝任何 `_` 开头的 namespace，所以模型也不能借通用工具写入隐藏数据。

### plugin-data-list

列出**当前插件**某个 namespace 下的全部条目。

| 参数      | 类型   | 必需 | 描述                           |
| --------- | ------ | ---- | ------------------------------ |
| namespace | string |      | 数据命名空间（不传则列出所有） |

**输出**: `{ count, items: [{ namespace, key, value, updatedAt }] }`

- 和 `plugin-data-get` 一样，叠加本次执行里没提交的写入和删除。被删除的条目不出现在列表里。
- `namespace` 过滤同样作用于待提交的条目。不传时合并所有 namespace。
- 隐藏世界数据的 namespace 不出现在结果里。

读取和合并按完整的 `(namespace, key)` 这一对字符串精确匹配，不按控制字符拆分，也不改写字段。框架导出的 `overlayPluginDataRows()` 用 `JSON.stringify([namespace, key])` 作为 Map 的 key。函数 runtime 和 guard 的缓冲读取遵循同样的规则。

### runtime-done

agent 用它告诉框架“我做完了”。业务工具都调用完之后调用它，这个 runtime 就结束，不用再让模型写一段收尾的话。

| 参数   | 类型   | 必需 | 描述              |
| ------ | ------ | ---- | ----------------- |
| reason | string |      | 可选的 trace 备注 |

故事 runtime 的工具列表里没有它，见 [ToolExecutor](#toolexecutor)。

### memory-search

搜索会话的记忆。它查两个来源：

- **recall**：对话历史和历史摘要。
- **archival**：长期知识库，包括 lorebook、角色，以及插件声明为可检索的数据。

| 参数  | 类型   | 必需 | 描述                                      |
| ----- | ------ | ---- | ----------------------------------------- |
| query | string | ✓    | 要找的名字和关键词；可以同时给出几种说法  |
| scope | enum   |      | `recall` / `archival` / `all`，默认 `all` |
| limit | number |      | 最多返回几条，1–20，默认 5                |

每条结果的内容最多 500 个字符。检索的规则见下一节。

### 插件记忆与向量搜索

这一节说明 `memory-search` 怎么检索，以及插件的数据怎样进入检索范围。

**不需要 embedding 模型。** 没有配置 embedding slot 时，recall 和 archival 用 BM25 排序（`@covel/plugin-handlers-utils` 的 `rankTexts`）：

- 查询和文本都切成词。中日韩文按相邻两个字切；英文按单词切，并把复数和所有格归并到原形。
- 只在少数文本里出现的词（人名、物品名）权重高。几乎每段都有的词权重接近零。长文本不会因为长而吃亏。
- 它只认字面，不认同义改写。所以工具说明要求调用方在查询里写上涉及的名字，并可以同时给出几种说法。

配置了 embedding slot，并且存储支持向量时，改走向量检索；失败时回退到 BM25。

**recall 的范围**是最近 500 条消息，加上全部历史摘要（`history.compact@2` 写入的摘要段，结果的 `role` 为 `summary`）。所以更早的回合仍然能通过摘要查到。

**archival 的范围：**

- Lorebook 词条。`enabled: false` 的词条被排除，关键词和向量两条路径都排除。
- 角色。角色检索不受 Lorebook 开关影响。
- 插件数据。只有插件用 `contributes.data.<namespace>.search` 声明过的 namespace 才进入 archival，并且只在该插件于当前会话启用时读取。没声明的 namespace，框架不读。

向量索引是异步更新的，可能暂时落后。所以向量结果会和当前的源数据核对一遍：已禁用、已删除或内容变了的旧项不会被返回，必要时回退到已过滤的关键词检索。重新启用一条词条后，关键词检索立刻恢复；语义索引可以复用，或由之后的索引任务重建。

**一次查询怎么执行。** `memory-search` 通过 `MemorySystem.search(sessionId, query, { scope, limit })` 查询，工具本身只处理参数和展示格式。

- `scope: "all"` 时同时搜索两个来源。两边共用一次查询 embedding（同一个模型），这份缓存只活到这次查询结束。
- embedding 失败时，两个来源各自回退到关键词搜索。

**混合结果的顺序。**

- 两个来源按各自的名次交替排列。同名次时 recall 在前。一个来源不够时，由另一个来源补满。
- 返回的 `score` 只在它自己的来源内部有意义。不能跨来源比较，也不能据此重新排序。一边走向量、另一边回退到关键词时也是如此。
- 指定单一 scope 时，保留该来源原有的顺序。

**和 `memory` 插件的关系。** `memory-search` 是框架的搜索工具。核心记忆块属于 `memory` 插件：

- 记忆块保存在该插件的 `blocks` namespace。后台提取通过普通的 `plugin.data` proposal 提交，并由 `prompt.segment@1` 提供提示词片段。
- 框架的工具不直接读写其他插件的块数据。
- 该插件的 `facts` namespace 声明了 `search`，所以它记下的事实由 archival 检索。

**其他插件怎么参与。**

- 提供 `memory.block-definitions@1` 只读服务，可以贡献记忆块的定义。
- 世界包通过 `contract:memory.blocks@1` 导入 `{id:"world",blocks:[...]}`。接收的插件在 `contributes.data` 里声明 accepts。
- 标签用小写 snake_case。内容长度和提取策略由记忆插件管理。

### world-dimension-get

读取世界维度的当前值。定义在 `packages/tools/src/builtin/world-dimension-tools.ts`。

所有插件读到的是同一份公开快照 `ctx.world.dimensions`，它在一次执行内是冻结的。这个工具：

- 不读提供者的私有 namespace。
- 不叠加调用方自己还没提交的写入。
- 不回退到世界的初值。

| 参数      | 类型                                       | 必需 | 描述                  |
| --------- | ------------------------------------------ | ---- | --------------------- |
| `queries` | Array<{dimension, path?, offset?, limit?}> | ✓    | 至少 1 项，最多 20 项 |

`dimension` 接受任意[合法作者 ID](./world-data.md#声明格式)，没有固定的名字白名单。

**`path`** 相对于该维度的 **`value`**，不是相对于它的定义或公开条目。支持的写法：

| 写法         | 例子                                  |
| ------------ | ------------------------------------- |
| 点路径       | `durability`                          |
| 数组下标     | `regions[0].name`                     |
| 根数组       | `[0].name`                            |
| JSON Pointer | `/regions/0/name`（支持 `~0` / `~1`） |

只读对象自己的属性，不读原型链。路径不存在时返回 `found:false`；语法错误时另带 `error`。

**分页。** 查询里带了 `offset` 或 `limit` 时：

- 字符串按 Unicode 字符分页，数组按元素，对象按自有条目。
- `offset` 默认 0。`limit` 默认 100，范围 1–2000。
- 结构化的 `results` 保留选中的值，并加上 `page:{value,total,nextOffset?}`。
- 分页只改变模型一次读回多少，不改变快照。

例如查询 `{queries:[{dimension:"reputation"}]}`：

```json
{
  "success": true,
  "results": [
    {
      "dimension": "reputation",
      "found": true,
      "value": 5,
      "name": "声望",
      "schema": { "type": "integer", "minimum": 0, "maximum": 100 },
      "version": 2
    }
  ],
  "_text": "reputation (v2) = 5"
}
```

模型只看到预算内的 `_text`；trace 和调试里保留完整的结构化结果。没有分页的长值会带一条截断提示。这时应该继续查更窄的路径或更小的页，不能把截断的内容当成完整的值。

公开结果不带 `initialValue`、`updateRule` 或追踪来源。

### world-dimension-list

和 `world-dimension-get` 在同一个模块。参数为 `{}`，返回 `{dimensions:[{id,name,type,version}], _text}`。`type` 来自 schema 的 `type`，schema 没写时可以缺失。

这个工具只用来发现有哪些维度和它们的版本，不返回值、规则或初值。先用它找到 ID，再用 `world-dimension-get` 读需要的路径。这样不用把大量数据整个放进提示词。

### emit-event

发出一个领域事件。事件必须是某个已启用的插件在 `events` 里声明过的（见 [plugins.md § Runtime 分组字段](./plugins.md#runtime-分组字段)）。声明在 `packages/tools/src/builtin/emit-event.ts`。

| 参数  | 类型                    | 必需 | 描述                                                    |
| ----- | ----------------------- | ---- | ------------------------------------------------------- |
| topic | string                  | ✓    | 事件 topic，须匹配某个激活插件已声明的 `events[].topic` |
| data  | Record<string, unknown> |      | 事件 payload，按声明的 JSON Schema 校验，默认 `{}`      |

**一次一个 topic**：一次调用只发一条事件。要发多个领域事件时，多次调用 `emit-event`。

校验和可用 topic 的列举交给一个事件目录（`EventDirectoryLike`；服务端的实现在 `apps/server/src/routes/api/bootstrap/event-directory.ts`）。它汇总当前会话里已启用插件的声明。一个 topic 在一个会话里只有一个声明它的插件（见 [plugins.md § 会话插件选择](./plugins.md#会话插件选择)），所以 payload 总是按这唯一的一份 schema 校验。

#### 一次调用的四种结果

按顺序检查：

| 序号 | 情况                                    | 工具调用 | 回给模型的文本                                                                                                                                                               |
| ---- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 这个 topic 本回合已经发过               | 成功     | `event "<topic>" was already emitted this turn and is recorded. Do not emit it again; continue with the task.` 不产生第二条事件。                                            |
| 2    | topic 不在当前会话的公开目录里          | 失败     | `unknown topic "<topic>"; no active plugin consumes it, so it cannot be emitted. Do not retry it. Available topics: <逗号分隔列表，或 "(none — no consumer plugin active)">` |
| 3    | topic 已知，但 payload 不合 JSON Schema | 失败     | `event payload rejected: <ajv 错误文本>`                                                                                                                                     |
| 4    | 全部通过                                | 成功     | `event "<topic>" emitted and recorded for this turn. Do not emit it again.` 结果带上 `emittedEvents`。                                                                       |

第 4 种的文本明确说“不要再发”。只回一个 `emitted` 时，有些模型会为了保险把同一个事件再发一次，白费一轮调用。

第 2、3 种是失败的工具调用：错误文本回给模型，这次调用不算“用过工具”（`requireToolUse`），也不算结束工具的完成条件。但它们对 runtime 结果的影响不同：

- **未知 topic（第 2 种）不算 runtime 的失败。** 没有启用的插件声明这个 topic，模型无从改正，这次调用什么也没做。工具用 `ToolRefusal`（`@covel/tools`）拒绝：它不算业务工作（`requireToolUse` 仍未满足，也不触发 `completeAfterTools`），也不算一条“还没解决的失败”。一个 agent 只发了这一次 emit，随后用文字或 `runtime-done` 收尾，结果是正常成功，只是没有事件发出。所以卸掉消费事件的插件，不会让发出事件的 runtime 失败。
- **payload 不合 schema（第 3 种）是失败。** 约定存在，只是数据不对，模型可以按错误文本重发。同一个工具后来成功的一次调用会抵消它。没有重发成功、也没有其他输出就收尾的 `system` runtime 以 `tool_failed_without_output` 失败。声明了 `requireExplicitCompletion` 的 runtime 在它没解决之前，不能用 `runtime-done` 收尾。

**内部 topic。** 声明为 `advertise: false` 的 topic 不进 `emit-event` 的白名单。它只能由声明它的插件自己的**函数 runtime**通过 `output.events` 发出。agent 不能用 `emit-event` 直接发它，绕过中间的生成步骤。第 2 种结果里回显的可用列表也不包含内部 topic 的名字。

第 1 种里“本回合已经发过”的记录是 `context.emittedEventTopics`，由工具循环累积后传入（`packages/tools/src/types.ts` 的 `ToolExecutionContext.emittedEventTopics`）。

#### 事件走哪条通道

发射成功时，事件只通过工具结果里的 `emittedEvents` 通道带出（`withEmittedEvents`，`packages/tools/src/result.ts`）。工具循环把它们累积起来，`finalize-agent-output.ts` 再合并进 `RuntimeResult.output.events`。

工具**绝不**同时返回一条 `event.emit` 的待提交 proposal。否则同一个事件会被处理两遍：一遍是回合内的事件分发，一遍是 proposal 规范化。

合并进 `output.events` 之后，事件走已有的流程：回合内分发给订阅者，规范化成 `event.emit` proposal，最后以 `event.emitted` SSE 事件发给客户端（见 [protocol.md](./protocol.md)）。

规范化只认带 `topic` 字段的 `{ topic, data? }` 信封。插件的输出 schema 可以把同名的 `events` 用作自己的数据字段（例如 WorldIR 的事实事件），这类条目不会生成 `event.emit` proposal。

#### 去重的范围

去重的范围是**一个工具循环**。同一个 runtime 在同一回合里重复发同一个 topic，第二次是空操作。

它**不跨 runtime**。同一层里并行的两个 runtime 可以各自发同一个 topic。这不是缺陷：

- 事件分发在收集阶段按 topic 汇总，同一层里先发出的那条生效（见 `collectEventsFrom`）。所以下游的订阅者仍然只被触发一次。
- 代价是：同一层里第二个 runtime 发出的同 topic payload 不会被投递。调度器为它发出 `scheduling.hazard`（`code: "event-payload-dropped"`，含 topic 和 runtimeId），不会悄悄丢掉。

要传递多条信息时，在一个事件的 `data` 里成批携带（例如 `check.resolved` 的批量约定），或给不同的来源用不同的 topic。

#### 让回执可以当场核对

JSON Schema 只能检查字段的形状，检查不了“这个结果和骰子对不对得上”。而消费事件的 runtime 要等整个回合写完才运行，那时发现回执不对，已经来不及改正文了。两条做法可以避免这种事后才失败的回执：

- 回执里只放模型自己决定的内容。代码算得出的字段不要让模型填。让模型同时填“难度名”和“DC 数字”、“骰值”和“合计”，就多出几处会对不上的地方。
- 需要对照本回合数据的检查，放在声明事件的插件自己的 `PreToolUse` Hook 里，在事件发出的当场做：不符就 `abort`，把正确的值写进 `reason`。`reason` 会作为这次工具调用的结果回给模型，它可以在写正文之前重发。

`dice-check` 是例子：回执里没有骰值、DC 和合计，由 recorder 按顺序取骰并计算。`hooks/verify-check-receipt.js` 在叙事发出回执时对照骰子，结果不符就把每次判定的正确结果退回去。

**使用者**：任何声明了 `advertiseEvents: true`、并且在 `tools.builtin` 里列了 `emit-event` 的 agent runtime，例如 `narrator`、`chat-mode-narrator`。

### suspend

让当前 runtime 停下来，等玩家给出输入后再继续。声明在 `packages/tools/src/builtin/suspend.ts`。

| 参数         | 类型   | 必需 | 描述                                                                                                                                             |
| ------------ | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| reason       | string | ✓    | 给玩家看的简短说明，解释为什么需要输入                                                                                                           |
| resumeSchema | object | ✓    | **纯 JSON Schema 对象**（`type` / `properties` / `required`）。插件如需用 Zod 定义，必须先用 `zod-to-json-schema` 转换 —— 不要传 live Zod schema |

**输出**: 一个标记对象 `{ _covelSuspend: true, reason, resumeSchema }`。它被框架拦下，正常情况下不会作为普通工具结果回到模型。

调用之后发生的事：

1. agent 调用 `suspend({ reason, resumeSchema })`，工具返回上面的标记对象。
2. 框架在每次工具执行后用 `isSuspendSentinel()` 检查结果。认出标记后，它把这次运行的现场写进 `suspensions` 表：执行的身份、已经缓冲的 proposal 和事件、和模型的完整对话记录。
3. 框架发出 `turn.suspended` 事件，整个工具循环立即停止。
4. 之后通过 `POST /api/sessions/:id/suspensions/:suspensionId/resume` 提交一份符合 `resumeSchema` 的数据，这个 runtime 就从停下的地方继续（详见 [api.md](./api.md)）。

模型的一条回答里有多个工具调用时：`suspend` 那次调用先留一个可以替换的占位结果，它后面还没执行的调用各写入一条“已取消”的结果。这样恢复之后，对话记录仍然满足服务商“工具调用和结果必须成对”的要求。

**注意事项**：

- `resumeSchema` 必须能被 `JSON.stringify`，因为现场要写进存储。
- 同一个 runtime 同一时刻只能有一个没解决的挂起。恢复接口按 `runtimeId + sessionId` 查找。
- `@covel/tools` 的 `createDefaultToolRegistry` 把它注册为内置工具。agent 仍要在 `agent.tools.builtin` 里列出 `suspend` 才能调用。
- 恢复是接着被挂起的那次执行继续：
  - `ctx.locale`、`ctx.logicalTurn`、`ctx.turnNumber` 取挂起时的值，不随会话之后的回合计数变化。
  - `ctx.world` 是恢复时已提交的 World Model，再叠加现场里缓冲的写入。
- `completion.require: tool-use` 在恢复后只承认挂起前**成功**的业务工具调用。挂起前失败、又没有被同名的成功调用抵消的工具仍算没完成，恢复后必须重新完成。

### search-tools（框架注入，延迟工具加载）

一个 runtime 的工具很多时，把所有工具的 schema 都放进每次模型调用很占地方。可以声明 `tools.defer` 把一部分工具“延迟”：它们的 schema 不进初始的工具清单，模型需要时用 `search-tools` 搜出来。

- `tools.defer: true` 延迟整个白名单；`tools.defer: [名字, …]` 只延迟列出的工具。
- 声明了 `tools.defer`，框架就自动注入 `search-tools`。**不能在 `tools.builtin` 里手动声明它。**

| 参数  | 类型   | 必需 | 描述                                        |
| ----- | ------ | ---- | ------------------------------------------- |
| query | string | ✓    | 能力关键词（中英文均可），如 `切换场景背景` |
| limit | number | —    | 最多激活的工具数（默认 8，上限 20）         |

**输出**: 一段文本，列出命中的工具的名字和描述。命中工具的完整 schema 从下一次模型调用起加入工具清单，在本回合的 agent 循环内一直有效。到了下一回合，清单重置为精简的版本。

**注意事项**：

- 这个调用由 agent 循环直接处理，**不进入 ToolExecutor**，也不在工具注册表里。它的名字仍然是框架保留名。
- 搜索的范围严格限于这个 runtime 自己声明并且被延迟的工具。schema 通过 `getToolInfo(name, context)` 取得，沿用 builtin / local 的访问边界：没有权限的工具搜不到，也不会泄露。
- 打分用不带任何依赖的 BM25（k1=1.2 / b=0.75）。中日韩文本按相邻两个字切分。被搜索的文本是：工具名、描述、参数 schema 里的字段名和字段描述。
- `search-tools` 的描述会告诉模型延迟池里有多少工具、来自哪些插件。模型据此知道还有没加载的工具可以搜。
- 适用场景：一个 runtime 的白名单超过大约 10 个工具，每次调用都预载全部 schema 开始挤占提示词预算。

契约声明在 `packages/tools/src/builtin/tool-search.ts`，执行逻辑在 `packages/runtime/src/agent-loop/tool-search.ts`。做法参照 openai/codex 的 `tool_search`（`ToolExposure::Deferred` + BM25）。

## Character 管理工具

框架自带的角色管理工具，定义在 `packages/tools/src/builtin/character-tools.ts`。角色写入 `characters` 表。角色属于会话，所有插件都能看到。

### 文本优先（Text-first）约定

这一组工具的返回值里有一个特殊字段 `_text`。其他工具也可以采用这个约定。

- **模型看到的 = `_text` 的原始文本**，不带 JSON 包装。
- **trace 和调试界面看到的 = 完整的 `parsedResult` 对象**，包括 `_text` 和结构化字段。

这样模型读到的是紧凑的自然语言（省 token、少干扰），框架仍然有结构化数据用于调试和追踪。

框架（`packages/runtime/src/agent-loop/tool-executor.ts`）按有没有 `_text` 决定给模型什么：

| 结果                  | 给模型的内容                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 有 `_text` 且是字符串 | 直接是这段文本。                                                                                                                                                                                                                               |
| 没有 `_text`          | 结果序列化成 JSON，但去掉两类内容：记账字段（行的 `updatedAt`、消息的 `timestamp`、UUID 形式的 `…Id`、`sessionId`；规则见[记录里的簿记字段](./plugins.md#输入和输出)），以及结果顶层的 `ui` 数组（那是给玩家界面的卡片，内容是模型刚写过的）。 |

不论哪种情况，`parsedResult` 和 `ctx.tools.call` 的返回值都是完整对象。

其他 builtin 工具（如 `plugin-data-*`、`create-form`）目前返回 JSON。

### create-character

创建一个新的角色记录：玩家、NPC 或同伴。

| 参数        | 类型                    | 必需 | 描述                                                      |
| ----------- | ----------------------- | ---- | --------------------------------------------------------- |
| name        | string                  | ✓    | 角色名称                                                  |
| aliases     | string[]                |      | 同一个人的其他叫法（昵称、头衔、另一种文字的名字）        |
| type        | enum                    | ✓    | `player` / `npc` / `companion`                            |
| description | string                  |      | 角色简短描述                                              |
| fields      | Record<string, unknown> |      | 属性键值对（应符合世界 schema 中的 character-attributes） |

**输出 (parsedResult)**: `{ _text, success, existed, characterId, name, type }`

新角色的 id 由名字生成，是可读的单词形式（见[短 ID](#短-idllm-友好实体引用)）。

#### 去重

- 同一个会话里，同 `(name, type)` 的角色不会被创建第二次。工具返回已存在的角色的 id。
- 名字按[归一规则](./world-model.md#别名与按名字解析)比较：大小写、全角半角、空白、间隔号的差别不算。
- 名字是任一已有角色的**别名**时，不论类型，都返回那个角色，不创建。
- 创建 `type: "player"` 时，名字如果是其他角色的名字或别名，工具报错，并要求向玩家另要一个名字：玩家不会是世界里一个已有的 NPC。
- 每个会话最多一个 player。其他类型来自 schema 的 `types`。

**模型看到的 `_text` 示例**：

```
Created npc "苏婉" as char-abc123. — 青萍宗外门首席弟子，冰灵根修士。
```

去重命中时：

```
Character "苏婉" (npc) already exists as char-abc123. No new record created. Use update-character to modify it.
```

`aliases` 里有别的角色的名字或别名时，调用失败，不产生 proposal。错误写明是哪个角色，模型可以改为更新它：

```
"守灯人" is already a name of 守灯人伊索德 (aka 伊索德, 守灯人) [npc-keeper-ysolde]. If 老妇人 is that person, update npc-keeper-ysolde and create nothing. If the alias is wrong for 守灯人伊索德, remove it there first: update npc-keeper-ysolde with removeAliases. Otherwise leave this alias out.
```

#### 属性怎么校验

- 模型看到的 `fields` 参数是一个紧凑的对象。`create-character` 和 `update-character` 两份工具定义里都不重复整张世界属性表。这样上下文只有 8k 的小模型不会因为角色属性多，就被两份重复的 JSON Schema 占满。
- 属性的权威定义（id、类型、范围、enum、默认值、说明）保存在会话的 world schema 里。
- 工具描述里另附一份精简的字段约束：类型、数值上下界、enum 选项、数组和映射的元素类型、嵌套结构。不重复长描述和默认值。`sync-characters` 的 creates 和 updates 共用一份约束说明。
- 执行时重新读取权威 schema：合并默认值，强制校验声明过的字段。校验发生在产生写入 proposal **之前**。非法的字符串、`null` 或非有限数值不能冒充数值属性。
- 没有声明的键仍然保留，但返回一条 warning。
- `create-character` 先合并缺省值再校验。`update-character` 只校验这一次的 patch，所以可以逐个字段修好已有的旧数据。
- 数值 patch 写的是更新后的绝对值，不是增量。

插件可以用同一套规则：`mergeSchemaDefaults` 和 `assertCharacterFields`，失败时抛出 `CharacterFieldValidationError`。

#### 读到的是哪一份数据

`get-character-schema`、默认值填充和角色写入校验都读会话的 World Model。这份视图按执行顺序合并三样东西：已提交的记录、成功的上游 runtime 的领域 proposal、本 runtime 待提交的 proposal。无效的 schema 或角色写入不会进入这份视图。角色记录不镜像到插件私有数据。

读取时按 proposal 的顺序应用更新，用的是和提交相同的 `materializeCharacterUpsert`：

| 写入                             | 效果                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 带 `expectedVersion` 的更新      | 浅合并对象字段，保留没改的字段，每次把当前版本加一。空字符串描述可以清空旧描述。非对象的字段值整体替换。 |
| 整个 `fields` 为 `null`          | 清空属性。读取时统一成 `undefined`。对象内部的 `null` 值保持不变。                                       |
| 不带 `expectedVersion` 的 upsert | 完整替换，不继承被省略的旧字段。                                                                         |

底层的 `CharacterStore.upsertCharacter` 保存完整快照，包括传入的创建时间。Memory、SQLite、PostgreSQL 三种存储行为相同。

提交时还会再做一次版本和参数校验。待提交视图里看得到，不代表已经提交成功。

`overlayCharacters(proposals, stored, sessionId)` 接收已存储的角色和会话 ID，返回该会话完整角色视图的 `Map<string, CharacterRecord>`。结果和输入之间没有共享引用。`CharacterRecord` 由 `@covel/shared` 定义，`@covel/store` 也导出同名类型。

#### 开场角色表单

`char-creator/player-init` 用插件工具 `create-character-form` 包装通用的 `create-form`：

- 只允许必填的 `characterName`，以及世界 schema 里的 string / enum 字段。enum 的提交值必须来自原来的 options。
- 数字和复合属性保留默认值，不能改成叙事里的 select。
- 表单里有不能收集的字段时，工具一次列出全部被拒的字段和原因（不是世界属性，或是数值 / 复合属性），并给出这个世界可以收集的属性清单。世界没有 string / enum 属性时，明确说明表单只有 `characterName` 一个字段。
- 校验用同一轮上游给出的 schema，发生在展示表单之前。普通的 `create-form` 不受这些角色专属规则影响。
- 一份已被接受、后来才发现不合规则的提交，保留作为审计记录，values 不改写。这时要重新开始建角会话；普通的 setup 重试不会清除这份输入。

**使用者**: 通用 builtin。内置的 `char-creator/character-tracker` 通过下面的 `sync-characters` 间接复用它。`player-init` 的表单提交由 guard 直接生成同类 proposal，不向模型暴露这个工具。

> [!IMPORTANT]
> **写入是缓冲的。** `create-character` / `update-character` 执行时不直接写 `characters` 表，而是缓冲成一条 [`character.upsert`](#characterupsert) proposal。
>
> - 同一个工具循环里能读到自己缓冲的写入：先 create 再 update，update 读得到刚才的 create。
> - 真正写表发生在回合结束时，和这次执行的其他写入在**同一个事务**里。
> - 结果是 `success` / `skipped` 的 runtime，缓冲的 proposal 会提交；`failed` / `suspended` 的不提交。

这个工具不改变会话的阶段。setup 的完成由 runtime 输出 `preGameDone: true` 表示，框架据此更新 `session.setupRuntimes`，并自己推进 `session.phase`（`setup` / `playing`）。

### update-character

更新一个已有的角色。适用于状态变化、换装备、受伤、死亡，以及故事揭示了角色的另一个名字。

| 参数          | 类型                    | 必需 | 描述                                       |
| ------------- | ----------------------- | ---- | ------------------------------------------ |
| id            | string                  | ✓    | 要更新的角色 id；角色的名字或别名也可以    |
| aliases       | string[]                |      | 要追加的别名；已有的、与名字相同的自动略过 |
| removeAliases | string[]                |      | 要去掉的别名（见下）                       |
| description   | string                  |      | 新描述（未传则保留原值）                   |
| fields        | Record<string, unknown> |      | 要合并的字段                               |

每个参数的效果：

- `fields` 浅合并：新键覆盖旧键。
- `aliases` 追加到已有别名之后。
- `removeAliases` 去掉已有的别名。
- `version` 自动加一。

**`id` 怎么解析。** `id` 经 [`resolveCharacter`](./world-model.md#别名与按名字解析) 解析：先按 id，再按名字，再按别名。所以模型写了名字或别名，也会更新到同一个角色，不会因为对不上 id 而另建一个。写入不做部分匹配。

**`removeAliases`** 用来撤销挂错的别名：

- 按[归一规则](./world-model.md#别名与按名字解析)比较。
- 不是该角色别名的名字，不产生任何变化，也不报错。
- 角色自己的名字不会被去掉。
- 同一次调用里先去掉再追加，所以一次调用可以换掉一个别名。
- 在 `sync-characters.updates[]` 里，前一项去掉的别名，后一项可以加给另一个角色。

**成功输出 (parsedResult)**: `{ _text, success: true, characterId, version }`

**模型看到的 `_text` 示例**：

```
Updated npc "苏婉" (char-abc123) → v2.
  hp: 100 → 60
  status: alive → wounded
```

#### 失败时

| 情况                       | 错误                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 找不到角色                 | 列出最相近的已知名字；没有相近的就列出会话里的角色，最多 30 个。例如 `Character "伊索尔德" not found. Closest known names: 守灯人伊索德 (aka 伊索德, 守灯人). If it is one of them, use that name. Nothing was updated.` |
| 名字或别名属于不止一个角色 | 列出各自的 id：`"Maud" names 2 characters: Maud [npc-a]; maud [npc-b]. Pass the id of the one you mean. Nothing was updated.`                                                                                            |
| 要追加的别名属于别的角色   | 失败，并写明这个别名属于谁。                                                                                                                                                                                             |

这些都是抛出的错误，不是正常返回的 `success: false`。模型在工具循环里收到：

```json
{
  "success": false,
  "error": "Tool \"update-character\" failed during execution: …",
  "code": "EXECUTION_ERROR"
}
```

执行器把这次调用记为失败。它不满足 agent 的 `completeAfterTools`。函数 runtime 即使捕获了这个错误，也不会提交之前缓冲的写入。

### sync-characters

把同一个叙事回合里发现的新角色和已有角色的变化，合并成一次提交。要么全部成功，要么什么都不写：中途任何一条创建或更新失败，这次调用不留下部分写入。

它复用 `create-character` / `update-character` 的去重、默认值合并、schema warning 和“读到自己缓冲的写入”。

| 参数      | 类型              | 必需 | 描述                                  |
| --------- | ----------------- | ---- | ------------------------------------- |
| `creates` | CharacterCreate[] |      | 新角色，默认 `[]`，最多 5 条          |
| `updates` | CharacterUpdate[] |      | 已有角色 patch，默认 `[]`，最多 10 条 |

`creates[]` 的每一项和 `create-character` 的参数相同，`updates[]` 的每一项和 `update-character` 的参数相同。

**输出 (parsedResult)**: `{ _text, success: true, created, updated, unchanged }`

规则：

- 两组可以同时为空。空批次表示“本回合没有角色变化”，调用成功，不产生 proposal。
- 同会话同 `(name, type)` 的重复 create 不算错：它返回 `unchanged`，带上已有角色的 id。它不覆盖已有的 description 和 fields，也不妨碍批次里其他合法的操作。要修改已有角色，必须明确放进 `updates`。
- 其他校验失败会让整批失败。修正后要重新提交完整的批次。
- 同一批里靠前的创建和更新，对靠后的条目可见。

写组合工具的宿主开发者要注意：宿主提供了 `context.world` 时，组合工具只把本批新增的 proposal 叠加到这份快照上。快照里已经包含的外层上游 proposal 和待提交 proposal 不能再叠加一遍，否则版本会被多推进一次，或覆盖更新的字段。

**使用者**: `char-creator/character-tracker`。它把 `sync-characters` 放进 `completeAfterTools`：工具成功后立即结束，不再请求模型收尾。这个 tracker 的配置：

- 声明 `toolChoice: required`，每次回复都必须调用工具。没有变化时提交空批次。
- 使用默认的 20 步工具循环预算，所以它可以先读取角色，也可以修正失败的批次。成功同步后立即结束。
- 每个批次的上限仍是 5 个新角色和 10 个已有角色更新。
- 它自己才看得到的 `<existing-characters>` 名册列出每个角色的 id、姓名、别名（有才出现）、类型和 description。这一段只在角色新增或改写时才变。
- `<character-fields>` 每行一个 id，在 12000 字符的预算内带上该角色当前的 `fields`，每回合更新。通常一次模型调用就能完成同步。超出预算的角色那一行写 `fieldsOmitted`，再用 `get-character` 读取。
- 关闭推理，单次调用超时 30 秒，重试一次。

### list-characters

列出本会话的全部角色。角色属于会话，所有插件都能看到。

输出是**紧凑的文本列表**，一行一个角色：id、名字（有别名时后面跟 `(aka …)`）、类型、版本、简短描述。模型用它快速对上已知的人物；需要完整属性时，再单独调用 `get-character`。

| 参数 | 类型 | 必需 | 描述                                |
| ---- | ---- | ---- | ----------------------------------- |
| type | enum |      | `player` / `npc` / `companion` 过滤 |

**输出 (parsedResult)**: `{ _text, count, characters: CharacterSnapshot[] }`

**排序**：先按 `version` 从高到低（版本越高，被交互的次数越多），再按 `updatedAt` 从新到旧。

**条数上限**：一次最多返回排在前面的 50 个角色（内置世界预置 10 到 16 个）。

- `count` 仍是符合条件的总数。
- 超出时，`_text` 末尾加一行，说明还有多少个没列出，并提示按 `type` 过滤或用 `get-character` 按名字查找。
- `characters` 只含列出的那些。

**模型看到的 `_text` 示例**：

```
Characters in session (3 total, sorted by frequency then recency):
1. 苏婉 [npc] char-abc (v3) — 青萍宗外门首席弟子，冰灵根修士，知晓野生灵脉秘密
2. 柳娘 [npc] char-def (v2) — 药王谷谷主，三百年前见过碧鳞龙
3. 柳无痕 [player] char-xyz (v1) — 青萍宗外门弟子，水灵根中品
```

**使用者**：叙事和聊天叙事插件声明了这个工具，用来查当前场景之外的角色。第三方插件也可以声明。已经通过上下文拿到角色名册的插件，可以用 `get-character` 补上摘要里没有的完整属性。

### get-character-schema

读取会话的角色属性 schema。参数为 `{}`，返回 `{ schema: CharacterSchemaRecord | null, _text }`。

- schema 属于会话的 World Model，包含 `version` / `types` / `attributes`。不存在时返回 `null`。
- 读取包括已验证的待提交领域 proposal。它不根据插件私有的 `schema` 数据推断。
- 这个工具不写数据，也不接受其他会话或插件的 ID。

第三方创角插件可以优先用本次执行里绑定的 schema 输入。恢复一个旧会话时，用这个工具读取之前已经完成的 setup 结果。这样既不用读其他插件的私有数据，也不用依赖官方提供者的名字。

### get-character

按 id、名字或别名查一个角色的**完整属性**：别名、description、version、时间戳、全部 fields。`id` 和 `name` 必须传其中一个。

叙事插件可以只声明 `list-characters` 和 `get-character` 这两个只读工具，不需要依赖角色管理插件。读取范围始终是当前会话，包括不活跃的、从未出场的角色。

| 参数 | 类型   | 必需 | 描述                                           |
| ---- | ------ | ---- | ---------------------------------------------- |
| id   | string |      | 角色 id                                        |
| name | string |      | 角色名字或别名；只写一部分（如不带头衔）也可以 |

**宽松匹配。** 查找用 [`resolveCharacter`](./world-model.md#别名与按名字解析) 并打开 `partial`：没有精确匹配时，如果只有一个角色的名字或别名包含查询词（或被查询词包含），也算找到。这个工具只读，所以允许这样；写入工具不允许。

**输出 (parsedResult)**:

- 找到：`{ _text, found, character: CharacterSnapshot }`
- 没找到：`{ _text, found: false, candidates: string[] }`。`_text` 和 `update-character` 找不到角色时的信息相同（最相近的名字，或有歧义的候选）。`candidates` 是这些角色的名字。

**模型看到的 `_text` 示例**：

```
Character: 苏婉 [npc] char-abc123
Description: 青萍宗外门首席弟子，冰灵根修士。发现百灵沼泽深处一条野生灵脉...
Version: 3
Created: 2026-04-12T04:00:00.000Z
Updated: 2026-04-12T04:24:55.000Z

Attributes:
  hp: 60
  mp: 80
  maxHp: 100
  maxMp: 100
  level: 4
  lingGen: 冰灵根
  status: wounded
```

## Plugin tools（内部来源标签：`local`）

插件自带的工具。实现文件通常放在插件包自己的 `tools/` 或 `server/` 目录，用 `tool()` 创建，由 `entry` 导入并注册。下面是内置插件的工具。

### Plugin tool 的推荐使用方式

- 文件放在插件自己的 `tools/` 或 runtime 子目录下。
- 在 `entry` 模块（`server/index.js`）里用 `covel.registerTool(makeMyTool(covel.toolkit))` 注册。使用它的 runtime 在 `RUNTIME.md` 的 `agent.tools.plugin` 或 `function.tools.plugin` 里按名字声明。
- 为每个 plugin 工具写独立的测试。
- 持久化写入返回 `withPendingProposals(...)`，让提交流程负责落库。
- 用 plugin 工具封装插件自己的数据 schema 和批量写入逻辑。

### initialize-world

**所属**: world-init (`plugins/world-init/tools/initialize-world.js`)

开局时一次完成两件事：定下角色属性 schema，以及采用维度声明。它在一个工具结果里返回 `character.schema.set` 和 `dimension.initialize` 两条 proposal。任何一部分失败，都不会留下半套写入；执行成功后两者一起提交。

| 参数          | 类型            | 必需 | 描述                                                                    |
| ------------- | --------------- | ---- | ----------------------------------------------------------------------- |
| `types`       | string[]        |      | 默认 `["npc", "companion"]`                                             |
| `attributes`  | AttributeDef[]  | ✓    | 至少 15 项，覆盖 `stats` / `bio` / `abilities` / `equipment` / `social` |
| `definitions` | WorldDimensions |      | 没有作者声明时可提供生成的 definition map；世界有声明时不被采用         |

**输出**: `{success, attributeCount, dimensionCount, worldSchema, preGameDone:true}`

维度定义用谁的：

- 世界的作者已经声明了维度时，用作者的定义。模型同时给出的 `definitions` 不被采用，调用照常成功。不拒绝的原因：提示词没法告诉模型这个世界有没有声明，拒绝只会让每局开头多一次模型调用。
- 没有声明的、只有设定文本的世界，才使用模型生成的 definitions。
- 工具不把资源结构变成角色字段，也不变成 constant lorebook。

`worldSchema` 同时是 `world-init/schema-gen` 的 runtime 输出，交给同一次 setup 执行里的 `char-creator/player-init`。这样下游不用去读还没提交的存储。

这个 runtime 声明了 `agent.loop.completion: {require: tool-use, afterTools: [initialize-world]}` 和 `io.output.schema`。所以模型只需要生成一次工具参数：工具成功后，框架直接用输出 schema 检查结果并结束。

**使用者**: `world-init/schema-gen`

### set-world-schema

**所属**: world-init (`plugins/world-init/tools/set-world-schema.js`)

定义世界的角色类型和属性。它返回一条 `character.schema.set` proposal，写入会话的 World Model。payload 是 `{types,attributes}`，版本由内核递增。它不写插件私有的 schema namespace。

| 参数       | 类型           | 必需 | 描述                          |
| ---------- | -------------- | ---- | ----------------------------- |
| attributes | AttributeDef[] | ✓    | 角色属性定义数组（至少 1 个） |

**AttributeDef**:

| 字段         | 类型           | 必需 | 描述                                                                  |
| ------------ | -------------- | ---- | --------------------------------------------------------------------- |
| id           | string         | ✓    | 属性唯一标识                                                          |
| name         | I18nText       | ✓    | 属性显示名称（字符串或 locale → string 记录）                         |
| type         | enum           | ✓    | `string` / `number` / `array` / `enum` / `boolean` / `object` / `map` |
| category     | enum           | ✓    | `stats` / `bio` / `abilities` / `equipment` / `social`                |
| min/max      | number         |      | 数值类型的范围                                                        |
| defaultValue | unknown        |      | 默认值                                                                |
| itemType     | enum           |      | 数组元素类型（`string` / `number`）                                   |
| options      | string[]       |      | 枚举选项列表                                                          |
| subSchema    | AttributeDef[] |      | `object` 的递归子字段定义                                             |
| valueType    | enum           |      | `map` 的值类型（`string` / `number` / `boolean`）                     |
| description  | I18nText       |      | 属性说明（字符串或 locale → string 记录）                             |

**输出**: `{ success, attributeCount, categories, worldSchema }`

**当前用途**: `initialize-world` 内部用它来组合。内置的 `world-init/schema-gen` 不直接向模型声明它。

### set-world-dimensions

**所属**: world-init (`plugins/world-init/tools/set-world-dimensions.js`)

采用维度声明。参数 `{definitions}` 使用[开放 definition map](./world-data.md#声明格式)。返回 `{success, dimensionCount}` 和一条 `dimension.initialize` proposal。

- 缺少的记录被创建。
- 用同样的定义重复初始化，不会重置当前值。
- 已采用的定义和这次不同，算冲突。
- 声明的变更通过 world sync 处理。不要用这个工具覆盖游戏进度。

### dimension-rule-get

**所属**: world-init (`plugins/world-init/tools/dimension-rule-get.js`)

维护维度时用来读规则的工具。它只读本插件的有效定义，并且依赖已经绑定的叙事来源。它不是其他插件读取规则的公开入口。

重试时优先用源回执里冻结的定义，并检查当前版本和执行快照一致。

| 参数     | 类型              | 必需 | 描述                                        |
| -------- | ----------------- | ---- | ------------------------------------------- |
| `id`     | string            | ✓    | 合法维度 ID                                 |
| `part`   | `rule` / `schema` | ✓    | 本地化更新规则或 schema JSON                |
| `offset` | integer           |      | 默认 0                                      |
| `limit`  | integer           |      | 默认 6000，范围 1–6000，按 Unicode 字符分页 |

返回 `{id,version,content,complete,nextOffset?,_text}`。`complete:false` 时要继续取下一页，不能只凭被截断的规则预览就结算。

### update-dimensions

**所属**: world-init (`plugins/world-init/tools/update-dimensions.js`)

每个叙事回合之后，更新世界维度的当前值，或明确表示这一回合没有变化。

参数：`{followsClock:[id], updates:[{id, value|changes, reason?}]}`

返回 `{success,updateCount}` 和 `dimension.update` proposal。这个来源已经结算过时，返回 `{success,alreadySettled:true}`，不重复补算。

#### `updates`

- 最多 64 项，ID 不能重复。
- 每一项给 `value` 或 `changes`，二选一：
  - `value` 是新的完整值。
  - `changes:[{path,value}]`（最多 32 项）按点路径在冻结的当前值上设置字段或新增条目。工具把它们合并成完整值再提交，所以大的维度不必整体重写。
- 删除一条命名记录或数组里的一行，仍然要提交完整的 `value`。
- `dimension.update` proposal 里始终是完整值。
- `null` 只在 schema 允许时是合法的值。它不表示删除维度。
- 路径里含 `__proto__`、`constructor` 或 `prototype` 段时，整批拒绝。
- 工具的预检和提交时用同一套 schema 和版本校验。整批按版本比对后写入（CAS），版本对不上就失败，不自动重排。

#### 模型不用填、也不能填的东西

叙事来源、逻辑回合号、读取的版本集合、每条更新的 `expectedVersion`，都由工具从权威的叙事来源、回执和冻结快照里取得。模型不能自己指定。

理由：版本就是本次执行读到的那个。让模型照抄一遍，只会多出“漏写”和“抄了历史回合的旧版本号”两种失败。

#### 自动整理的写法

校验之前，工具先整理几种意思明确的写法，不为此让模型重交：

| 模型的写法                                                 | 处理                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| 路径用 `/` 分隔（`call-0614/status`）                      | 当作分隔符。当前值里已经有包含这个斜杠的键时除外。                |
| `reason` 写在单条 change 上，或写在和 `updates` 并列的位置 | 去掉。                                                            |
| 写了 `expectedVersion`                                     | 去掉（见上）。                                                    |
| 条目自带空的 `updates: []`                                 | 去掉。                                                            |
| 同一个维度有多条 `changes` 条目                            | 合并为一条，`reason` 依次拼接。                                   |
| 只有一条 change，并且 `path` 是空字符串                    | 它就是完整值，按 `value` 处理。模型对数值或文本型的维度会这样写。 |
| 条目既没有 `value`，`changes` 也为空或缺失                 | 表示这个维度没有变化，直接略去。                                  |

仍然会被拒绝的：

- 同一个维度有一条给出了完整 `value`，又出现别的条目：按重复 ID 拒绝。
- `id` 不是维度，而是某个维度当前值里的条目名（把地图里的一个房间当成了维度）：报错会写明它属于哪个维度、路径该怎么写。

#### `followsClock`

`followsClock` 列出规则取决于世界时间或“经过了多久”的维度：倒计时、期限、按小时计的消耗。由模型根据规则文本判断。漏写时按 `[]` 处理；不是维度的 ID 被忽略。

什么时候检查：runtime 绑定了本轮结算后的世界时钟（输入 `worldTime`，见 [World time](./world-time.md#runtime-and-state)），**并且**时钟在本轮走动了。这时 `followsClock` 里的每个维度都要在 `updates` 里有一条：

- 给出新值；或
- 规则算出的值和现值相同时，只写 `{id, reason}`。

缺少时整次调用被拒绝。错误信息写明现在的时间、本轮和开局以来经过的时间，以及缺的是哪些维度，模型据此重交。

没有绑定时钟，或时钟本轮没动时，不做这项检查。

#### 由时钟推导的字段

schema 里带 `x-derive` 的字段由 `world-init/dimension-clock` 按时钟计算（见[由时钟推导的字段](./dynamic-dimensions.md#由时钟推导的字段)）。它们不在给模型的 schema 和冻结值里，也不属于 `followsClock`。

完整的 `value` 可以不带这些字段。模型写了它们（在 `value` 或 `changes` 里）时，工具不退回重交，写入的仍是当前值。

#### 没有变化也要调用

本轮没有变化，也必须调用 `update-dimensions({updates:[]})`。“无变化”的回执同样验证读取的版本。

> [!IMPORTANT]
> 工具成功缓冲了 proposal，或 runtime 正常结束，都不等于结算成功。维护失败、没有运行或版本冲突时，状态保持 `pending-settlement`。

玩家编辑和人工处理走[手动 runtime 的 RPC](./api.md#维度编辑与待结算恢复)，不用这个给模型的工具去填来源。

### submit-world-facts

**所属**: world-ir (`plugins/world-ir/tools/submit-world-facts.js`)

模型用工具参数提交本回合的完整事实，即一份 `contract:world-ir@1`。完整的数据形状见 [world-data.md · WorldIR 与插件投影](./world-data.md#worldir-与插件投影)。

| 参数                                               | 必需 | 描述                                                              |
| -------------------------------------------------- | ---- | ----------------------------------------------------------------- |
| `schemaVersion`                                    | ✓    | 固定为 `1`                                                        |
| `summary`                                          | ✓    | 本轮事实摘要                                                      |
| `entities` / `relations` / `events` / `statements` | ✓    | 四类事实数组；无内容时传空数组，插件扩展字段放入各项 `attributes` |

参数 schema 直接复用 `worldIRV1Schema`，并在 Zod 的 `superRefine` 里执行 `validateWorldIRV1` 语义校验。所以全局 ID 重复、实体引用缺失、深度或节点数超预算这些错误，都报在具体的参数路径上，模型只需要修正对应的字段。

工具返回补全并校验后的参数，不产生持久化 proposal。`world-ir` 声明了 `completeAfterTools: [submit-world-facts]`：框架把成功的结果直接作为 runtime 的类型化输出，再用 `contract:world-ir@1` 的输出 schema 检查一次。

#### 自动修正的机械性失误

校验之前，工具先修正下面这些，不为此让模型重交：

- 丢掉误抄进参数的抽取输入（`narrative` / `characters` / `vocabulary`）。
- 写在事实顶层的额外细节，移进该项的 `attributes`。
- 没写 `id` 的关系、事件和陈述，补一个（例如 `event-3fa9c1d2`，取自该条事实内容的哈希）。输出里没有任何地方引用这些 id；但按 id 跨回合保存事实的消费方不能看到两条不同的事实共用一个 id。
- 实体没有 `id` 仍然报错，因为其他事实要靠它引用。

#### 角色用短名代替真实 id

输出的 token 数决定这一步要花多久。所以抽取输入里的会话角色不给真实 id（UUID，或带会话前缀的长串），而是给由姓名生成的单词短名，例如 `tomas-reed`。同名角色按 id 顺序加 `-2`。

- 工具返回之前，把短名还原成真实 id，包括 `inventory_change` 的 `holder`。
- 提示词要求模型直接引用这些角色，不要在 `entities` 里重复登记。关系、事件参与者和陈述主体引用到的已知角色，由工具按会话角色名册补登记（`type: character` 和 `name`）。
- 短名写得有出入也认：引用不是本次输出里任何实体的 id，而它的字母和数字和唯一一个角色的短名相同时，按该角色处理。例如 `雷恩-修女` 对 `雷恩修女`，或直接写了姓名 `Sister Wren` 对 `sister-wren`。两个角色字母相同时不猜。

#### 另外三种引用

| 引用处写的是                                                                   | 处理                                                                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 本次输出里某个实体的名称而不是 id，并且只有一个实体叫这个名称                  | 改成该实体的 id。                                                                             |
| `world-ir.vocabulary@1` 词表里的名称（会话已经在追踪的物品或任务），但没有登记 | 按词表给出的类型补登记：`{ id: 名称, type: 词表类型, name: 名称 }`。                          |
| 陈述的 `subjectIds` 里写了本次输出中某条事件、陈述或关系的 id                  | 去掉这个 id。模型用它表示“这条陈述说的是那件事”，但主体只能是实体，那件事本身已经在输出里了。 |

引用其他没有登记的 id 仍然报错。

#### 两类有固定字段的事件

这两类事件的字段由工具一并校验。其余事件的 `attributes` 保持自由。`inventory` 和 `core-quest` 的函数 runtime 只读这些字段，不再调用模型。

| `event.type`       | 必需 `attributes`                                                                                                    | 可选 `attributes`                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `inventory_change` | `item`（本输出中 `type: item` 的实体 id）、`holder`（角色 id）、`operation`（`gain` / `lose` / `equip` / `unequip`） | `quantity`（正整数）                                                   |
| `quest_change`     | `quest`（任务名）、`status`（`accepted` / `progressed` / `completed` / `failed`）                                    | `objectives`、`completedObjectives`（目标原文数组）、`giver`、`reward` |

> [!NOTE]
> 这里的 `events` 是 WorldIR 的**事实数组**，不是领域事件。只有形如 `{ topic, data? }`、并且 `topic` 是字符串的条目才会被转成 `event.emit`。普通的 WorldIR event 不会触发 `event.emit: topic must be a non-empty string` 这个错误。

### sync-codex-entries

**所属**: codex (`plugins/codex/tools/sync-codex-entries.js`)

一次提交本轮全部的图鉴变化。模型不用处理条目 id，也不用在“新建”和“更新”两个调用之间选：工具按标题自己判断。猜错 id 不会让调用失败。

| 参数      | 类型         | 必需 | 描述                 |
| --------- | ------------ | ---- | -------------------- |
| `entries` | CodexEntry[] | ✓    | 1-8 条，按重要性排序 |

**CodexEntry**:

| 字段      | 类型     | 必需 | 描述                                                                     |
| --------- | -------- | ---- | ------------------------------------------------------------------------ |
| category  | enum     | ✓    | `monster` / `item` / `location` / `lore` / `character` / `skill`         |
| title     | string   | ✓    | 条目标题；与已有标题相同即补充该条目                                     |
| content   | string   | ✓    | 新条目写 2-3 句；补充已有条目只写新信息                                  |
| tags      | string[] |      | 至多 5 个                                                                |
| rarity    | enum     |      | `common`(新条目默认) / `uncommon` / `rare` / `legendary`；补充时只升不降 |
| imageHint | string   |      | 视觉描述提示                                                             |

每条记录按标题匹配已有条目。比较时去掉首尾空白，不区分大小写。

| 情况               | 处理                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| 标题匹配到已有条目 | `content` 追加到原内容之后，标签合并，稀有度只升不降，类别保留原值。 |
| 没匹配到           | 新建条目。                                                           |

- 一轮最多新建 3 条。超出的新标题被跳过，列在 `skipped` 里。
- 同一个标题在一批里出现多次时，依次追加。
- 新条目的 key 就是标题本身（`codex-west-herb-garden`、`codex-西侧旧药园`），不含随机串。这个 key 已被别的条目占用时，加 `-2` 等后缀。
- 全部写入合成一条 `plugin.data.batch` proposal。

输出为 `{ created, updated, skipped, ui }`，`created` / `updated` 是写入的 key。

没有值得记录的新事实时，模型调用 `runtime-done`。`codex` 把这个工具列进了 `completeAfterTools`，成功后立即结束。

### 图像 prompt 提交工具

两个图像插件各注册一对工具。模型调用其中一个，runtime 随即结束。

| 插件                | `promptMode=text`                 | `promptMode=image-json`                 | 固定事件 topic                    |
| ------------------- | --------------------------------- | --------------------------------------- | --------------------------------- |
| dashscope-image-gen | `submit-dashscope-text-prompt`    | `submit-dashscope-structured-prompt`    | `image.generate.requested`        |
| openai-image-gen    | `submit-openai-image-text-prompt` | `submit-openai-image-structured-prompt` | `openai-image.generate.requested` |

参数：

- 文本工具接收非空的 `prompt: string`。
- 结构化工具接收至少有一个字段的 `prompt: Record<string, unknown>`，由工具负责序列化。
- 两者都要求 `composition: "single-scene" | "comic-strip"`。

工具做两件事：把规范化后的 `{ prompt, promptMode, composition }` 写进 `plugin_data[prompts]`，并通过 `withEmittedEvents` 发出插件自己的固定 topic。

模型不用自己写 `{ topic, data }` 事件信封，所以不会漏写 topic 或写成空的。runtime 的输出 schema 只校验工具产生的可信结果。

两个 prompt-generator 都是手动触发的 agent，声明了 `schedule.manual.execution: background`。它们的 `agent.loop.completion.afterTools` 列出了对应的工具，所以一次成功提交后就结束。之后的 image-generator 在后台继续执行。

## 短 ID（LLM 友好实体引用）

模型会在注入的数据里读到这些 ID，有时还要原样写回。每个字符都占 token，长的随机串还容易抄错。所以 ID 尽量由单词组成，并保持在 `[a-z0-9-]` 字符集内。蓝图、规则和可移植世界数据的 ID 校验都要求这个字符集。

两种生成方式，都来自 `@covel/plugin-handlers-utils`：

| 函数                           | 什么时候用                          | 结果                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wordId(prefix, label, taken)` | 调用方看得到命名空间里全部已有的 ID | 前缀加标签单词（`npc-lin-yao`），已占用时加 `-2`、`-3`。标签里没有 ASCII 字母或数字（中文、emoji）时，用标签的 8 位十六进制摘要（`char-3fa9c1d2`）：同一个标签在每个会话里得到同一个 ID，已占用时同样加 `-2`、`-3`。 |
| `shortId()` / `shortIdBatch()` | 不读取命名空间                      | 标签单词（最多 32 个字符）加 8 位十六进制随机串。重复的标签和截断后相同的 slug 也不会相撞，不依赖进程里的计数器。                                                                                                    |

`codex`、`npc-graph` 的节点和玩家角色用的是 `wordId`。

`shortId` 的第四个参数传上下文的 `random`，随机串就取自宿主的随机源（见 [`ctx.random`](./plugins.md#输入和输出)）。

```js
export default function ({ tool, z, shortId, shortIdBatch }) {
  return tool({
    name: "my-tool",
    parameters: z.object({ name: z.string() }),
    execute: async (params, context) => {
      const id = shortId(
        "item",
        params.name,
        context.sessionId,
        context.random,
      );
      // Dragon Sword -> item-dragon-sword-<8 hex characters>
      // 龙息术 -> item-<8 hex characters>
      return { id };
    },
  });
}
```

`shortId` 的规则：

- 唯一性不依赖 `sessionId` 参数，也不依赖进程内存。
- 同一个名称反复调用、跨批次调用、重启后调用，每次都分配新的 ID。按名称去重要由调用方自己查已有的实体。更新必须用保存下来的 ID，不能按名称重新算。
- `shortIdBatch(prefix, labels, sessionId, random?)` 给每一项独立分配 ID。英文标点清理、slug 截断和重复标签都不会让两项共用一个编号。
- 已经存在的 ID（包括 `npc-1` 这种计数型编号）继续有效，不迁移，不重新编号。
- 新建写入时仍应检查目标 key 是否已被占用。`npc-graph` 会在持久化之前拒绝冲突，包括和当前执行里还没提交的节点冲突。

## ToolExecutor

所有工具调用都经过 `ToolExecutor`。它用注入的 `findTool(name, context)` 找到工具模块，然后直接调用 `module.execute(args, ctx)`。内置工具和插件工具走同一条路径。审批、trace 和结果的包装由 `ToolExecutor` 统一处理。

这一节主要给嵌入内核的宿主开发者看。插件作者只需要知道“授权”和“取消”两段。

### 授权

工具白名单管两件事：模型看得到哪些工具，以及实际能执行哪些工具。

- agent 循环把当前 runtime 的精确授权集合放在 `ToolCallContext.authorizedToolNames` 里传给执行器。集合包括 `tools.*` 声明的全部名字，以及非 schema runtime 的 `runtime-done`。
- `defer` 名单里的工具也在授权集合里：延迟只影响模型一开始看不看得到，不影响授权。
- 执行器在解析工具和审批**之前**，先检查最终的工具名是否在授权集合里。“最终”指会话覆盖和 `PreToolUse` 替换之后的名字。不在集合里时返回结构化错误 `UNAUTHORIZED`。
- `search-tools` 在循环内被拦下，到不了执行器。
- `findTool` 对没有上下文的调用一律从严：没有上下文只能找到 builtin 工具，插件工具全部拒绝。

**故事 runtime 是个例外。** 故事 runtime（`io.visibility: story`）以正文结束。它的工具列表里没有 `runtime-done`，`[COMPLETION]` 段也不提它。但授权仍然保留：模型出于习惯调用了它时，循环用剩下的步数追问正文，而不是返回 `UNAUTHORIZED`。不把 `runtime-done` 列给故事 runtime 的原因：按字面执行指令的模型会只调用它，不写正文。

### 取消

- 执行器把调用方的取消和宿主的关闭合并到 `context.signal`。
- 取消会撤销这次调用的读取能力，并以 `CANCELLED` 结束对工具回调的等待。迟到的返回值、proposal 和事件不会被接受。
- 取消不能强行终止同一个进程里的 JavaScript。执行器会继续跟踪还没完成的回调和读取，包括内置工具占用的宿主能力。
- 正常完成时，执行器也会等工具已经发起、但自己没有等待的读取结束。

### 关闭

`createToolExecutor` 返回 `ManagedToolExecutor`。它的 `close()` 可以重复调用，做三件事：停止接收新调用、取消已有的调用、等自己负责的工作全部结束。

嵌入宿主必须先等它完成，再关闭 Store、插件注册和事件基础设施。服务端通过 `bootstrapApi().closeTools()` 把它接进统一的关闭流程。如果等待超过了宿主的关闭预算，依赖会保留到进程退出，不会在回调还在运行时提前关闭。

### 装配

宿主用 `@covel/tools` 的 `createDefaultToolRegistry({ store, eventDirectory })` 一次装好全部内置工具：UI、suspend、runtime-done、plugin-data、emit-event 和 character。

- 服务端传入真实的事件目录，并按会话覆盖角色写入工具。
- `test-runtime` 传入一个不允许任何 topic 的隔离目录。
- 两者共用同一个注册集合和默认规则。调试宿主并不因此拥有全部生产服务。

插件作者在 `entry` 里用 `covel.toolkit.tool()`。常用的上下文、结果协议和辅助函数由公开的 `@covel/plugin-handlers-utils` 提供。注册表和内置工具的构造器属于宿主 API。

## 审批策略

宿主先解析工具，再由 `ApprovalPipeline` 检查静态规则。默认规则由 `@covel/approval` 的 `createDefaultToolApprovalPipeline()` 构造，服务端和 `test-runtime` 共用：

| 来源分类    | 规则      | 说明                                                     |
| ----------- | --------- | -------------------------------------------------------- |
| `builtin:*` | **allow** | 已注册的框架工具                                         |
| `local:*`   | **allow** | 已注册且当前会话可调用的插件工具，包括获准的社区插件工具 |

宿主可以提供自定义规则，按声明顺序取第一个匹配项；精确工具名规则不区分来源。要拒绝某个工具，把它的 `deny` 规则放在来源通配规则之前。没有匹配项时默认放行。

### 来源分类逻辑

执行器成功解析工具后，`ToolRegistry.source()` 按注册位置分类：

- `registerBuiltin()` 注册的框架工具 → `builtin`
- 插件 `entry` 通过 `registerTool()` 注册成功的工具 → `local`

只有这两种来源。找不到的工具或其他插件的私有工具，在来源检查之前就返回 `NOT_FOUND`。来源分类不代表插件信任等级；社区代码是否获准执行，由下面的授权流程决定。

### 第三方插件 server-code / plugin tool 审批边界

社区插件指装在 `~/.covel/plugins/` 等用户目录里的插件。`getPluginTrustInfo` 把它们标为 `community`。服务启动时**不执行这些插件的 `entry`**（`apps/server/src/routes/api/bootstrap/plugin-entry.ts` 里的 `if (!trust.autoLoad) continue;`；工具访问表由 `plugin-tool-access.ts` 构建）。它的代码要等玩家批准之后才运行。

一个社区插件经历这些阶段：

| 阶段            | 发生什么                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **discovered**  | 拖入 zip，经 `POST /api/install/plugin` 安装。安装时检查它没有冒充内置插件：不能用保留的内置 ID，`package.json` 和 `PLUGIN.md` 的名字必须一致。                                                                                                                             |
| **approved**    | 第一次需要运行它的代码时，先审批固定的 `covel:plugin-server-code`。加载并验证真实的 action 之后，再做 action 审批。server-code 和 `runtime:*` 的授权只能按会话给；普通 action 可以选“仅这一次”或“这个会话”。托管环境还要求 operator token，因为社区代码在服务端进程内执行。 |
| **import**      | 批准后，`activatePluginServerCode` 按需加载该插件的服务端代码，执行 `entry` 工厂（`ensurePluginEntry`；批准时和 RPC 派发时各触发一次）。                                                                                                                                    |
| **active**      | 运行期的工具调用按上表的审批规则放行或拒绝。                                                                                                                                                                                                                                |
| **revoked**     | `DELETE /api/sessions/:id/approvals[?pluginId=]` 或禁用插件。两者都在会话锁内更换持久化的授权代次，并清除本进程里的会话授权、一次性授权和等待中的审批。其他进程里的旧授权因为代次对不上而一起失效。社区插件的授权不会随新建会话、分支或进程重启而恢复。                     |
| **uninstalled** | `DELETE /api/plugins/:id` 删除 `~/.covel/plugins/<id>` 目录。它拒绝内置 ID，返回 `restartRequired:true`。界面上在「设置 → 安装与管理」里列出已安装的第三方插件，并提供卸载按钮。                                                                                            |

实际效果：

- 第三方插件可以通过 `/api/sessions/:id/plugin-rpc` 触发 runtime，由玩家审批。
- 审批通过后，entry 模块当场执行并完成注册。没有授权的会话触发不了社区插件的 runtime 和 Hook。
- 进程内的 ESM 本身不是沙箱。`self` 形态以本机用户为信任边界。托管形态把社区的服务端代码当作 operator 级的全局信任。真正的多租户第三方代码需要独立的 worker 或进程隔离。

工具和 guard 能拿到什么：

- 所有 entry 工厂的 toolkit 都只提供纯辅助函数，不注入 store。工具通过 `execute(params, context)` 的 `context.store` 读取当前会话和插件的状态。RPC 和函数 runtime 各用自己限定范围的 store。
- 社区插件的 agent guard 只拿到只读的 store 和纯输入。`pluginData`、logger、gateway、utils、media、assetProgress 这些会产生副作用的能力不注入，`recursiveCall` 会被拒绝。写入要放在 runtime handler 返回的 proposal 或 `pluginData[]` 里。

**工具里的文字用哪种语言。** `context.locale` 是会话的内容语言，`context.messages` 是本插件 `locales/` 里的译文。

- 工具存入的数据会被注入提示词时，或工具返回给玩家看的文字，用 `translate(context, "English text")` 写成会话语言的一份。
- 只由界面绘制的徽标用 `labelText(context, "English text")`。
- 不要手写 `{ zh, en }` 两份。注入提示词的数据会把两种语言都带给模型。

详见 [i18n](./i18n.md#2-本地化插件)。

写第三方插件时的规约：

- 优先通过函数 runtime 返回 proposal / `pluginData[]` 来写入。
- entry 工厂只注册 tool、Hook、RPC、wire。不在工厂顶层读取会话，也不产生业务副作用。
- guard 保持确定和只读。网络、媒体、递归执行和持久化放进正式的 runtime handler。

### 新增插件的工具

新插件在 `entry` 模块里用 `covel.registerTool()` 注册工具，并在 runtime 清单的 `tools.plugin` 里声明，让模型看得到。builtin 能力直接列进 `tools.builtin`。来源由启动过程自动归类，不用手动改白名单。

建议同时补三项测试：

1. 清单里的工具声明能被正确加载。
2. 工具的参数校验和返回结构稳定。
3. 工具对 `plugin_data` / lorebook / `characters` 的写入行为稳定。

## 交互协议（interaction）

工具可以在返回值里加一个 `interaction` 字段，表示“这里需要玩家操作”。之后的事由框架完成：汇总所有交互，交给前端，等玩家回应，再把回应写成一句自然语言，作为下一轮的玩家消息。

### 协议流程

```
工具 execute() 返回 { ..., interaction: InteractionPayload }
  ↓ turn-executor 扫描所有 tool result 的 interaction（通用，无硬编码工具名）
  ↓ 聚合为数组存入 TurnMessage.pendingInput
  ↓ 返回 TurnResult.pendingInputs（支持多插件、多交互）
  ↓ 前端渲染所有交互 UI
  ↓ 玩家提交 POST /api/actions submit_interaction { turnId, submissions: [...] }
  ↓ 每个 submission 用 narrativeTemplate 翻译为自然语言
  ↓ 同一个请求保存回答并运行后续回合，叙事文本是该回合的玩家消息
    （纯文本，LLM 看到的和普通消息一样）
```

### 交互类型

| 类型           | 用途      | 模板占位符                                             |
| -------------- | --------- | ------------------------------------------------------ |
| `form`         | 表单填写  | `{{fieldName}}` — 玩家填写的字段值                     |
| `choice`       | 选项选择  | `{{selectedId}}`, `{{selectedLabel}}` — 玩家选择的选项 |
| `confirmation` | 确认/取消 | `{{confirmed}}` — "确认" 或 "取消"                     |

### 返回值示例

```typescript
// 表单交互
execute: async (params) => ({
  created: true,
  interaction: {
    type: "form",
    interactionId: params.formId,
    title: params.title,
    fields: params.fields,
    submitLabel: params.submitLabel,
    narrativeTemplate:
      "你的名字叫 {{characterName}}，拥有 {{spiritRoot}} 灵根。",
  },
});

// 选项交互
execute: async (params) => ({
  created: true,
  interaction: {
    type: "choice",
    interactionId: params.choiceId,
    prompt: params.prompt,
    choices: params.choices,
    narrativeTemplate: "你思考片刻后决定：{{selectedLabel}}。",
  },
});
```

**`narrativeTemplate` 由插件作者写。** 它决定交互的结果变成怎样一句叙事文本。框架只负责替换占位符。

提交之后，**只有填好的叙事文本会作为玩家消息追加到对话历史**。框架不会另外生成一条 assistant 角色的消息。

**句号不重复。** 占位符后面紧跟 `.` 或 `。`，而填入的值本身已经以同一个字符结尾时，渲染出的叙事文本不再重复这个句号。保存下来的表单值不变，值内部的标点（包括省略号）也不变。

### 提交 API

```
POST /api/actions

{
  "requestId": "...",
  "type": "submit_interaction",
  "sessionId": "...",
  "payload": {
    "turnId": "...",
    "submissions": [
      { "interactionId": "form-1", "type": "form", "values": { "name": "林清风" } },
      { "interactionId": "choice-1", "type": "choice", "values": { "selectedId": "a", "selectedLabel": "跟随黑袍人" } }
    ]
  }
}
```

响应是 SSE 流：先是 `interaction.submitted`，随后是后续回合的事件。请求、拒绝和恢复见 [api.md § 玩家交互](./api.md#玩家交互)。

## 创建新工具

### 方式一：工厂函数（推荐）

插件工具写成一个工厂函数。工厂的参数就是 `covel.toolkit`，框架往里放了 `tool`、`z`、`shortId`、`shortIdBatch`、`withPendingProposals`：

```javascript
// tools/my-tool.js
export default function ({ tool, z, shortId }) {
  return tool({
    name: "my-tool-name",
    description: "工具描述（会注入 LLM system prompt）",
    parameters: z.object({
      param1: z.string().describe("参数描述"),
    }),
    execute: async (params, context) => {
      // context: { sessionId, turnId, pluginId, runtimeId }
      const id = shortId("item", params.param1, context.sessionId);
      return { id, result: params.param1 };
    },
  });
}
```

**注入对象**:

| 字段                   | 类型     | 描述                                                               |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| `tool`                 | function | `tool()` 包装函数，定义工具参数和执行逻辑                          |
| `z`                    | object   | Zod schema 库，用于参数验证                                        |
| `shortId`              | function | `shortId(prefix, label, sessionId, random?)` — 生成单个短语义 ID   |
| `shortIdBatch`         | function | `shortIdBatch(prefix, labels, sessionId, random?)` — 批量生成短 ID |
| `withPendingProposals` | function | 把工具返回值和待提交 proposal 绑定，交给 commit chain 统一落盘     |

#### 执行时读数据：`context.store`

生产宿主和 `test-runtime` 在每次工具调用时注入 `context.store`。它的接口和 `FunctionStoreView` 相同：

| 方法                                                             | 读到什么                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `getPluginData(namespace, key)` / `listPluginData(namespace)`    | 当前会话、当前插件的数据。按顺序合并了同一次执行里已有的 set、batch 和 delete 提案。              |
| `getSession()`、`listPlayerInputs()`、`listTurnMessages(limit?)` | 只读当前会话。给了 limit 时读最近的消息。消息只含已提交的回合；正在执行的回合要到提交之后才出现。 |

规则：

- 读到的值、输入、已有的提案和事件主题都是独立的副本。改它们不会改数据库，也不会改调用方的缓冲。工具返回的内容、提案和事件在被异步记录之前也会被复制。
- 读取句柄在工具返回、抛错或调用被取消之后失效。取消期间已经开始的读取，不会再把结果交给工具。
- 工具应该等自己的读取完成再返回。宿主也会等已经发起的读取结束，才算这次工具调用完成。
- 没有配置 DataStore 的独立无状态执行器不提供 `context.store`。直接调用 `tool.execute()` 的宿主或单元测试要自己提供上下文。插件测试可以用 `bindToolStore`（`@covel/plugin-test-utils`）。

**写入**仍然通过返回 `withPendingProposals(...)`。不能在工具执行中直接提交领域状态。

**组合工具要注意。** 一个工具在内部直接调用另一个工具时，子工具新产生的提案还没有进入执行器的读取快照。这类子调用要自己用 `overlayPluginDataValue` 等纯辅助函数合并这些局部提案。codex 的同步工具是例子。除此之外，不要再手动合并执行器已经合并过的提案。

#### 取消

`context.signal` 传递调用方的取消信号。向外部发请求时要用它。取消之后才到的结果不会被当作成功的提案返回。框架不能强行终止同进程的 JavaScript，也撤不回已经发出去的外部副作用。

### TypeScript 入口

```typescript
import type { PluginEntryFactory } from "@covel/plugin-handlers-utils";

const register: PluginEntryFactory = (covel) => {
  covel.registerTool(
    covel.toolkit.tool({
      name: "my-tool-name",
      description: "工具描述",
      parameters: covel.toolkit.z.object({ param1: covel.toolkit.z.string() }),
      execute: async ({ param1 }) => ({ result: param1 }),
    }),
  );
};
export default register;
```

- 给模型看的参数说明来自 Zod 的输入 schema。
- 执行时仍做完整解析，`execute` 收到的是 transform 之后的值。
- 参数不能转换成 JSON Schema 时，构造工具时就抛错，错误里带工具名。它不会退化成一个没有参数说明的 schema。

### 结果与写入

纯计算的工具可以直接返回正文。要写入数据时，用 `withPendingProposals(content, proposals)`。它始终返回下面这个公开形状，不修改正文；写入列表为空、或对象被冻结时也一样：

```typescript
interface PluginToolResult<T> {
  readonly kind: "covel.tool-result";
  readonly content: T;
  readonly pendingProposals: readonly PluginProposal[];
  readonly emittedEvents?: readonly {
    topic: string;
    data: Record<string, unknown>;
  }[];
}
```

读取这个结果要用公开 SDK 的函数，不要直接读属性：

| 函数                          | 读什么       |
| ----------------------------- | ------------ |
| `getToolContent(result)`      | 业务正文     |
| `getPendingProposals(result)` | 待提交的写入 |
| `getEmittedEvents(result)`    | 发出的事件   |

例如测试里写 `getToolContent(result).someField`，不要写 `result.someField`。调用辅助函数之后，必须使用它返回的对象。

`withPendingProposals()` 和 `withEmittedEvents()` 可以按任意顺序组合：

- 支持普通对象、冻结对象和标量内容。
- 组合后保留同一份 `content` 和两个副作用通道。再次设置同一个通道会替换它。
- 组合后的结果可以用对象展开、`structuredClone` 或 JSON 复制，副作用不会丢。

`kind` 本身不授予写权限。宿主仍然检查来源、权限和数据 schema。

### 注册与声明

需要玩家交互时，在返回值里加 `interaction`（见上面的[交互协议](#交互协议interaction)）。

工具分两步接入：**在 `entry` 模块里注册**，再**在使用它的 runtime 清单里声明**。

```js
// server/index.js —— 由根 PLUGIN.md 的 `entry: ./server/index.js` 指向
import makeMyTool from "../tools/my-tool.js";

export default function (covel) {
  covel.registerTool(makeMyTool(covel.toolkit));
}
```

```yaml
# RUNTIME.md；根 PLUGIN.md 同时声明 contributes.tools: [my-tool-name]
type: agent
agent:
  tools:
    plugin: [my-tool-name]
```

> [!IMPORTANT]
> `tools.plugin` 是这个 runtime 的工具白名单。执行还要求本插件注册成功。声明了一个没注册的名字时，这个名字解析失败，不会落到其他插件的同名实现上。

## Proposal 类型

工具和 runtime 不直接改存储。它们产出 **proposal**：一条“请求写入”的记录。runtime 的输出最终都被规范化成 `Proposal[]`（定义见 `packages/shared/src/types/proposal.ts`）。提交流程按顺序提交它们，写入存储，再以 SessionEvent 的形式广播。

当前已注册的类型：

- `narrative.append`
- `state.patch`
- `event.emit`
- `interaction.request`
- `ui.render`
- `asset.generate`
- `plugin.data`、`plugin.data.batch`、`plugin.data.delete`
- `character.upsert`、`character.schema.set`
- `dimension.initialize`、`dimension.update`
- `lorebook.upsert`

类型只在一处定义：`ProposalPayloadMap`。`ProposalType`、提交处理器的注册表（`satisfies CommitHandlerMap`）和对外公布的列表（`PROPOSAL_TYPES`）都在编译期和它对齐。新增一种 proposal 只改 `ProposalPayloadMap` 一处；漏注册处理器时编译失败。

**`state.patch` 和 `plugin.data` 的区别。** `state.patch` 写入的状态表是全会话共享的：

- 提交时只要求 `table` 和 `field` 是非空字符串。
- 不按插件划分归属，也不按表的 schema 校验值。
- 每次变更在变更记录里带上来源 `pluginId/runtimeId`。

只属于一个插件的数据放在 `plugin.data`。它按 `(sessionId, pluginId, namespace, key)` 隔离。

### `ui.render`

往聊天消息里写入一个通用的 UI 块，并发出 `ui.rendered` 事件。payload 使用 parts 模型：

```typescript
interface UIRenderInstruction {
  parts: readonly UIRenderPart[];
  layout?: "stream" | "split" | "overlay";
  status?: UIPartStatus;
}
```

提交的 trace 会记录 `ui.rendered`，并为每个 part 记录一条 `ui.part.update`。`status` 是界面的展示状态，和 runtime 的 `success` / `failed` 执行状态无关。

### `character.upsert`

写入或更新一条会话级的角色记录。提交时持久化到 `characters` 表，并发出 `character.upserted` SessionEvent。

HTTP `POST /api/sessions/:id/characters` 内部也通过这条 proposal 提交。

**Payload (`CharacterUpsertPayload`):**

| 字段            | 类型    | 必需 | 描述                                                                                                  |
| --------------- | ------- | ---- | ----------------------------------------------------------------------------------------------------- |
| id              | string  | ✓    | 角色 ID                                                                                               |
| name            | string  | ✓    | 角色名称                                                                                              |
| type            | string  |      | 角色类型，默认 `npc`                                                                                  |
| description     | string  |      | 角色描述                                                                                              |
| fields          | unknown |      | 角色属性                                                                                              |
| version         | number  |      | 版本号，默认 `1`                                                                                      |
| expectedVersion | number  |      | 更新 proposal 读取到的版本；提交时把 `fields` 作为 shallow patch 合并到最新角色并从 live version 递增 |
| createdAt       | string  |      | 创建时间，缺省为提交时间                                                                              |

`update-character` 自动填写 `expectedVersion`。

**并行更新不会互相丢字段。** 同一个阶段里并行的两个 runtime 即使都从 v1 开始，提交时也会按顺序重新读取最新的角色，再合并各自的 fields patch。后提交的不会弄丢先提交的新字段。两者改了同一个字段时，后提交的 patch 覆盖前一个。

### `character.schema.set`

整体更新会话的角色 schema。payload 是 `{types: string[], attributes: AttributeDef[]}`，不接受 `version`：内核从当前记录递增版本，并保存时间戳。

写入必须和会话里已有的角色兼容。出现未知的角色类型、不符合属性约束的角色，或多个 player，提交都失败。

执行过程中的 `ctx.world.characterSchema` 和 `ctx.world.characters` 用和提交相同的规则，校验成功的上游 proposal 和自己待提交的 proposal。

提交成功后发出 `character-schema.changed {schema}`，客户端据此刷新角色字段的定义。

### `lorebook.upsert`

payload 是 `{entries:[{id,keys,content,strategy,position?,insertionOrder?,enabled?,extra?}]}`。`strategy` 为 `constant` 或 `selective`。

**词条归谁。** 属主由提案的来源固定为 `{kind:"plugin",pluginId}`。插件不能声明自己是 world 或 player 属主，也不能覆盖其他插件的词条。

**词条的身份**是 `(sessionId, owner, id)`：

- 世界导入写 world 属主，玩家管理 API 写 player 属主。
- 相同的 id 在不同属主下是各自独立的词条。
- 更新自己的词条时保留 `createdAt`。

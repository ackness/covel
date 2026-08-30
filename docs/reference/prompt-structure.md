# Prompt 结构参考

Covel 用单一路径组装 runtime context：`buildContext()` / `buildContextAsync()` 都委托给 `packages/context/src/prompt-assembler.ts` 的 segment-based assembler。没有版本切换开关，也没有第二条组装路径。

## 1. 构建入口

| 入口                            | 用途                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `buildContext(params)`          | 同步组装普通 runtime context。                                              |
| `buildContextAsync(params)`     | 语义相同，额外解析 `input.inject[].kind === "plugin-data"`，需要 store IO。 |
| `needsAsyncBuild({ manifest })` | 由调用方判断是否需要 async 路径。                                           |

`ContextBuildParams` 中的 `estimator + contextBudget` 决定是否执行 history pruning。没有这两个参数时，assembler 只做组装，不做 token 预算裁剪。

## 2. 段位图

```text
system prompt（编号是段的身份，下面是实际渲染顺序）
  [1] Framework Preamble
  [3] Plugin Instructions
  [4] WorldInfo: before-plugin
  [5] Injects from upstream
  [6] WorldInfo: after-plugin
  [2] Core Memory + Working Memory   ← 每回合都变，排在全部稳定块之后

messages
  [7] Message history after summary substitution and pruning
  [8] WorldInfo / persona at-depth contributions
  [9] Author's Note
  [10] Post-History Instructions
```

| #   | 名称                         | 来源                                                                                                                                                                                | 输出位置        |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | Framework Preamble           | locale、运行框架约束                                                                                                                                                                | `systemPrompt`  |
| 2   | Core Memory + Working Memory | session context snapshot                                                                                                                                                            | `systemPrompt`  |
| 3   | Plugin Instructions          | `PLUGIN.md` 正文 + persona contributions                                                                                                                                            | `systemPrompt`  |
| 4   | WorldInfo before-plugin      | session context contributions                                                                                                                                                       | `systemPrompt`  |
| 5   | Upstream Injects             | `manifest.input.inject`；`manifest.advertiseEvents: true` 时追加 `<available-events>` 事件目录（opt-in，见 [plugins.md](./plugins.md#events-声明与-advertiseevents统一事件发射层)） | `systemPrompt`  |
| 6   | WorldInfo after-plugin       | session context contributions                                                                                                                                                       | `systemPrompt`  |
| 7   | Message history              | store 中的 turn messages + compactor summaries                                                                                                                                      | `messages`      |
| 8   | At-depth contributions       | session context contributions                                                                                                                                                       | `messages`      |
| 9   | Author's Note                | 当前执行 runtime 的 `authorsNote`                                                                                                                                                   | `messages`      |
| 10  | Post-History Instructions    | 当前执行 runtime 的 `postHistory`                                                                                                                                                   | `messages` 末尾 |

空段会被跳过，非空 system 段用 `\n\n` 拼接成 `AssembledContext.systemPrompt`。运行时仍消费一个 `systemPrompt: string` 与一个 `messages` 数组。

**段 2 按编号排在前面，但渲染在最后**——它是唯一每回合都变的 system 段。夹在段 1 与段 3 之间时，它会让下游的一切每回合失效：段 3 通常是整个 prompt 里最大的块，仅仅因为它前面几行记忆变了就要重新计费。两种缓存模型都吃这个亏——显式 `cache_control` 段必须整段字节不变才可复用，自动前缀缓存则在第一个不同的字节处就断掉。放到最后还有一个附带好处：本回合最新的状态离对话最近，模型对它的权重最高。

段 7 里替换被压缩历史的 compactor summary 以 **`user` 角色的 `<compacted_history>` 数据信封**进入 `messages`，内容做 XML 转义。summary 是模型自己写的、会持久化、之后每回合都重新注入的文本；用 `system` 身份注入等于给一次提示注入开了一条跨回合、自我放大的通道。信封化后它只是"早先回合的故事记录"，与 core memory 的处理方式一致。

压缩阈值使用本回合第一个 agent **实际组装出的 system prompt** 估算，而不是空占位。压缩成功后，同一个 runtime 会重载 uncompacted messages 与 session summaries 并重建 context，因此新摘要从当前 provider 调用起就可见。一次 turn 只执行一次该压缩屏障，避免并行 runtime 重复摘要。多轮压缩采用单块滚动摘要：每次把旧摘要与新前缀合并，原子替换旧摘要并重标记全部已压缩消息。摘要预算为 context window 的 4%，下限 128、上限 1024 estimated tokens；即使 provider 忽略输出上限，持久化前也会截断，因此摘要数量和注入成本不会随会话时长无界增长。

预算有三道边界：初次 context assembly、`PostContextAssembly` 之后、以及 tool loop 每次 `PreLLMCall` 之后。最后一道按实际 messages、工具/响应 schema、tool result、steering 和 retry 扰动重新估算；prune marker 本身也计费。所有 `<compacted_history>` 信封和当前用户回合在历史裁剪阶段都受保护；compactor 选择待摘要历史时仍独立保护最近两个用户回合和最后五条消息。这样小窗口下由 durable summary 承接旧回合，硬裁剪不会因为重复保护原始历史而失去可满足性。当前批次的 tool message 不能删除（否则破坏 provider 的 tool-call 配对）；当读取工具的结果使下一次调用溢出时，模型回读文本会先保留首尾并加入明确截断标记，完整 parsed result 仍保留在 runtime toolCalls 与 trace 中。如果工具配对和固定 schema 仍挤占空间，单次调用可进一步首尾截取 `<compacted_history>`，但数据库中的完整滚动摘要不会修改，下一轮会恢复。完成这些裁剪后仍超限才拒绝 provider 请求。配置的 response reserve 同时作为每次请求的 `maxOutputTokens`，OpenAI-compatible wire 映射为 `max_tokens`。

## 3. 插件扩展点

插件可以在 `PLUGIN.md` frontmatter 声明 `authorsNote` 和 `postHistory`：

```yaml
---
name: narrator

authorsNote:
  content: |
    请以第三人称叙述，但在关键转折时给出角色的内心独白。
    当前导演目标: {{ story.flags.currentGoal }}
  depth: 4
  role: system

postHistory:
  content: |
    输出必须包含 <narrative> 标签和 <choices> 标签。
  role: system

summaryFocus:
  - "主角的情绪线"
  - "当前目标进度"
---
```

合并规则：

- **作用域是「当前执行的 runtime 自己」**，不聚合 session 内其他插件。`postHistory` 是 runtime 的私有工作指令（它的工具流程、终止契约），跨插件聚合会把一个插件的内部指令塞进另一个插件的 system prompt——既是插件隔离泄露，也让无关插件能操纵一个作者从未选择接受它的 runtime。`ContextBuildParams.activeManifests` 参数保留复数形态是因为 builder 本身通用，调用方若确实需要可以自行传入一组；框架的回合路径只传当前 runtime 的（locale 解析后的）manifest。
- 传入多个 manifest 时按 `(stage, name)` 排序合并（早 stage 在前，同 stage 按 `name` 定序）。
- 相同 `(role, depth)` 的 `authorsNote` 用空行合并成一条消息。
- 不同 depth 的 `authorsNote` 分别插入到对应历史位置。
- `postHistory` 按 role 分组，相同 role 合并后追加到消息末尾。

## 4. Template 变量

`PLUGIN.md` 正文、`authorsNote.content`、`postHistory.content` 支持 `{{ variable }}` 插值。变量来自 `assemblePromptVariables()`：

- `{{ player.message }}`：当前玩家输入。
- `{{ player.lastFormValues }}`：最近一次 player 表单提交，JSON 字符串。
- `{{ session.id }}` / `{{ session.turnNumber }}`。
- `{{ inputs.<pluginId>.<runtimeId>.<field> }}`：上游 runtime 输出。
- `{{ world.* }}`：由 session context snapshot 的 `world` 视图提供，例如短字段 `world.name`、`world.description`、`world.tags`，以及完整字段 `world.lore`、`world.schema`、`world.entries`、`world.dimensions`。长运行 agent 应把短字段常驻 prompt，并用 `world-dimension-get` 按需读取精确结构化事实；每轮内联完整 lore 会让小窗口 slot 在尚未加入历史前就耗尽预算。
- `{{ userSettings.* }}`：玩家配置的插件设置。

Working Memory 与 Core Memory 通过 session context snapshot 进入段 2；插件模板也可以通过已有变量读取需要暴露的字段。

启用 context budget 时，Core Memory 的合计渲染上限为可用输入额度的 15%（最少 256、最多 2048 estimated tokens）。框架对所有非空块使用公平的单块上限，保留每个块的标签和 XML 信封，并仅截断过长内容；因此世界包增加自定义 memory blocks 不会让每次调用的 system prompt 无界增长。数据库中的完整块不受影响。

**段 5 的 inject 内容不参与插值**。inject 块承载的是上游 runtime 输出或 plugin-data——也就是模型写的、玩家写的**数据**。这些数据在生成 inject 块时已经做过 XML 转义，但转义不处理 `{}`；如果再跑一遍插值，数据里出现的 `{{ ... }}` 会被展开，且展开结果原样插入、绕过转义，等于把玩家输入重新带回 system prompt。模板只在插件自己的 PLUGIN.md 正文上解释一次，inject 一律当数据处理。插件作者需要在 inject 里做条件逻辑时，应该在上游 runtime 输出成品文本，而不是输出模板。

## 5. Prompt Cache 标记

`serializeSystemPrompt(segments, true)` 默认在可缓存 system 段后插入内部 PUA sentinel (`\uE000`)：

1. 段 1：Framework Preamble
2. 段 3：Plugin Instructions
3. 段 6：WorldInfo after-plugin

Anthropic adapter 会把 sentinel 转成 `cache_control: { type: "ephemeral" }` 的 text block。OpenAI-compatible providers 不读取 sentinel，依赖 provider 的自动前缀匹配。

段 2（Core/Working Memory）**不锚定断点，并且排在最后一个 sentinel 之后**。因此 systemPrompt 不再以 sentinel 结尾，Anthropic adapter 把这段尾巴视为 open tail 而不给它 `cache_control`（见 `packages/ai-provider/src/adapters/anthropic-messages.ts` 的 `hasOpenTail`）。断点总数仍是 3，未逼近 `MAX_CACHE_BREAKPOINTS`。

## 6. `prompts/server`

`prompts/server` 是服务端外置 prompt 模板目录，当前使用路径：

- `compactor.zh.md` / `compactor.en.md`：`packages/context/src/compactor.ts` 通过 `loadPrompt("server", "compactor", locale)` 加载。
- `generate-world.md`：`packages/create/src/prompts.ts` 通过 `loadPrompt("server", "generate-world")` 加载。

Prompt 根目录由 `COVEL_PROMPTS_DIR` 覆盖；未设置时 `prompts-loader` 会从包路径向上查找仓库根目录下的 `prompts/`。

## 7. 相关实现

- `packages/context/src/context-builder.ts`：公共入口，负责保持 `buildContext` API 稳定。
- `packages/context/src/prompt-assembler.ts`：segment-based context assembler。
- `packages/context/src/prompt-internals.ts`：插值、inject、变量对象、memory 渲染。
- `packages/context/src/prompt-serialization.ts`：system 段拼接与 prompt-cache sentinel。
- `packages/context/src/budget.ts`：message history token 预算裁剪。
- `packages/context/src/compactor.ts`：长 session 摘要与 summary substitution。
- `packages/context/src/session-context.ts`：session-level context snapshot 构建。

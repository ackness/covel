# 提示词结构

这一页说明 Covel 每次调用模型时，发出去的请求是怎样拼起来的：哪些内容进 system prompt，哪些进对话消息，各自排在哪里，以及超出预算时先裁掉什么。想知道“模型到底看到了什么”、想让请求更容易命中服务商缓存，或者要写提示词扩展的插件作者，读这一页。

入口只有一个：`buildContext(params)`。它是异步的，按 runtime 的输入声明决定是否读取本插件的数据。插件正文、声明的输入、世界书和扩展段在 `packages/context/src/prompt-assembler.ts` 里组装成 `systemPrompt` 和 `messages`。记忆内容和历史摘要的策略由插件提供。

## 1. 构建入口与历史流水线

| 入口                         | 用途                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await buildContext(params)` | 组装 context；需要读取编译后 `input.inject` 中的 `plugin-data`（作者侧写作 `io.selfData`）时使用传入的 `store`。注入 `_hidden.*` 隐藏世界数据会直接报错。 |

一次执行里，历史按下面的顺序处理：

1. 读取 `turn_messages` 里还没被压缩的那一段历史，以及全部消息的统计。当前玩家输入先留在执行日志（execution journal）里，提交成功后才落库。
2. 在历史的副本上运行 `prompt.history-transform@1`。每个提供者拿到前一个提供者的结果。这一步不改库里的消息，也不改变调度用的计数。
3. 按当前 runtime 过滤：去掉其他插件的结构化历史输出，去掉没有文本的 runtime 行。然后组装实际的 system prompt，并合并已经保存的摘要。声明了 `agent.history.maxTurns` 的 runtime 只保留最近 N 个回合（按 `turnId` 计数）的可见消息，默认不合并摘要；写 `agent.history.includeSummaries: true` 可以保留摘要。
4. 把本次执行已经产出的故事正文接在当前玩家输入之后（见下面的[本回合正文](#本回合正文)）。
5. 第一个使用共享历史视图的 agent 用这份 system prompt 估算要不要压缩。同一回合里这类 agent 共用一次压缩屏障；压缩成功后重新加载历史和摘要，重新投影并组装 context。声明了历史窗口的 runtime 不触发这个屏障，也不等它。
6. 执行 `PostContextAssembly`，应用预算。之后每次 `PreLLMCall` 之后，再按实际的请求检查一次预算。

### 本回合正文

已提交的历史只到上一回合为止。本回合的消息要等执行提交之后才落库。所以框架把执行日志里还没提交的部分也放进对话：

- 当前的玩家输入。
- 更早阶段里 `outputKind: story` 的 runtime 已经成功产出的正文。

正文以 assistant 消息出现，和下一回合历史里的样子相同。后面跟一条 user 角色的框架提示，说明这段正文写于本回合、剧情停在它的结尾。

规则：

- 只取**更早 stage** 的结果。stage 之间有屏障，结果已经确定。同一个 stage 里并行的 runtime 互相看不到对方的正文，需要时用 `io.inputs` 声明依赖。没有 stage 的 runtime（回合内的 event 后继）排在所有 stage 之后。
- 只取**本次执行**产出的正文。重试时作为种子带入的来源回合结果不投影，它的正文已经在历史里了。
- `agent.history.maxTurns` 不计入本回合：写 `0` 仍然会发送当前玩家输入和本回合正文。
- 这段正文和结尾提示属于当前回合，预算裁剪时和当前玩家输入一起受保护。回合中途玩家插入的消息同样算作当前回合。runtime 暂停后恢复时，保护范围随 continuation 一起保存（`currentTurnUserMessages`），和暂停前一致。

**正文只发一次。** `io.inputs` 里某个 `cardinality: one` 的输入如果整个值就是这段正文（内置的 `narrative`、`narrator-output` 绑定都是），`<runtime-inputs>` 里它的 `value` 换成一句指向对话里那条消息的话，不再重复全文。

- `source` 照常保留。
- function runtime 的 `ctx.inputs` 和工具读到的 `ctx.inputSlots` 仍然是原值。
- 值只是包含这段正文（例如一个带 `summary` 字段的对象）时不替换。
- 提交后重试的执行没有投影的正文，输入保持原值。

**为什么要这样做。** 没有这一步时，叙事之后运行的 agent 读到的对话停在“上一回合的正文 + 本回合玩家输入”，模型会把上一回合的结尾当成当下。`<runtime-inputs>` 里虽然有本回合正文，但那是数据块里的一个字段，不是对话的一部分。同一个 runtime 在提交后被重试时，历史里已经有本回合正文；有了这一步，两种情况读到的对话一致。

### 历史压缩

`history.compact@2` 是只允许一个提供者（single）的扩展点。

- 框架负责：阈值、返回值校验，以及把摘要和消息标记一起原子地保存。
- 默认的 `history-compaction` 插件负责：选择连续的历史前缀、调用摘要模型、限制摘要长度。

默认策略：

- 保护最近两个用户回合和最后五条消息。
- 按 fast 模型能读的输入容量选择连续的前缀，为新历史生成独立的摘要。
- 旧段的原文保持稳定。只有总预算或“最多八段”的限制要求收缩时，才合并最旧的连续段。
- 实际生成的摘要长度决定是否合并。窗口小的时候，预算在“合并旧段”和“新段”之间分配。
- 单条源消息装不进 fast 模型时保留原文，不截断源消息。

| 预算     | 目标                           | 下限 | 上限                             |
| -------- | ------------------------------ | ---- | -------------------------------- |
| 单段     | 源文本 estimated tokens 的 25% | 128  | 有效窗口的 4% 与 2048 中较小的值 |
| 全部摘要 | 有效窗口的 12%                 | 128  | 8192，且不超过窗口自身           |

有效窗口取 story 和 fast 两个模型输入容量（各自扣除响应预留）中较小的那个。摘要模型的请求仍然使用 fast 自己的容量。压缩的触发窗口同样取 story 与摘要调用槽位输入窗口的较小值。

输出为 `{ summaries: [{ messageIds, replacesSummaryIds, content, focusSections, truncated? }] }`。

- 每一段只能覆盖新消息或旧摘要中的一种。
- 框架只接受同一个 session 里、连续未压缩前缀的消息 ID，以及从最旧段开始连续选择的旧摘要 ID。跳过、重排、重复和外部来源都被拒绝。
- 保留的段加上新段，必须满足总量、单段和段数的限制。
- 合并沿用最旧被替换段的 ID、起始回合和创建时间。只删除选中的旧段并重新标记对应的消息，保留的段不变。全部写入在同一个事务里提交。
- 提供者必须实现 `@2`，没有旧契约的分支。已经保存的摘要记录形状没有变。
- 摘要以 `user` 角色、经过 XML 转义的 `<compacted_history>` 数据信封进入上下文。
- 原始消息仍然留在日志里。压缩只替换它们在 prompt 里的表示。

两条保护：

- 保存一个生成的段之前，事务会把它的消息 ID 和库里“未压缩前缀”的一次有界读取对照。改写或重排了这段前缀的历史变换仍然可以影响 prompt，但不能把一段不相连的消息标记为已压缩。这种情况下本次压缩被跳过，原始历史不变。
- 摘要模型的回复以 `length` / `max_tokens` 结束时，这份回复在任何历史标记或摘要改变之前就被丢弃。一份完整的摘要因为预算被明确截短时，仍然标记为 `truncated`。

### 展示过的图片

一张图片提交时（`asset.generate`，`modality: "image"`），框架除了写玩家看到的消息，还在 `turn_messages` 里写一行说明。

- 这一行的 `sourceType` 是 `"system"`，`role` 是 `"user"`。
- 正文是一句话：这里向玩家展示了一张图片，以及画面内容。
- 画面内容取 `meta.caption`，没有时取 `meta.prompt`，折成一行，最长 600 字符。两者都没有时只写前半句。
- 说明里没有媒体 ID、会话 ID、时间或路径。
- 它按提交时间排在历史里，之后不再改写。所以每个读历史的模型都知道这里出现过图片，前缀缓存也不受影响。
- 音频等其他媒体不写这一行。

更多规则：

- **说明行不算一个回合。** `agent.history.maxTurns` 按玩家回合计数，窗口内回合之间的说明行随窗口保留。
- **图片本身不放进历史。** `outputKind: story` 的 agent 在回合上下文之后、当前玩家输入之前多一条 user 消息，列出未压缩历史里最新的 2 张图片（从旧到新，各带同一句画面内容）。每次模型调用前，框架按本次调用实际使用的模型用途判断：模型表或 `llm.toml` 的 `input` 写明接受图片时，从 MediaStore 读出字节，作为内联的 base64 图片发出；否则整条消息去掉，只留历史里的说明。判断依据是[模型能力](./slots.md)，不看模型名。
- **上限。** 每次调用最多 2 张。单张原始字节不超过 3,750,000（base64 后 5 MB，是各服务商单图上限里最紧的）。格式限 PNG、JPEG、WebP、GIF。超限、格式不符、读取失败或不属于本会话的图片不发送，说明仍在。预算估算按每张 1,500 token 计。
- **为什么放在回合区。** 这是成本上的取舍。留在历史里，图片滑出“最新 2 张”时要改写旧消息，它后面的历史缓存全部失效。放在回合区，历史前缀逐回合不变；代价是图片每次调用都按未缓存的输入计费（一张约 800–1,600 token，两张约 3,000 token），同一回合工具循环的后续请求可以命中。
- **trace。** `llm.calling` 和 `providerRequests` 不记录图片字节，只记录长度。

## 2. 段位与排序

```text
systemPrompt
  Framework Preamble
  当前 runtime 的本地化正文
  stable / session 扩展段
  WorldInfo: before-plugin
  事件目录；阶段内运行的 activation
  WorldInfo: after-plugin
  要求 pre-history 的 turn 扩展段

messages
  pre-history 非 system 扩展消息
  摘要替换后的历史
  回合上下文：本回合的数据块与 turn 扩展段（一条 system 消息）
  最近展示的图片（一条 user 消息，仅 story runtime 且模型接受图片输入）
  当前玩家输入
  本次执行已产出的故事正文与结尾提示（仅叙事之后的 runtime）
  按 depth 插入的世界书和扩展消息
  post-history 扩展消息
```

空的段跳过。system 段之间用空行连接。扩展段按 `position` 和 `volatility` 落到不同的位置：

| 段的声明                                              | 落在哪里                  |
| ----------------------------------------------------- | ------------------------- |
| `position: system`，`volatility` 为 stable 或 session | system prompt             |
| `position: pre-history`，默认的 system 角色           | system prompt             |
| `position: system`，`volatility: turn`                | [回合上下文](#回合上下文) |
| `position: pre-history`，user 或 assistant 角色       | 历史之前的消息            |
| `position: post-history`                              | messages 的末尾           |
| `position: { depth: n }`                              | 按相对消息深度插入        |

扩展段先按 `audience` 过滤，再依次按 `volatility`（stable、session、turn）、`order`、提供者的插件 ID 和段 ID 排序。

- `audience: self` 覆盖提供插件的全部 runtime。
- `audience: story` 匹配输出故事的 runtime。
- `audience: { contract: "narrative-engine@1" }` 匹配 runtime 的输出契约。

### 回合上下文

每回合都会变的内容不放在 system prompt 里。它们合成一条 system 消息，排在历史之后、当前玩家输入之前。里面有：

- 本回合的数据块：`io.selfData` 和注入块、`<runtime-inputs>`、`<runtime-exports>`，以及事件触发或手动触发的 `<runtime-activation>`（带载荷）。阶段内运行的 activation 每回合相同，留在 system prompt。
- `position: system` 且 `volatility: turn` 的扩展段，如记忆块和 `<world-dimensions>`。

**原因是服务商的前缀缓存。** 一次请求里，只有从第一个字节起和之前的请求相同的部分才能命中缓存。数据块放在 system prompt 里时，system prompt 每回合都不同，排在它后面的整段历史就无法命中，会话越长浪费越多。把它们移出去之后，system prompt 逐回合保持不变，缓存可以一直覆盖到上一回合的历史。

各服务商协议怎样发送这条消息：

- **Anthropic**：这段内容在上下文里仍然是 system 角色。Anthropic 只把开头的 system 消息放进顶层 system；历史之后的回合指令保留位置，以带 `<system-instruction>` 的 user 内容发送。
- **OpenAI Chat 和 Responses**：默认原样以 system 发送。slot 的 `lateSystemAsUser = true` 让它们也按上面的方式发送（`lateSystemMessagesAsUser`，`packages/ai-provider/src/adapters/common.ts`），用于会把 system 消息移到最前面的中转。数字和代价见[提示词缓存键](./slots.md#提示词缓存键)。`packages/ai-provider/tests/late-system-messages.test.ts` 固定了两件事：选项打开时，只有回合上下文不同的两次请求到历史末尾为止逐字节相同；默认不改角色。
- **Gemini 原生协议**（`google-generative-ai-v1`）：默认和 Anthropic 一样处理，细节见下面一节。

其他规则：

- 它不放在请求的最后。请求仍然以本回合的消息和 post-history 段结尾。原因：数据块紧挨着回复时，较小的模型会把数据块的写法带进工具参数（把参数包成输入块的形状，在字段后面补一个闭合标签）。
- depth 插入按对话消息计数，回合上下文不占位置。
- 预算裁剪把紧挨在受保护回合之前的 system 消息一起保留，所以它不会被丢掉。压缩阈值的估算把它和 system prompt 一起计入。
- `AssembledContext.turnContext` 是它的内容，没有时为空字符串。
- 标签名不变。正文里继续写 `runtime-inputs.<binding>.value`。

#### Gemini 原生协议的发送形状

- 只有开头的 system 消息进入 `systemInstruction`。它排在 `contents` 之前，每回合变化的文字放进去会让前缀缓存从头断开。
- 之后的 system 消息留在原位，作为 `contents` 里带 `<system-instruction>` 的 user 文本。`contents` 里没有 system 角色，这是保持位置的唯一办法。
- 相邻的、同角色的纯文本内容合并成一条。
- 带函数调用的 model 内容不和后面的内容合并。
- 函数响应所在的 user 内容里只有函数响应。紧跟其后的文本（玩家消息、纠正提示、夹在函数调用和函数响应之间的指令）是下一条 user 内容。所以函数响应始终紧跟函数调用，也不和文本同处一条内容。
- slot 的 `lateSystemAsUser = false` 恢复旧做法：所有 system 消息都进 `systemInstruction`，也不合并相邻内容。Google 的端点拒绝上面这种请求时使用，见[提示词缓存键](./slots.md#提示词缓存键)。

代价：这段文字在模型眼里从 system instruction 变成了 user 文本。回合规则和插件指令的权重可能略有不同，没有做过质量对比。

依据和没有验证的部分：

- AI SDK 的 Google provider 不支持这种消息。遇到对话开始后的 system 消息，它直接抛错（`system messages are only supported at the beginning of the conversation`），既不前移也不改写。所以原位发送是 Covel 自己的规则。
- “函数响应一条 user 内容、随后的文本另一条 user 内容”有两处依据。其一，这个适配器在引入原位发送之前，对“工具结果后跟玩家消息”一直这样发送。其二，AI SDK 的 Google provider（`@ai-sdk/google` 4.0.93 的 `convert-to-google-messages.ts`）对 tool 消息和其后的 user 消息也各发一条内容，不合并。AI SDK 只在一种情况下把文本和函数响应放进同一条内容（旧模型上带文件的工具结果），Covel 不发这种形状。
- 带指令的请求形状只在本机一个模拟 Gemini 接口的中转上跑通过工具循环（调用、函数响应、随后的指令）。没有在 Google 的端点上验证过，Gemini 上的缓存命中也没有测量。
- `packages/ai-provider/tests/google-late-system.test.ts` 固定了三条规则（前缀、纯文本合并、函数响应独占一条内容），以及 `false` 时的旧形状。

### 记账 runtime 的布局

叙事之后的记账 agent 每回合各发一次请求，合起来比叙事本身的请求还大。它们声明了 `agent.history.maxTurns`，历史窗口每回合滑动。所以能跨回合重复的只有工具定义和 system prompt，其余每回合都是新内容。对这类 runtime：

- **整局不变的数据放进 system prompt**（`volatility: session` 的段），只把会变的值留在回合上下文。内置 `world-init` 把维度的规则和 schema 放在 `<dimension-rules>`（session 段），当前值放在 `<dimension-values>`（turn 段）。没有 `updateRule` 的维度定义也归入会话内稳定的段，被跟踪的值归入 turn 段。
- **一条记录里既有很少变的部分又有常变的部分时，拆成两个块，很少变的在前。** 内置 `char-creator` 的名册 `<existing-characters>` 只有 id、姓名、类型和 description（session 段），各角色当前的 `fields` 在 `<character-fields>` 里（turn 段）。某个角色的一个数值变了，名册不变。
- **历史窗口按需要取。** 当前玩家输入和本回合正文始终发送，不计入 `maxTurns`。

  | `maxTurns` | 适合什么                               | 内置例子                                                         |
  | ---------- | -------------------------------------- | ---------------------------------------------------------------- |
  | `0`        | 只结算本回合事实，已有状态由数据块给出 | `affinity`、`codex`、`npc-graph/extractor`、`world-time/advance` |
  | `1`        | 直接读正文，需要上一回合来分辨指代     | `char-creator/character-tracker`、`world-init/dimension-tracker` |
  | `2` 加摘要 | 写前情回顾                             | `guide`                                                          |

- **自己拼请求的 runtime 把变化少的字段排在前面。** `world-ir` 的用户消息依次是角色名册、词表、本回合正文。

`pnpm prompt:prefix <covel.db>` 按 runtime 列出一局会话里每回合第一个请求的大小、它和上一回合请求从头相同的部分，以及第一处不同出现在哪里（见[第 5 节](#5-token-预算与缓存)）。

仍然会让请求前缀提前变化的情况：

- 正文里内插的模板变量取值变了（如 `{{ characters.npcs }}`、`{{ player.character }}`；替代做法见[第 4 节](#4-template-变量与数据边界)）。
- 按关键词触发的世界书条目变了。
- 要求 `pre-history` 的 turn 扩展段变了。
- 历史被压缩。

声明了 `agent.history.maxTurns` 的 runtime 的历史窗口每回合滑动，本来就无法跨回合命中历史。

## 3. 插件扩展段

### 固定指令

固定指令写在根 `PLUGIN.md` 的 `contributes.prompt` 里。

- 宿主自动注册静态段，作者不用再声明扩展点。
- 静态段面向本插件。加载时连同根文件的语言变体一起冻结，执行时按 locale 选择。
- 静态段不做模板插值。需要模板变量的 runtime 私有指令写在这个 runtime 的正文里。

```yaml
contributes:
  prompt:
    - id: narrative-style
      content: Keep the narrator's perspective consistent.
      position: pre-history
      role: system
```

### 动态内容

动态内容通过 `prompt.segment@1` 提供。根清单声明 `contributes.extensions`，entry 调用 `provideExtension`，handler 返回段的数组：

```js
api.provideExtension("prompt.segment@1", "status", {
  async handler(input, ctx) {
    const status = await ctx.pluginData.get("status", "current");
    return status
      ? [
          {
            id: "current-status",
            content: JSON.stringify(status),
            position: "pre-history",
            audience: "self",
            volatility: "turn",
          },
        ]
      : [];
  },
});
```

- 提供者拿到当前执行的 locale、只读的世界视图，以及访问自身数据的能力。
- 同一次执行里，相同的扩展点输入会复用结果。提供者不能根据“是哪个 runtime 在调用它”返回不同的内容。
- `providerPluginId` 由宿主添加，插件不能伪造归属。

### 内置插件怎样用它

- `memory` 插件通过这个扩展点把自己的 `blocks` 数据渲染成回合段。块定义经 `memory.block-definitions@1` 服务收集。
- 内核不读取某个记忆插件的私有 namespace，也不提供 Core Memory、Working Memory 或 persona 专用的段。
- 世界结构的补充由 `session.world-context@1` 返回：`schema` / `entries`，以及当前值 `dimensions`。维度不是 `entries`，也不是常驻（constant）lorebook 的副本。
- 世界书仍然使用领域记录自己的 prompt position。
- `world-ir` 的 `PostContextAssembly` Hook 负责裁剪自己的历史输出和相关记忆，而不是追加一个提示词段。这类“变换”保留 Hook；要新增内容，用 `prompt.segment@1`。

### `PostContextAssembly` 和框架前置段

`PostContextAssembly` 可以改写最终的 `systemPrompt` / `messages`。但框架前置段不属于可以丢弃的部分。它有三块，都用会话的[指令语言](./i18n.md)写，简体中文会话整段是中文：

| 块             | 内容                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `[RUNTIME]`    | 运行框架                                                                                                                                       |
| `[LANGUAGE]`   | 输出语言指令                                                                                                                                   |
| `[COMPLETION]` | 完成约定。按 runtime 的结束方式有三种写法：有输出 schema 的以 JSON 或完成工具结束；故事 runtime 以回复里的正文结束；其余以 `runtime-done` 结束 |

- hook 返回的 `systemPrompt` 如果不以它开头，框架会把它补回最前面。所以只返回自己正文的裁剪型 hook 不需要去掉它，也去不掉它。
- payload 里的 `frameworkHead` 是这段文本的只读副本。
- 少了这段，模型就不知道会话用什么语言。
- hook 收到的原始本地化 `promptTemplate`、已解析的 `inputSlots` 和角色摘要是只读的来源，不接受 hook 替换。
- runtime 挂起时，输入槽冻结进 continuation，恢复时使用同一份输入。

### Runtime LLM 请求默认值

runtime 的 `agent` 分组可以声明两种请求偏好：

- `llm.reasoningEffort: disabled`
- `llm.toolChoice: { name: submit-facts }`（指定工具），或 `llm.toolChoice: required`（必须调用某个已声明的工具，由模型选）

**什么时候强制工具。** 叙事之后的记账 runtime 收到的对话是故事正文。不强制工具时，模型容易直接续写剧情。

- `required` 适合“无变化”也由同一个写入工具表达的 runtime（如 `update-dimensions({updates: []})`）。
- 如果“无变化”要改调 `runtime-done`，强制工具会让模型先提交一次被拒的空写入，而失败的写入不会被随后的 `runtime-done` 抵消。

**这个偏好的范围。**

- 它表示这个 runtime 的请求偏好，不改写 session 或 provider 的配置，也不会从 `requireToolUse` 自动推导出来。
- 重试、非流式调用、流式调用和 fallback 使用同一个偏好。
- 玩家 slot 的 parameter overrides 和 preset 的 provider metadata 优先。
- 它不能代替运行时的工具执行和输出 schema 校验。

**各服务商怎样映射。**

- 关闭推理：provider adapter 只在没有显式 reasoning 配置时应用默认的关闭值。按现有的模型能力映射为 Qwen 的 `enable_thinking: false`、DeepSeek 的 disabled，或者支持 `none` 的模型的对应值。不支持关闭的模型保留原有能力。
- 指定工具：分别映射到 Chat Completions、Responses 和 Anthropic 原生协议。
- 显式启用 thinking 的 Qwen / Anthropic 请求退回自动选择。
- 不接受强制工具调用的 Claude 模型（Fable 5.1、Mythos 5.1、Opus 5.5、Sonnet 5.5）同样退回 `auto`。
- 玩家自己设的 `auto` / `none` 原样发送。
- DeepSeek 的 thinking 请求省略不兼容的 `tool_choice`。`deepseek-flash` 和 V4 模型没有指定开关时，也按默认开启思考处理；显式关闭之后保留插件的工具选择偏好。这遵循 [DeepSeek Chat Completions 的工具选择限制](https://api-docs.deepseek.com/api/create-chat-completion/)，避免插件的偏好覆盖玩家的配置而导致 400。

## 4. Template 变量与数据边界

根内联 runtime 的 `PLUGIN.md` 正文，或子 runtime 的 `RUNTIME.md` 正文，支持 `{{ variable }}` 插值。

模板变量只读对象自己的属性。`inputs` 的插件和 runtime 查找按字符串键隔离：名叫 `constructor` 或 `toString` 的插件和字段照常读到显式的值，不会访问或改写 JavaScript 的继承对象。

常用变量：

- `player.message`、`player.lastFormValues`、`player.character`。
- `characters.npcs`：全部非玩家角色的档案。每行是 `姓名 [类型] | description | fields`，角色有别名时姓名后面跟 `(aka 别名, …)`。description 和 fields 各截到 400 字符，合计约 8000 字符，超出的角色只列姓名。不含 id，模型按姓名或别名用 `get-character` 查询。把它放进正文，模型就不必为每个出场人物各调一次 `get-character`。
- `session.id`、`session.turnNumber`。
- `inputs.<pluginId>.<runtimeId>.<field>`。
- `world.name`、`world.description`、`world.tags`、`world.lore`、`world.schema`、`world.entries`、`world.dimensions`。`world.lore` 是整篇正文，包括[只给叙事者的部分](./world-data.md#只给叙事者的正文narrator-only)，但不含那两行标记。
- `userSettings.*`，由根 `contributes.settings` 的默认值和玩家的配置合成。

世界的扩展视图通过公共扩展点提供。插件不能从其他插件的私有数据里拼出它。较长的世界内容应该按当前任务选取，不要每轮内联全部 lore。`world-dimension-get` / `world-dimension-list` 是框架内置工具，从同一份冻结的 `world.dimensions@1` 快照按需读取。

### 让 system prompt 保持不变的写法

`player.character`、`characters.npcs` 的取值随剧情变化。写在正文里，system prompt 就跟着变。在记录伤势或状态的会话里，它每回合都变，前缀缓存就停在那里。

想让 system prompt 逐回合不变的 runtime，在正文里只写块名，由插件 entry 提供回合级的提示段，内容进入[回合上下文](#回合上下文)：

```js
import { characterSheetSegments } from "@covel/plugin-handlers-utils";

covel.provideExtension("prompt.segment@1", "character-sheets", {
  handler: (_input, ctx) =>
    characterSheetSegments(ctx.world.characters, {
      profiles: true,
      locale: ctx.locale,
      schema: ctx.world.characterSchema,
    }),
});
```

- `<player-character>` 是玩家角色卡，和 `player.character` 是同一份 JSON。
- `profiles: true` 时再加 `<character-profiles>`，行格式和 `characters.npcs` 相同。
- `locale` 决定“未列出档案”那一行用中文还是 English，和正文的语言一致。
- `schema` 让声明了 min / max 的数值属性带上量程（`"might": "2/5"`）。否则模型只看到一个光秃秃的数字，分不清 2/5 和 2/100。

内置的 `narrator` 和 `chat-mode-narrator` 这样做。

### 动态维度的提示词投影

`world.dimensions.<id>` 包含 `{name,description?,schema,value,version}`。取具体的值写 `{{ world.dimensions.reputation.value }}`。

- `worldRecord.dimensions` / `metadata.dimensions` 是作者的声明，不是会话的进度。
- 旧的 raw 值路径和 `world.tone/openingScenario` 不是公共的快捷字段。

**给叙事的段。** 内置 `world-init` 通过 `prompt.segment@1` 提供 story 受众的 `<world-dimensions>` turn 段。它保留 ID、版本，以及预算内的本地化值。

- 默认总预算 12000 字符。放得下时每个值都完整给出，因为每个被截断的值都会让模型多调一次 `world-dimension-get`，而那一轮要重发整个提示词。
- 超出预算时，从最长的值开始截到 240 字符（用省略号标记）。
- 仍然放不下的维度，段里明确写出个数，并指引模型按 ID / path 或分页查询。
- 省略不代表值不存在。预览不冒充完整的 JSON。
- 选了某个模板路径，也不意味着框架会自动全量展开所有行集。

**给叙事的角色笔记。** 内置 `character-blueprint` 通过同一个扩展点提供 story 受众的 `<character-notes>` session 段：世界角色卡里写给扮演用的内容（口吻、举止、性格、目标、恐惧、秘密、关系、规则、示例台词）。

- 只写角色在会话里的卡，按卡 ID 排序。
- 在约 6000 token 的预算内逐档裁剪：先裁示例台词，再裁规则，口吻不裁。
- 它是会话内稳定的文本，位于系统提示的稳定区；角色名册变化时才会变。
- 字段和裁剪规则见[插件 README](../../plugins/character-blueprint/README.md#角色卡怎样进入叙事)。

**投影不改原始数据。**

- 投影只改变展示范围，不改原始快照或版本。
- 普通 JSON 不猜翻译，只有带 `x-i18n` 注解的节点才本地化。
- story 段、公共的 get / list 和客户端快照都不带 `initialValue/updateRule/lastTrackedSource`。

**给 tracker 自己的段。** tracker 的 self-only 段在预算内直接带完整的规则、schema 和冻结值：

| 段                   | 类型    | 内容                  | 位置          |
| -------------------- | ------- | --------------------- | ------------- |
| `<dimension-rules>`  | session | 规则和 schema         | system prompt |
| `<dimension-values>` | turn    | 每行一个 `id: 冻结值` | 回合上下文    |

- 两段都不带版本号（版本每次更新都变，写入工具自己读取）。
- 超出预算的维度列在 `<dimension-rules>` 的“已截断”下面，再用 `dimension-rule-get` 分页获取。
- 没有有效规则时，不调用维护模型。

**一回合里的时序。**

- pre-turn 只读地发布 Sₙ。叙事和 tracker 的公共读取用的是同一份 Sₙ。
- post-turn 提交之后，新的执行再发布新版。不反向绑定 tracker 的输出，也不拿 `recordAs` 或世界初值兜底。
- 来源重试通过 `retryFromTurnId` 使用原回合的 artifact。失败或未结算不等于“无变化”。
- 完整状态见 [World Model](./world-model.md#回合时序与结算回执)。
- 维度没有隐藏事件的载荷，也没有条件触发层。

### 数据边界

**簿记字段不进提示词。** 内核写进提示词的记录不带簿记字段：

- `io.selfData` 的行是 `- <key> | <值的 JSON>`，没有行的 `updatedAt`，值里和 key 相同的 `id` 不重复。
- 这些行、`<runtime-inputs>` / `<runtime-exports>` 的值、`<runtime-activation>` 的载荷和 `{{ world.schema }}` 里，UUID 型的 ID、ISO 时间和 `sessionId` 都被去掉。
- `characterSheetSegments()` 的玩家表和 NPC fields，以及 `{{ characters.npcs }}` 的 fields，也在序列化之前递归地使用同一个投影。
- 可读的语义 ID 和 `date` 这样的剧情字段保留。

规则和理由见[插件参考](./plugins.md#输入和输出)。

**输入块是数据，不再插值。** 声明的输入块带着上游输出或本插件的数据，XML 转义后作为数据注入，**不再执行模板插值**。模板只在 runtime 自己的正文上解释一次，防止数据里的 `{{ ... }}` 再次展开、绕过数据边界。

- `io.inputs` 解析出的 typed slots 保留 cardinality、value / items 和来源（provenance），通过[回合上下文](#回合上下文)里的 `<runtime-inputs>` 注入 agent。function runtime 从 `ctx.inputs` 读取。
- 提示词里的来源只有 `pluginId` 和 `runtimeId`。`resultId` 是只给工具和内核用的 UUID，工具从 `ctx.inputSlots` 读取，不进入提示词。`<runtime-exports>` 也一样。

**标签块里的模板变量会转义。** 正文里以 `<name>` 开头的行，到下一个 `</name>` 之间，`{{ ... }}` 的值经过 XML 转义再写入。所以世界文字或角色描述里的 `</world-summary>` 关不掉这个块。块外的变量，以及行内提到标签的散文里的变量，原样写入。

内核自己写的 `<world-lore>` 只改写正文里出现的 `</world-lore>`（写成 `&lt;/world-lore>`）。世界正文是长篇 Markdown，引用行的 `>`、注释标记和 `&` 原样进入提示词。

**`io.selfData` 只取有限的行。** 注入插件数据时，框架向存储请求一份有界的投影，而不是先读出整个 namespace 再裁剪。

- 默认 50 行：保留最早的 25 行作为锚点，再加最多 25 行最近更新的其他行。
- 行数更少的 namespace 保持创建顺序。
- 总行数仍然写在截断说明里。

**表单只读一次。** 一次执行通过 `getLatestPlayerInput` 读一次最新的表单，并在 context 快照里复用这一行。

**世界书的扫描范围。** 世界书条目可以用 `extra.scanDepth` 选择扫描之前已提交的若干条消息（0–20）；当前的玩家消息始终被扫描。扫描读的是库里历史的一段有界的结尾，包括已经被压缩的消息。内置的 Emberback 世界用关键词激活世界书条目，并省略了角色记录里已经有的人物生平。

## 5. Token 预算与缓存

### 预算

有 estimator 和 context budget 时才执行预算裁剪。预算检查发生在三处：context 组装时、`PostContextAssembly` 之后，以及每次 `PreLLMCall` 之后的实际请求上。实际请求包括工具和响应 schema、工具结果、steering 和重试内容。

- **响应 schema 按两份计。** 桥接层把它写进 system prompt，Responses 和 Gemini 协议还会作为原生字段再发一次，而预算阶段不知道最终走哪种协议。
- **受保护的内容。** 当前用户回合（包括它前面的回合上下文、本回合正文和结尾提示）和摘要信封，在普通的历史裁剪里受保护。工具调用和它的结果必须成对保留。
- **裁剪顺序。** 必要时先截短过长的工具回读，再截短本次调用里的摘要。数据库里的原始记录不受影响。
- **仍然超限。** 固定内容仍然超限时，拒绝向服务商发请求。
- **输出上限。** response reserve 同时限制本次请求的最大输出。
- **硬裁剪。** 硬裁剪为后续回合预留空间。裁剪标记里不含会变化的消息计数。

### system prompt 里的缓存边界

`serializeSystemPrompt(segments, true)` 在下面这些非空的段之后插入内部的 PUA sentinel（``），最多四处：

1. framework preamble
2. runtime 正文
3. stable / session 扩展段
4. after-plugin 世界书

- 留在 system prompt 里的 turn 扩展段（system 角色的 `pre-history`）放在最后一个缓存边界之后，不设断点。
- `position: system` 的 turn 扩展段不在 system prompt 里，见[回合上下文](#回合上下文)。
- user / assistant 角色的 pre-history、post-history 和 depth 段保持各自的消息位置。不保证这些消息位于某个 system 缓存边界之内。
- Anthropic adapter 把标记转换为带 `cache_control` 的 text 块。其他 provider 由 adapter 清理内部标记，并使用它支持的缓存方式。

### Anthropic 的四个边界

Anthropic 保留至多两个稳定的 system 缓存边界，并在消息里设置两个边界。四个边界是这个 API 的上限。

| 消息里的边界                                     | 谁能读到                                                   |
| ------------------------------------------------ | ---------------------------------------------------------- |
| 历史的最后一条消息上（对话里第一条回合指令之前） | 下一回合的请求：它和本回合相同的部分到历史结尾为止         |
| 请求最后一个可缓存的块上                         | 同一回合工具循环的后续请求：这里写入的内容包含本回合的数据 |

- 启用缓存边界时，每条消息的文字都以 text 块数组发送，不用字符串简写。原因：边界逐回合后移，带边界的消息必须是块数组；同一条消息在下一回合不带边界时保持同样的形式，前缀才逐字节相同。
- 请求里没有历史时（`maxTurns: 0` 的 runtime，回合上下文并入顶层 system），只有最后那个边界。
- thinking 块不带缓存控制。
- 其他协议在序列化时移除内部的 `COVEL_CACHE_BREAK` 标记。OpenAI 的两个协议另外发送按会话和 runtime 生成的 `prompt_cache_key`，见 [slots.md § 提示词缓存键](./slots.md#提示词缓存键)。

### 测量前缀

在仓库根目录运行。下面使用开发服务器的回退路径；若配置了其他数据库，换成实际文件的绝对路径，见[路径选择规则](./env-registry.md#plugin-extension-development-data)。

```bash
pnpm prompt:prefix apps/server/data/covel.db                      # One table per session
pnpm prompt:prefix apps/server/data/covel.db --session <id> --show world-init/dimension-tracker
pnpm prompt:prefix apps/server/data/covel.db --json
```

脚本读 `trace_events` 里的 `llm.calling`（它记录了发给服务商的请求体）。不需要模型，也不需要服务在运行。

- 对每个 runtime，它取每回合的第一个请求，按服务商计算缓存键的顺序（先工具定义，再各条消息），和上一回合的第一个请求逐字符比较。
- 表里的 `req tok` 是请求大小，`shared` 是从头相同的部分，最后一列是第一处不同所在的消息和偏移。
- `--show` 打印那一处前后的文字。
- 同一回合里工具循环的后续请求是在前一个请求后面追加，不参与比较。

> [!NOTE]
> 这是对前缀的测量，不是服务商的账单。token 数按字符估算（CJK 一字约一个 token，其余约四个字符一个 token）。实际是否命中，还取决于服务商的最小缓存长度、缓存存活时间和它自己的分词。

把稳定的内容排在前面，可以保留相同的前缀。`volatility` 决定三件事：排序、缓存边界，以及 `position: system` 的段落在 system prompt 还是回合上下文。它不保证内容永远不变，也不取消执行内的扩展结果复用。

## 6. 外置模板与本地化

- 共享的 `prompts/server` 保存世界生成和 lore 修复的模板。
- 历史摘要的模板由 `plugins/history-compaction/prompts/server` 持有，插件通过 SDK 的 `createPromptLoader(root)` 加载。它和插件正文一样只有 English 和简体中文两份，见 [i18n](./i18n.md)。
- 修改 `COVEL_PROMPTS_DIR` 只替换默认的共享 prompt 根目录，不会接管插件自己的目录。

共享的框架加载器依次尝试：完全匹配的 locale、文字系统兼容的主语言、English、不带语言后缀的默认文件。

- 非法的 locale 不进入路径查找。
- `zh-Hant` 不会命中简体的 `zh`。
- 独立的 loader 只在自己的目录里回退。
- `CreateWorldOptions.loadPrompt` 可以注入宿主的 loader。
- 运行中的插件清单、本地化正文和静态扩展段，遵守已经捕获的 registry generation。

### 代码写进提示词的固定文字

模板和正文之外，装配代码自己也写几句话：

- 世界规则的标题
- `<available-events>` 的事件发射说明
- 历史摘要块后面的说明句
- 被裁掉或被截断内容的标记
- 重试提示
- `output.schema` runtime 的 JSON 规则

这些都用会话的指令语言写：简体中文会话读到的是中文，其余会话是 English。标签名、`[retry N]` 这类标记和 id 不变。完整清单、插件代码的做法和不翻译的几类文字见 [i18n · 代码拼进提示词的文字](./i18n.md#代码拼进提示词的文字)。

工具定义、工具循环里返回给模型的结果，以及拒绝原因，始终是 English。

## 7. 相关实现

- `packages/runtime/src/turn-executor/session-state.ts`：canonical 历史加载与扩展投影。
- `packages/runtime/src/agent-loop/turn-agent-runtime.ts`：扩展段收集、压缩屏障和 agent context。
- `packages/context/src/prompt-assembler.ts`、`extension-segments.ts`：段组装、受众过滤与排序。
- `packages/context/src/prompt-serialization.ts`：system 段和缓存标记。
- `packages/runtime/src/commit/commit-ui.ts`、`packages/runtime/src/agent-loop/picture-attachments.ts`：图片说明行，图片字节的读取与上限。
- `packages/context/src/history-budget.ts`：压缩准入与原子持久化。
- `plugins/history-compaction/server/strategy.ts`：默认摘要策略。
- `packages/context/src/session-context.ts`：世界与世界书视图。

扩展的声明和调用边界见[插件扩展参考](./plugin-extensions.md)，作者格式见[插件参考](./plugins.md)。

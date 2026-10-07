# Prompt 结构参考

`buildContext(params)` 是统一的异步构建入口，内部按输入声明决定是否读取本插件数据。插件正文、声明输入、世界书和扩展段在 `packages/context/src/prompt-assembler.ts` 组装为 `systemPrompt` 与 `messages`；记忆内容和历史摘要策略由插件提供。

## 1. 构建入口与历史流水线

| 入口                         | 用途                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await buildContext(params)` | 组装 context；需要读取编译后 `input.inject` 中的 `plugin-data`（作者侧写作 `io.selfData`）时使用传入的 `store`。注入 `_hidden.*` 隐藏世界数据会直接报错。 |

一次执行的历史处理顺序如下：

1. 读取 canonical `turn_messages` 中未压缩的后缀和全量消息统计。当前玩家输入先保留在 execution journal，提交成功后才落库。
2. 对历史副本运行 `prompt.history-transform@1` pipeline。每个 provider 接收前一个 provider 的结果；该投影不改写 canonical 消息，也不改变调度计数。
3. 按当前 runtime 过滤其他插件的结构化历史输出和没有文本的 runtime 行，组装实际 system prompt，并合并已持久化摘要。声明了 `agent.history.maxTurns` 的 runtime 只保留最近 N 个回合（按 `turnId` 计数）的可见消息，默认不合并摘要，`agent.history.includeSummaries: true` 可保留持久摘要。
4. 把本次执行已经产出的故事正文接在当前玩家输入之后（见下方「本回合正文」）。
5. 首个使用共享历史视图的 agent 以这个 system prompt 估算压缩需求。同一 turn 的这类 agent 共用一次压缩屏障；成功后重载历史与摘要，重新投影并组装 context。声明了历史窗口的 runtime 不触发也不等待该屏障。
6. 执行 `PostContextAssembly`，应用预算；每次 `PreLLMCall` 后再按实际请求校验预算。

### 本回合正文

已提交的历史只到上一回合为止，本回合的消息要等执行提交后才落库。因此框架把执行日志（execution journal）里尚未提交的部分也投影进对话：当前玩家输入，以及更早 stage 里 `outputKind: story` 的 runtime 已经成功产出的正文。正文以 assistant 消息出现，和下一回合历史里的样子相同，后面跟一条 user 角色的框架提示，说明这段正文写于本回合、剧情停在它的结尾。

- 只取**更早 stage** 的结果。stage 之间有屏障，结果已经确定；同一 stage 内并行的 runtime 互相看不到对方的正文，需要时用 `io.inputs` 声明依赖。没有 stage 的 runtime（回合内的 event 后继）排在所有 stage 之后。
- 只取**本次执行**产出的正文。重试时作为种子带入的来源回合结果不投影，它的正文已经在历史里。
- `agent.history.maxTurns` 不计入本回合：`0` 仍会发送当前玩家输入和本回合正文。
- 这段正文和结尾提示属于当前回合，预算裁剪时与当前玩家输入一起受保护。回合中途玩家插入的消息同样计入当前回合；runtime 暂停后恢复时，保护范围随 continuation 一起保存（`currentTurnUserMessages`），与暂停前一致。

没有这一步时，叙事之后运行的 agent 读到的对话停在「上一回合的正文 + 本回合玩家输入」，模型会把上一回合结尾当成当下；`<runtime-inputs>` 里虽然有本回合正文，但那是数据块里的一个字段，不是对话的一部分。同一个 runtime 在提交后被重试时，历史里已经有本回合正文，两种情况现在读到的对话一致。

`history.compact@2` 是 single 扩展点。框架负责阈值、返回值校验及摘要与消息标记的原子持久化；默认 `history-compaction` 插件负责选择连续历史前缀、调用摘要模型和限制摘要长度。当前默认策略保护最近两个用户回合和最后五条消息，按 fast 模型可读的输入容量选择连续前缀，为新历史生成独立摘要。旧段原文保持稳定，只有总预算或最多八段的限制要求收缩时才合并最旧连续段。单段目标为源文本 estimated tokens 的 25%，下限 128，上限为有效窗口的 4% 与 2048 中较小值；总预算为有效窗口的 12%，下限 128、上限 8192，且不超过窗口自身。实际生成的摘要长度决定是否合并；小窗口会在合并旧段和新段之间分配预算。有效窗口取 story 与 fast 输入容量（扣除各自响应预留）的较小值，摘要模型请求仍使用 fast 自身容量。单条源消息装不进 fast 时保留原文，不截断源消息。

输出为 `{ summaries: [{ messageIds, replacesSummaryIds, content, focusSections, truncated? }] }`。每段只能覆盖新消息或旧摘要中的一种；框架只接受同一 session 中连续未压缩前缀的消息 ID，以及从最旧段开始连续选择的旧摘要 ID，拒绝跳过、重排、重复和外部来源。保留段加新段须满足总量、单段和段数限制。合并沿用最旧被替换段的 ID、起始回合与创建时间，只删除选中的旧段并重标记对应消息，保留段不变；全部写入在同一事务内提交。提供者需升级至 `@2`，不提供旧契约分支；已持久化摘要的记录形状未变。摘要以 `user` 角色、经过 XML 转义的 `<compacted_history>` 数据信封进入上下文。原始消息仍留在日志中；压缩只替换 prompt 中的表示。

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
  当前玩家输入
  本次执行已产出的故事正文与结尾提示（仅叙事之后的 runtime）
  按 depth 插入的世界书和扩展消息
  post-history 扩展消息
```

空段跳过；system 段以空行连接。`position: system` 的 stable / session 段与默认 system 角色的 `pre-history` 段进入 system prompt；`position: system` 且 `volatility: turn` 的段进入回合上下文。`pre-history` 的 user/assistant 段进入历史之前，`post-history` 段追加到 messages 末尾，`{ depth: n }` 按相对消息深度插入。

### 回合上下文

每回合都会变的内容不放在 system prompt 里，而是合成一条 system 消息，排在历史之后、当前玩家输入之前。它包含：

- 本回合的数据块：`io.selfData` 与注入块、`<runtime-inputs>`、`<runtime-exports>`，以及事件或手动触发的 `<runtime-activation>`（带载荷）。阶段内运行的 activation 每回合相同，留在 system prompt。
- `position: system` 且 `volatility: turn` 的扩展段，如记忆块和 `<world-dimensions>`。

原因是服务商的前缀缓存：一次请求只有从第一个字节起与之前的请求相同的部分才能命中。数据块在 system prompt 里时，system prompt 每回合都不同，排在它后面的整段历史就无法命中，会话越长浪费越多。现在 system prompt 逐回合保持不变，缓存可以一直覆盖到上一回合的历史。

- 这段内容仍是 system 角色，其中由插件写给模型的指令（如掷骰步骤）权重不变。Anthropic 仅将开头的 system 消息放入顶层 system；历史之后的回合指令保留位置，以带 `<system-instruction>` 的 user 内容发送。
- 它不放在请求的最后。请求仍以本回合的消息和 post-history 段结尾：数据块紧挨着回复时，较小的模型会把数据块的写法带进工具参数（把参数包成输入块的形状、在字段后面补一个闭合标签）。
- depth 插入按对话消息计数，回合上下文不占位置。
- 预算裁剪把紧挨在受保护回合之前的 system 消息一并保留，所以它不会被丢掉。压缩阈值的估算把它和 system prompt 一起计入。`AssembledContext.turnContext` 是它的内容，没有时为空字符串。
- 标签名不变。正文继续写 `runtime-inputs.<binding>.value`。

仍会让请求前缀提前变化的情况：正文里内插的模板变量取值变了（如 `{{ characters.npcs }}`、`{{ player.character }}`；替代做法见[第 4 节](#4-template-变量与数据边界)）、按关键词触发的世界书条目变了、要求 `pre-history` 的 turn 扩展段变了、历史被压缩。声明了 `agent.history.maxTurns` 的 runtime 的历史窗口每回合滑动，本来就无法跨回合命中历史。

扩展段先按 `audience` 过滤，再依次按 `volatility`（stable、session、turn）、`order`、provider plugin ID 和段 ID 排序。`audience: self` 覆盖提供插件的全部 runtime；`story` 匹配故事输出；`{ contract: "narrative-engine@1" }` 匹配 runtime 的输出契约。

## 3. 插件扩展段

固定指令写在根 `PLUGIN.md` 的 `contributes.prompt` 中。宿主自动注册静态段，作者无需重复声明扩展点。静态段面向本插件，加载时连同 root locale 变体一起冻结，执行时按 locale 选择。它们不再做模板插值；需要模板变量的 runtime 私有指令写在该 runtime 正文中。

```yaml
contributes:
  prompt:
    - id: narrative-style
      content: Keep the narrator's perspective consistent.
      position: pre-history
      role: system
```

动态内容通过 `prompt.segment@1` 提供。根清单声明 `contributes.extensions`，entry 调用 `provideExtension`，handler 返回段数组：

```js
api.provideExtension("prompt.segment@1", "status", {
  async handler(input, ctx) {
    const record = await ctx.pluginData.get("status", "current");
    return record
      ? [
          {
            id: "current-status",
            content: JSON.stringify(record.value),
            position: "pre-history",
            audience: "self",
            volatility: "turn",
          },
        ]
      : [];
  },
});
```

provider 获得当前执行的 locale、只读世界视图和自身数据访问能力。相同扩展点输入在一次执行内复用结果；provider 不能依赖某个正在调用它的 runtime 身份来返回不同内容。`providerPluginId` 由宿主添加，插件不能伪造归属。

`memory` 插件通过此扩展点把自身 `blocks` 数据渲染为回合段，块定义经 `memory.block-definitions@1` 服务收集。内核不读取某个记忆插件的私有 namespace，也不提供 Core Memory、Working Memory 或 persona 专用段。世界结构补充由 `session.world-context@1` 返回 `schema` / `entries` 与当前值 `dimensions`；维度不是 `entries` 或 constant lorebook 副本。世界书仍使用领域记录的 prompt position。

`PostContextAssembly` 仍可改写最终 `systemPrompt` / `messages`。框架前置段（`[RUNTIME]` 运行框架、`[LANGUAGE]` 输出语言指令、`[COMPLETION]` 完成约定；三部分都用会话的[指令语言](i18n.md)写，简体中文会话整段是中文；`[COMPLETION]` 按 runtime 的结束方式有三种写法：有输出 schema 的以 JSON 或完成工具结束，故事 runtime 以回复里的正文结束，其余以 `runtime-done` 结束）不属于可丢弃的部分：hook 返回的 `systemPrompt` 若不以它开头，框架会把它补回最前面，所以只返回自己正文的裁剪型 hook 不需要、也无法去掉它。payload 里的 `frameworkHead` 是这段文本的只读副本。少了这段，模型就不知道会话用什么语言。它收到的原始本地化 `promptTemplate`、已解析 `inputSlots` 和角色摘要是只读来源；这些来源不接受 hook replacement。挂起时输入槽冻结进 continuation，恢复使用同一输入。

### Runtime LLM 请求默认值

runtime 的 `agent` 分组可声明 `llm.reasoningEffort: disabled`，以及 `llm.toolChoice: { name: submit-facts }`（指定工具）或 `llm.toolChoice: required`（必须调用某个已声明工具，由模型选择）。叙事后的记账 runtime 收到的对话是故事正文，不强制工具时模型容易直接续写剧情。`required` 适合"无变化"也由同一个写入工具表达的 runtime（如 `update-dimensions({updates: []})`）；若无变化要改调 `runtime-done`，强制工具会让模型先提交一次被拒的空写入，而失败的写入不会被随后的 `runtime-done` 抵消。这表示该 runtime 的请求偏好，不改写 session/provider 配置，也不会从 `requireToolUse` 自动推导。重试、非流式调用、流式调用与 fallback 使用同一偏好；用户 slot 的 parameter overrides 和 preset provider metadata 优先。

provider adapter 只在没有显式 reasoning 配置时应用默认关闭值，沿现有模型能力映射为 Qwen `enable_thinking: false`、DeepSeek disabled，或支持 `none` 的模型的对应值；不支持关闭的模型保留原能力。指定工具分别映射到 Chat Completions、Responses 和 Anthropic 原生协议；显式启用 thinking 的 Qwen/Anthropic 请求退回自动选择，不接受强制工具调用的 Claude 模型（Fable 5.1、Mythos 5.1、Opus 5.5、Sonnet 5.5）同样退回 `auto`，玩家自己设的 `auto` / `none` 原样发送；DeepSeek thinking 请求省略不兼容的 `tool_choice`。`deepseek-flash` 和 V4 模型未指定开关时也按默认开启思考处理；显式关闭后保留插件的工具选择偏好。此行为遵循 [DeepSeek Chat Completions 的工具选择限制](https://api-docs.deepseek.com/api/create-chat-completion/)，避免插件偏好覆盖玩家配置而导致 400。该偏好不能代替运行时工具执行与输出 schema 校验。

## 4. Template 变量与数据边界

模板变量只读取对象自有属性。`inputs` 的 plugin/runtime lookup 按字符串键隔离；名为 `constructor` 或 `toString` 的插件与字段照常读取显式值，不访问或改写 JavaScript 继承对象。

根内联 runtime 的 `PLUGIN.md` 正文，或子 runtime 的 `RUNTIME.md` 正文，支持 `{{ variable }}` 插值。常用变量包括：

- `player.message`、`player.lastFormValues`、`player.character`。
- `characters.npcs`：全部非玩家角色的档案，每行 `姓名 [类型] | description | fields`（description 与 fields 各截至 400 字符，合计约 8000 字符；超出的角色只列姓名）。不含 id，模型按姓名用 `get-character` 查询。把它放进正文，模型就不必为每个出场人物各调一次 `get-character`。
- `session.id`、`session.turnNumber`。
- `inputs.<pluginId>.<runtimeId>.<field>`。

`player.character`、`characters.npcs` 的取值随剧情变化。写在正文里，system prompt 就跟着变：记录伤势或状态的会话里每回合都变，前缀缓存停在那里。希望 system prompt 逐回合不变的 runtime 在正文里只写块名，由插件 entry 提供回合级提示段，内容进入[回合上下文](#回合上下文)：

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

`<player-character>` 是玩家角色卡（与 `player.character` 相同的 JSON），`profiles: true` 时再加 `<character-profiles>`（与 `characters.npcs` 相同的行格式）。`locale` 决定“未列出档案”那一行用中文还是 English，与正文的语言一致。`schema` 让声明了 min/max 的数值属性带上量程渲染（`"might": "2/5"`），否则模型只看到一个光秃秃的数字，分不清 2/5 和 2/100。内置的 `narrator` 和 `chat-mode-narrator` 这样做。

- `world.name`、`world.description`、`world.tags`、`world.lore`、`world.schema`、`world.entries`、`world.dimensions`。
- `userSettings.*`，由根 `contributes.settings` 默认值和玩家配置合成。

世界扩展视图通过公共扩展点提供；插件不能从其他插件的私有数据中拼装它。较长世界内容应按当前任务选取，避免每轮内联全部 lore。`world-dimension-get` / `world-dimension-list` 是框架 builtin，从同一冻结 `world.dimensions@1` 快照按需读取。

### 动态维度的提示词投影

`world.dimensions.<id>` 包含 `{name,description?,schema,value,version}`，具体值写作 `{{ world.dimensions.reputation.value }}`。`worldRecord.dimensions` / `metadata.dimensions` 是作者声明，不是会话进度；旧 raw 值路径及 `world.tone/openingScenario` 不再是公共快捷字段。

捆绑 `world-init` 通过 `prompt.segment@1` 提供 story 受众的 `<world-dimensions>` turn 段。它保留 ID、版本及预算内的本地化值：默认总预算 12000 字符，放得下时每个值都完整给出，因为每个被截断的值都会让模型多调一次 `world-dimension-get`，而那一轮要重发整个提示词；超出预算时从最长的值开始截到 240 字符（以省略号标记），仍放不下的维度计数会显式显示，并指引按 ID/path 或分页查询。省略不代表值不存在，预览不冒充完整 JSON。选择了某个模板路径也不意味着框架会自动全量展开所有行集。

投影只改变展示范围，不改原始快照或版本。普通 JSON 不猜翻译，只有 `x-i18n` 注解节点本地化。story 段、公共 get/list 及客户端快照均不带 `initialValue/updateRule/lastTrackedSource`；tracker 的 self-only `<dimension-rules>` 段在预算内直接带完整规则、schema 与冻结值，超出预算的维度再用 `dimension-rule-get` 分页获取。没有有效规则时不调用维护模型。

pre-turn 只读发布 Sₙ，叙事与 tracker 公共读取同一份 Sₙ；post-turn 提交后新执行再发布新版，不反向绑定 tracker 输出，不以 `recordAs` 或世界初值兜底。来源重试通过 `retryFromTurnId` 使用原 turn artifact，失败/未结算不是无变化。完整状态见 [World Model](world-model.md#回合时序与结算回执)。本期没有 #97 的隐藏事件载荷或条件触发层。

内核写进提示词的记录不带簿记字段：`io.selfData` 的行是 `- <key> | <值的 JSON>`，没有行的 `updatedAt`，值里与 key 相同的 `id` 不重复；这些行、`<runtime-inputs>` / `<runtime-exports>` 的值和 `{{ world.schema }}` 里，UUID 型的 ID、ISO 时间和 `sessionId` 都被去掉。`characterSheetSegments()` 的玩家表和 NPC fields，以及 `{{ characters.npcs }}` 的 fields，也在序列化前递归使用同一投影；可读语义 ID 与 `date` 等剧情字段保留。规则与理由见 [插件参考](plugins.md#输入和输出)。

声明输入块携带上游输出或本插件数据，XML 转义后作为数据注入，**不再执行模板插值**。模板只在 runtime 自身正文上解释一次，防止数据中的 `{{ ... }}` 再次展开并绕过数据边界。`io.inputs` 解析出的 typed slots 保留 cardinality、value/items 与 provenance，并通过[回合上下文](#回合上下文)里的 `<runtime-inputs>` 注入 agent；function runtime 从 `ctx.inputs` 读取。提示词里的 provenance 只有 `pluginId` 与 `runtimeId`：`resultId` 是只供工具和内核使用的 UUID，工具从 `ctx.inputSlots` 读取，不进入提示词（`<runtime-exports>` 同理）。

## 5. Token 预算与缓存

有 estimator 和 context budget 时才执行预算裁剪。预算边界覆盖 context assembly、`PostContextAssembly` 后以及每次 `PreLLMCall` 后的实际请求，包括工具和响应 schema、工具结果、steering 与 retry 内容。当前用户回合（含它前面的回合上下文、本回合正文及其结尾提示）和摘要信封在普通历史裁剪中受保护；工具调用与结果的配对必须保留。必要时先截短过长工具回读，再截短本次调用中的摘要，数据库原始记录不受影响。固定内容仍超限时拒绝 provider 请求。response reserve 同时限制本次请求的最大输出。

`serializeSystemPrompt(segments, true)` 在以下非空段之后插入内部 PUA sentinel（`\uE000`）：framework preamble、runtime 正文、stable/session 扩展段、after-plugin 世界书。最多四处；留在 system prompt 的 turn 扩展段（system 角色的 `pre-history`）放在最后一个缓存边界之后，不设置断点；`position: system` 的 turn 扩展段不在 system prompt 里，见[回合上下文](#回合上下文)。user/assistant 角色的 pre-history、post-history 和 depth 段保持各自消息位置，不承诺这些消息位于某个 system 缓存边界内。Anthropic adapter 将标记转换为 `cache_control` text blocks；其他 provider 由 adapter 清理内部标记并使用其支持的缓存方式。

稳定内容排在前面可以保留相同前缀。`volatility` 决定排序、缓存边界，以及 `position: system` 的段落在 system prompt 还是回合上下文；它不保证内容永远不变，也不取消执行内的扩展结果复用。

## 6. 外置模板与本地化

共享 `prompts/server` 当前保存世界生成与 lore 修复模板。历史摘要模板由 `plugins/history-compaction/prompts/server` 持有，插件通过自己的 `createPromptLoader(root)` 加载。修改 `COVEL_PROMPTS_DIR` 只替换默认共享 prompt root，不会接管插件的独立目录。

共享加载器按 exact locale、兼容 script 的 primary language、English、canonical 文件依次解析；非法 locale 不进入路径查找，`zh-Hant` 不命中简体 `zh`。独立 loader 只在自己的目录内回退。`CreateWorldOptions.loadPrompt` 可注入宿主 loader；运行中的插件清单、本地化正文和静态扩展段则遵守已捕获的 registry generation。

### 代码写进提示词的固定文字

模板和正文之外，装配代码自己也写几句话：世界规则的标题、`<available-events>` 的事件发射说明、历史摘要块后的说明句、被裁掉或被截断内容的标记、重试提示、`output.schema` runtime 的 JSON 规则。这些都用会话的指令语言写，简体中文会话读到的是中文，其余会话是 English；标签名、`[retry N]` 这类标记和 id 不变。完整清单、插件代码的做法和不翻译的几类文字见 [i18n · 代码拼进提示词的文字](i18n.md#代码拼进提示词的文字)。

工具定义和工具循环里返回给模型的结果、拒绝原因始终是 English。

## 7. 相关实现

- `packages/runtime/src/turn-executor/session-state.ts`：canonical 历史加载与扩展投影。
- `packages/runtime/src/agent-loop/turn-agent-runtime.ts`：扩展段收集、压缩屏障和 agent context。
- `packages/context/src/prompt-assembler.ts`、`extension-segments.ts`：段组装、受众过滤与排序。
- `packages/context/src/prompt-serialization.ts`：system 段和缓存标记。
- `packages/context/src/history-budget.ts`：压缩准入与原子持久化。
- `plugins/history-compaction/server/strategy.ts`：默认摘要策略。
- `packages/context/src/session-context.ts`：世界与世界书视图。

扩展声明与调用边界见 [插件扩展参考](./plugin-extensions.md)，作者格式见 [插件参考](./plugins.md)。

`world-ir` 的 `PostContextAssembly` Hook 继续负责裁剪自身历史输出及相关记忆，而非追加一个提示词段；这类变换保留 Hook，新增内容使用 `prompt.segment@1`。

Anthropic 保留至多两个稳定 system 缓存边界，并在最新可缓存的历史/工具块上设置移动边界；thinking 块不带缓存控制。其他协议在序列化时移除内部 `COVEL_CACHE_BREAK` 标记。硬裁剪为后续回合预留空间，裁剪标记不含变化的消息计数。压缩触发窗口取 story 与摘要调用槽位输入窗口的较小值，摘要请求仍使用摘要槽位。

The dimension provider separates definitions without an `updateRule` into session-stable prompt segments and tracked values into turn segments. The Emberback lore example uses keyword activation and omits character biographies already supplied by the character records. A lore entry may opt into `extra.scanDepth` prior committed messages (0–20); the current player message is always scanned.

Plugin-data injects request a bounded storage projection instead of loading a whole namespace before trimming. The default 50 rows retain the oldest 25 anchors and up to 25 most recently updated other rows; smaller namespaces retain creation order. The total count still appears in the truncation note. The execution reads its newest form once via `getLatestPlayerInput` and reuses that row in the context snapshot. A summary model response ending in `length` / `max_tokens` is discarded before any history tags or summaries change; explicit budget shortening of a completed summary remains marked `truncated`.

Before persisting a generated segment, the transaction verifies its message IDs against a bounded read of the canonical uncompacted prefix. A history transform that filters or reorders that prefix may still shape the prompt, but cannot tag a disconnected span as compacted; the compaction attempt is skipped and original history remains unchanged. Lorebook scan depth reads a bounded canonical tail, including compacted messages.

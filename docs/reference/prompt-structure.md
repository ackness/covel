# Prompt 结构参考

`buildContext(params)` 是统一的异步构建入口，内部按输入声明决定是否读取本插件数据。插件正文、声明输入、世界书和扩展段在 `packages/context/src/prompt-assembler.ts` 组装为 `systemPrompt` 与 `messages`；记忆内容和历史摘要策略由插件提供。

## 1. 构建入口与历史流水线

| 入口                         | 用途                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `await buildContext(params)` | 组装 context；需要读取 `input.inject` 中的 `plugin-data` 时使用传入的 `store`。 |

一次执行的历史处理顺序如下：

1. 读取 canonical `turn_messages` 中未压缩的后缀和全量消息统计。当前玩家输入先保留在 execution journal，提交成功后才落库。
2. 对历史副本运行 `prompt.history-transform@1` pipeline。每个 provider 接收前一个 provider 的结果；该投影不改写 canonical 消息，也不改变调度计数。
3. 按当前 runtime 过滤其他插件的结构化历史输出，组装实际 system prompt，并合并已持久化摘要。
4. 首个 agent 以这个 system prompt 估算压缩需求。同一 turn 的 agent 共用一次压缩屏障；成功后重载历史与摘要，重新投影并组装 context。
5. 执行 `PostContextAssembly`，应用预算；每次 `PreLLMCall` 后再按实际请求校验预算。

`history.compact@1` 是 single 扩展点。框架负责阈值、返回值校验及摘要与消息标记的原子持久化；默认 `history-compaction` 插件负责选择连续历史前缀、调用摘要模型和限制摘要长度。当前默认策略保护最近两个用户回合和最后五条消息，将旧摘要与新前缀合并为单块滚动摘要，预算为 context window 的 4%，最少 128、最多 1024 estimated tokens。

框架只接受同一 session 中连续未压缩前缀的消息 ID，拒绝跳过、重排或引用外部消息的结果。摘要以 `user` 角色、经过 XML 转义的 `<compacted_history>` 数据信封进入上下文。原始消息仍留在日志中；压缩只替换 prompt 中的表示。

## 2. 段位与排序

```text
systemPrompt
  Framework Preamble
  当前 runtime 的本地化正文
  stable / session 扩展段
  WorldInfo: before-plugin
  声明输入、导出、事件目录与 activation 数据块
  WorldInfo: after-plugin
  turn 扩展段

messages
  pre-history 非 system 扩展消息
  摘要替换后的历史
  当前玩家输入
  按 depth 插入的世界书和扩展消息
  post-history 扩展消息
```

空段跳过；system 段以空行连接。`position: system` 与默认 system 角色的 `pre-history` 段进入 system prompt。`pre-history` 的 user/assistant 段进入历史之前，`post-history` 段追加到 messages 末尾，`{ depth: n }` 按相对消息深度插入。

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

`PostContextAssembly` 仍可改写最终 `systemPrompt` / `messages`。它收到的原始本地化 `promptTemplate`、已解析 `inputSlots` 和角色摘要是只读来源；这些来源不接受 hook replacement。挂起时输入槽冻结进 continuation，恢复使用同一输入。

### Runtime LLM 请求默认值

runtime 的 `agent` 分组可声明 `llm.reasoningEffort: disabled` 和 `llm.toolChoice: { name: submit-facts }`。这表示该 runtime 的请求偏好，不改写 session/provider 配置，也不会从 `requireToolUse` 自动推导。重试、非流式调用、流式调用与 fallback 使用同一偏好；用户 slot 的 parameter overrides 和 preset provider metadata 优先。

provider adapter 只在没有显式 reasoning 配置时应用默认关闭值，沿现有模型能力映射为 Qwen `enable_thinking: false`、DeepSeek disabled，或支持 `none` 的模型的对应值；不支持关闭的模型保留原能力。指定工具分别映射到 Chat Completions、Responses 和 Anthropic 原生协议；显式启用 thinking 的 Qwen/Anthropic 请求退回自动选择，DeepSeek thinking 请求省略不兼容的 `tool_choice`。`deepseek-flash` 和 V4 模型未指定开关时也按默认开启思考处理；显式关闭后保留插件的工具选择偏好。此行为遵循 [DeepSeek Chat Completions 的工具选择限制](https://api-docs.deepseek.com/api/create-chat-completion/)，避免插件偏好覆盖玩家配置而导致 400。该偏好不能代替运行时工具执行与输出 schema 校验。

## 4. Template 变量与数据边界

根内联 runtime 的 `PLUGIN.md` 正文，或子 runtime 的 `RUNTIME.md` 正文，支持 `{{ variable }}` 插值。常用变量包括：

- `player.message`、`player.lastFormValues`。
- `session.id`、`session.turnNumber`。
- `inputs.<pluginId>.<runtimeId>.<field>`。
- `world.name`、`world.description`、`world.tags`、`world.lore`、`world.schema`、`world.entries`、`world.dimensions`。
- `userSettings.*`，由根 `contributes.settings` 默认值和玩家配置合成。

世界扩展视图通过公共扩展点提供；插件不能从其他插件的私有数据中拼装它。较长世界内容应按当前任务选取，避免每轮内联全部 lore。`world-dimension-get` / `world-dimension-list` 是框架 builtin，从同一冻结 `world.dimensions@1` 快照按需读取。

### 动态维度的提示词投影

`world.dimensions.<id>` 包含 `{name,description?,schema,value,version}`，具体值写作 `{{ world.dimensions.reputation.value }}`。`worldRecord.dimensions` / `metadata.dimensions` 是作者声明，不是会话进度；旧 raw 值路径及 `world.tone/openingScenario` 不再是公共快捷字段。

捆绑 `world-init` 通过 `prompt.segment@1` 提供 story 受众的 `<world-dimensions>` turn 段。它保留 ID、版本及预算内的本地化值预览：当前默认总预算 8192 字符，单项值预览最多 240 字符；超出预算的维度计数会显式显示，长值使用省略号，并指引按 ID/path 或分页查询。省略不代表值不存在，预览不冒充完整 JSON。选择了某个模板路径也不意味着框架会自动全量展开所有行集。

投影只改变展示范围，不改原始快照或版本。普通 JSON 不猜翻译，只有 `x-i18n` 注解节点本地化。story 段、公共 get/list 及客户端快照均不带 `initialValue/updateRule/lastTrackedSource`；tracker 使用 self-only 规则预览与 `dimension-rule-get` 获取完整维护规则。没有有效规则时不调用维护模型。

pre-turn 只读发布 Sₙ，叙事与 tracker 公共读取同一份 Sₙ；post-turn 提交后新执行再发布新版，不反向绑定 tracker 输出，不以 `recordAs` 或世界初值兜底。来源重试通过 `retryFromTurnId` 使用原 turn artifact，失败/未结算不是无变化。完整状态见 [World Model](world-model.md#回合时序与结算回执)。本期没有 #97 的隐藏事件载荷或条件触发层。

声明输入块携带上游输出或本插件数据，XML 转义后作为数据注入，**不再执行模板插值**。模板只在 runtime 自身正文上解释一次，防止数据中的 `{{ ... }}` 再次展开并绕过数据边界。`io.inputs` 解析出的 typed slots 保留 cardinality、value/items 与 provenance，并通过 `<runtime-inputs>` 注入 agent；function runtime 从 `ctx.inputs` 读取。

## 5. Token 预算与缓存

有 estimator 和 context budget 时才执行预算裁剪。预算边界覆盖 context assembly、`PostContextAssembly` 后以及每次 `PreLLMCall` 后的实际请求，包括工具和响应 schema、工具结果、steering 与 retry 内容。当前用户回合和摘要信封在普通历史裁剪中受保护；工具调用与结果的配对必须保留。必要时先截短过长工具回读，再截短本次调用中的摘要，数据库原始记录不受影响。固定内容仍超限时拒绝 provider 请求。response reserve 同时限制本次请求的最大输出。

`serializeSystemPrompt(segments, true)` 在以下非空段之后插入内部 PUA sentinel（`\uE000`）：framework preamble、runtime 正文、stable/session 扩展段、after-plugin 世界书。最多四处；进入 system prompt 的 turn 扩展段（`position: system` 或 system 角色的 `pre-history`）放在最后一个缓存边界之后，不设置断点。user/assistant 角色的 pre-history、post-history 和 depth 段保持各自消息位置，不承诺这些消息位于某个 system 缓存边界内。Anthropic adapter 将标记转换为 `cache_control` text blocks；其他 provider 由 adapter 清理内部标记并使用其支持的缓存方式。

稳定内容排在前面可以保留相同前缀。`volatility` 仅决定排序和缓存边界，不保证内容永远不变，也不取消执行内的扩展结果复用。

## 6. 外置模板与本地化

共享 `prompts/server` 当前保存世界生成与 lore 修复模板。历史摘要模板由 `plugins/history-compaction/prompts/server` 持有，插件通过自己的 `createPromptLoader(root)` 加载。修改 `COVEL_PROMPTS_DIR` 只替换默认共享 prompt root，不会接管插件的独立目录。

共享加载器按 exact locale、兼容 script 的 primary language、English、canonical 文件依次解析；非法 locale 不进入路径查找，`zh-Hant` 不命中简体 `zh`。独立 loader 只在自己的目录内回退。`CreateWorldOptions.loadPrompt` 可注入宿主 loader；运行中的插件清单、本地化正文和静态扩展段则遵守已捕获的 registry generation。

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

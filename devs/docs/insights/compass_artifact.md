# AI Agent 框架架构深度对比：Covel 改进路线图

**Covel 的 Proposal → Commit 状态管理模式和 Markdown 插件系统在当前 AI Agent 生态中独树一帜，但在执行管道、上下文管理、可观测性三个维度存在明显提升空间。** 通过对 Hermes Agent、Mastra、LangGraph、CrewAI、AutoGen/AG2、OpenCode、Codex CLI、Rivet、Julep 共 10 个开源项目的架构分析，本报告提炼出 Covel 可采纳的关键模式，并给出分维度的具体建议。整体来看，**生态正在向"图执行 + 持久化检查点 + 可观测性优先"三大支柱收敛**，Covel 需要在保持现有优势的同时补齐这些能力。

---

## 一、执行管道：从线性轮次到有向图

Covel 当前采用回合制（turn-based）执行引擎，插件按优先级依次执行。这种模式清晰且可预测，但在复杂场景下缺乏灵活性。横向对比揭示了三种主流的执行范式。

**LangGraph 的图执行模型是最成熟的方案。** 它将工作流建模为有向循环图（支持循环，而非仅 DAG），通过 Super-Step 机制批处理并行节点执行。每个 Super-Step 边界自动产生检查点，失败时仅重执行失败节点，已完成节点的写入（pending writes）被保留。LangGraph 还提供了 `Command(goto="node", update={...})` 原语，允许节点动态改变执行路由——这对 RPG 游戏中的分支剧情极为有用。

**Mastra 采用双轨执行模型**，值得 Covel 借鉴：Agent 循环（开放式 LLM 推理）与 Workflow（确定性图执行）并存。Workflow 通过 `.then()` / `.branch()` / `.parallel()` / `.foreach()` 链式组合步骤，每个步骤有独立的 `inputSchema` / `outputSchema`（Zod 验证），并支持 **Suspend/Resume** ——工作流可以在任意步骤暂停，将状态序列化到存储层，之后恢复执行。这种能力对需要玩家决策介入的 RPG 场景天然适配。

**CrewAI 的 Crews + Flows 双层架构**提供了另一种思路：Flows 用装饰器 `@start()` / `@listen()` / `@router()` 构建事件驱动的控制流，Crews 作为自治执行单元嵌入 Flow 节点中。`@router()` 基于输出值做条件路由，`or_()` / `and_()` 组合器处理复杂触发条件。

**对 Covel 的建议：**

- **引入轻量级图执行层**，在现有 turn-based 引擎之上叠加。保留"回合"概念作为宏观调度单元，但在每个回合内部支持插件间的有向图依赖（而非纯优先级线性）。例如，"战斗计算插件" → "UI 渲染插件"可以建模为图边，而非依赖手动设定的优先级数字
- **实现 Suspend/Resume 原语**：参考 Mastra 的设计，在 Session Kernel 层面增加 `suspend(reason, schema)` 和 `resume(data)` 方法，让插件能暂停等待玩家输入后恢复。状态序列化到现有存储后端（SQLite/PostgreSQL）
- **增加条件边（Conditional Edges）**：参考 LangGraph 的 `add_conditional_edges()`，让插件执行路由可以基于运行时状态动态决定。当前 Guard 函数已做了一半工作（条件跳过），需要扩展为"条件路由到不同插件"

---

## 二、状态管理：Proposal → Commit 的优势与扩展

Covel 的 Proposal → Commit 模式是一个**极为出色的设计**，在对比的 10 个项目中没有发现完全相同的模式。它提供了事务性语义——状态变更先提议再确认——这比大多数框架的直接 mutation 更安全、更可审计。

**LangGraph 的 Reducer + Checkpoint 模式**是最接近的对标方案。状态通过 TypedDict + 注解 Reducer 函数定义（如 `Annotated[list, add_messages]` 控制列表合并行为），每个 Super-Step 自动产生检查点。它支持 **时间旅行调试** ——从任意检查点 fork 新执行分支，这在 RPG 游戏中可以实现"存档回放"功能。

**AG2 的 ContextVariables** 解决了一个关键问题：将结构化共享状态与对话历史分离。ContextVariables 独立于消息流，通过工具返回值的 `ReplyResult(context_variables=updated)` 更新，并可通过 `UpdateSystemMessage` 模板动态注入系统提示。这避免了状态信息污染 LLM 上下文窗口——Covel 的命名空间隔离已走在了正确方向，但缺少"状态注入提示"的能力。

**Julep 基于 Temporal 的持久化状态机**展示了企业级方案：每个执行步骤产生"转换（transition）"记录，存入 PostgreSQL，包含当前/下一步、步骤输出、转换类型（init/step/wait/resume/finish/error）。这提供了完整的执行审计轨迹和故障后精确恢复。

**对 Covel 的建议：**

- **保持 Proposal → Commit 模式**，这是 Covel 的核心差异化优势。建议进一步增强：为每次 Commit 生成**不可变快照（Snapshot）**，支持回滚到任意快照
- **增加检查点机制**：参考 LangGraph，在每个回合结束时自动生成检查点（存入 SQLite/PostgreSQL）。支持从检查点恢复执行，实现"存档/读档"能力
- **引入 ContextVariables 概念**：在 Session Kernel 中增加一个独立于消息历史的结构化状态层，用于跨插件共享游戏状态（HP/MP/道具/剧情标记），通过 Zod schema 验证。工具调用返回值可以附带状态更新
- **状态变更事件流**：参考 AG2 的 AG-UI 协议，每次 Commit 后发射 `STATE_SNAPSHOT` 或 `STATE_DELTA` 事件到 SSE 流，让前端可以实时同步状态

---

## 三、插件系统：Covel 的独特设计与改进方向

Covel 的 PLUGIN.md frontmatter + Markdown Prompt 插件系统是所有对比项目中**最具创意的设计之一**。将插件定义为 Markdown 文件既人类可读又 LLM 友好，降低了创建新插件的门槛。

**横向对比中的插件模式主要有五种：**

| 模式 | 代表项目 | 特点 |
|------|---------|------|
| 代码注册 | Hermes（Python 文件自注册）、Mastra（`createTool()`） | 强类型，高灵活性，需编码能力 |
| 事件钩子 | OpenCode（30+ hook 事件）、Codex（外部进程 hooks） | 生命周期拦截，松耦合 |
| 可视化节点 | Rivet（`PluginNodeImpl` 接口 + IDE） | 非工程师可参与，直观 |
| MCP 协议 | Mastra/Hermes/OpenCode/Codex 均支持 | 标准化工具接口，跨框架互通 |
| Markdown/YAML | Codex（AGENTS.md + SKILL.md）、CrewAI（YAML 配置） | 人类可读，版本可控 |

**Hermes Agent 的插件系统**提供了 4 个生命周期钩子（`pre_llm_call` / `post_llm_call` / `on_session_start` / `on_session_end`），并通过上下文 API 注册工具、钩子和 CLI 命令。Hermes 的 Skills 系统采用**渐进式披露（Progressive Disclosure）**——Level 0 仅加载名称和描述（~3K tokens），Level 1 加载完整内容，Level 2 引用外部文件。200 个 Skills 的 token 开销与 40 个几乎相同。

**OpenCode 的事件驱动插件系统**是最丰富的：30+ 可订阅的 hook 事件覆盖工具执行前后、会话压缩、文件编辑、LSP 诊断、TUI 命令等。插件通过 `tool.execute.before` / `tool.execute.after` 可以拦截和修改工具调用。

**Codex CLI 的 Hooks 框架**走了不同的路线：外部进程钩子，通过 JSON stdin/stdout 通信，支持任何语言/运行时。钩子可以注入系统消息、阻止工具执行、添加上下文、终止会话。这种语言无关的设计值得参考。

**对 Covel 的建议：**

- **增加生命周期钩子**：在 PLUGIN.md 中支持声明钩子订阅，至少覆盖：`before_turn` / `after_turn` / `before_llm_call` / `after_llm_call` / `before_tool_call` / `after_tool_call` / `on_state_change`。钩子可以修改输入/输出或阻止执行
- **实现渐进式 Prompt 披露**：借鉴 Hermes 的 Skills 分级加载。低优先级或当前不活跃的插件仅向 LLM 暴露名称和简短描述，需要时才注入完整 prompt。这对管理大量插件时的 token 开销至关重要
- **支持 MCP 协议**：将插件工具通过 MCP Server 暴露，同时支持消费外部 MCP Server 的工具。MCP 已成为 Agent 生态的事实标准（10 个项目中 7 个已支持）
- **保持 Markdown 定义优势**：这是 Covel 的差异化点。考虑增加 Markdown 中的 Zod schema 内联定义（类似 MDX 中嵌入组件），让 PLUGIN.md 同时承载类型信息

---

## 四、上下文管理：最迫切的改进领域

上下文管理是 AI Agent 框架中技术含量最高的维度，也是 Covel 当前信息最少的领域。对比项目展示了从简单截断到前沿压缩的完整谱系。

**Mastra 的 Observational Memory（OM）是当前最先进的方案。** 它使用两个后台 Agent——Observer 和 Reflector——实时监控对话：Observer 在 token 超过阈值（默认 30K）时将旧消息压缩为"观察记录"；Reflector 在观察记录超过阈值（默认 40K）时进行垃圾回收。实现了 **5-40x 的对话历史压缩**，在 LongMemEval 基准上达到 94.87%（SOTA）。关键设计——观察记录块是追加式的（append-only），天然适配 Prompt 缓存。

**Hermes Agent 的四层记忆架构**为 Covel 这类需要丰富上下文的应用提供了参考模型：
- **Prompt Memory**（MEMORY.md + USER.md）：始终加载，字符限制 3,575
- **Session Search**（SQLite FTS5）：按需检索历史对话，LLM 摘要后注入
- **Skills**（程序记忆）：渐进式披露，token 开销与数量无关
- **Honcho**（用户建模）：12 层身份模型，被动观察用户偏好

**OpenCode 的双重压缩策略**值得直接借鉴：
1. **自动压缩（Compaction）**：token 溢出时触发压缩 Agent 生成摘要，替换旧消息
2. **工具输出裁剪（Pruning）**：从最新消息向后扫描，保护最近 2 轮用户对话，仅当总工具输出 > 40K tokens 且可裁剪量 ≥ 20K tokens 时才裁剪，替换为"[旧工具结果已清除]"

**Codex CLI 的 Prompt 缓存保持架构**展示了极致优化：每次请求发送完整历史（stateless），但精心设计 prompt 结构确保旧 prompt 是新 prompt 的精确前缀，实现缓存命中。配置变更被追加为新消息而非修改旧内容。服务端 `/responses/compact` 端点返回包含加密内容的压缩项，保留模型的潜在理解。

**对 Covel 的建议：**

- **实现分层上下文管理**：建立三层结构——(1) 核心上下文（永久加载：游戏规则、当前场景、角色状态），(2) 活跃上下文（当前回合相关的插件 prompt 和工具结果），(3) 归档上下文（历史对话摘要，按需检索）
- **引入自动压缩机制**：参考 OpenCode，当上下文接近 token 上限时，自动触发摘要 Agent 压缩历史对话。保留压缩前的完整记录在存储层，仅在发送给 LLM 时使用压缩版本
- **工具输出智能裁剪**：参考 OpenCode 的 Pruning 策略，标记每个工具输出的 token 大小，当总量超标时从旧到新裁剪，但保护最近 N 轮交互
- **Prompt 缓存感知设计**：确保系统 prompt（游戏规则 + 插件 prompt）在会话内保持稳定不变，利用 LLM 提供商的 Prompt 缓存功能降低成本和延迟。Hermes 的做法是在会话初始化时冻结系统 prompt
- **Working Memory**：参考 Mastra，为每个玩家维护一个小型结构化状态（JSON/Zod schema），跨会话持久化，存储玩家偏好、进度标记等。这比每次从历史对话中提取更高效

---

## 五、工具系统：Covel 已走在正确方向

Covel 使用 Zod schema 定义 builtin + local 工具的方案与行业最佳实践高度一致——Mastra 完全采用相同方案，LangGraph/CrewAI 使用 Pydantic（Python 的 Zod 等价物）。

**AG2 的 ReplyResult 模式**值得 Covel 借鉴：工具返回值不仅包含结果文本，还可以附带状态更新和流转控制。`ReplyResult(message="...", target=AgentTarget("next_plugin"), context_variables=updated)` 让工具同时完成三件事——返回结果、更新共享状态、指定下一步执行者。这对 RPG 中"使用道具 → 更新 HP → 触发剧情事件"的链式操作非常自然。

**AG2 的依赖注入（DI）机制**解决了敏感数据问题：通过 `Annotated[str, Inject("api_key")]`，敏感参数在运行时注入，LLM 永远看不到。Covel 的工具如果涉及数据库操作或外部 API，应实现类似机制。

**Mastra 的工具审批模式**对 RPG 游戏有启发：`requiresApproval: true` 标记的工具在执行前暂停等待确认；`suspendSchema` / `resumeSchema` 定义暂停和恢复时的数据结构。这可以实现"确认使用珍贵道具"的游戏体验。

**对 Covel 的建议：**

- **扩展工具返回值**：参考 AG2 的 ReplyResult，让工具返回值可以附带 `stateUpdates`（Proposal 形式）和 `nextPlugin`（执行路由提示）
- **增加工具审批机制**：部分工具标记为需要玩家确认后才执行，适配 RPG 场景中的关键决策
- **实现工具结果缓存**：参考 CrewAI 的 `cache_function`，对确定性工具（如查询道具信息）缓存结果，减少重复 LLM 推理
- **支持 MCP Server 暴露**：将 Covel 的工具系统通过 MCP Server 对外暴露，使游戏工具可以被外部 Agent 调用

---

## 六、通信模式：SSE 之上的增强

Covel 的 SSE 流式传输和计划中的多传输支持（HTTP+SSE、WebSocket、Stdio）与行业方向一致。OpenCode 和 Codex CLI 都以 SSE 作为核心通信层。

**AG2 的 AG-UI 协议**定义了一套标准化的 Agent → 前端事件类型，值得 Covel 直接采纳：

- `TEXT_MESSAGE_START/CONTENT/END`：流式文本
- `TOOL_CALL_START/END`：工具执行生命周期
- `STATE_SNAPSHOT/STATE_DELTA`：状态同步
- `RUN_STARTED/RUN_FINISHED`：生命周期事件
- `USER_INTERACTION`：人机交互事件

**OpenCode 的双总线架构**提供了优雅的作用域隔离：项目级 Bus（session/message/tool 事件）+ 全局 GlobalBus（服务器/安装事件）。事件使用 `{entity}.{action}` 命名模式，Zod 验证载荷。

**Mastra 的 Writer 模式**让工作流步骤可以直接向前端推送自定义事件：步骤接收 `writer`（WritableStream）参数，Agent 流可以通过 `stream.pipeTo(writer)` 管道化到工作流输出——这对实时展示游戏战斗进程很有价值。

**对 Covel 的建议：**

- **标准化事件类型**：参考 AG-UI 协议，定义 Covel 的标准 SSE 事件类型集合，至少包含：`turn.start/end`、`plugin.start/end`、`tool.call/result`、`state.snapshot/delta`、`llm.token`、`ui.render`
- **增加事件总线抽象**：将 SSE 事件发射统一到内部事件总线，WebSocket 和 Stdio 传输只需订阅同一总线的不同适配器
- **支持 Writer 模式**：让插件在执行过程中通过 writer 推送中间状态和自定义事件到前端

---

## 七、错误处理与可观测性：最需补强的短板

错误处理和可观测性是当前 Agent 框架竞争的关键差异化维度，也是 Covel 描述中信息最少的部分。

**LangGraph 的持久化执行模型**是标杆：失败时仅重执行失败节点（pending writes 保留），任意检查点可恢复，错误可编码为图边（补偿操作或回滚）。结合 LangSmith 提供完整的执行追踪。

**AG2 的 Guardrails 系统**提供了输入/输出双向防护：输入 Guardrail 在消息到达 Agent 前检查（阻止有害请求），输出 Guardrail 在生成后检查（质量控制、敏感信息检测）。支持正则表达式和 LLM 两种检查模式。Guardrail 触发时可重定向到专门的错误处理 Agent。

**Julep 基于 Temporal 的自愈能力**展示了企业级韧性：活动函数内置 `retry_policy` 和 `heartbeat_timeout`，失败步骤自动重试，执行遵循清晰的状态机（queued → starting → running → succeeded/failed/cancelled），声称 99.99% 的执行成功率。

**CrewAI 的优雅降级**值得借鉴：`respect_context_window=True` 自动在上下文溢出时进行摘要压缩；内存保存在后台线程运行，失败仅发射 `MemorySaveFailedEvent` 但不中断执行；并发写冲突通过序列化锁自动重试。

**对 Covel 的建议：**

- **实现分级重试策略**：区分 LLM 调用失败（指数退避重试）、工具执行失败（返回错误上下文给 LLM 重新决策）、状态提交失败（回滚到上一个检查点）三种场景
- **增加 Guardrails 层**：在 LLM 调用前后增加可配置的验证函数。当前 Guard 函数用于条件执行，可以扩展为输入/输出内容检查——例如防止 LLM 生成违反游戏规则的操作
- **引入 OpenTelemetry 追踪**：这是几乎所有成熟框架（AutoGen v0.4、AG2、Mastra、CrewAI）都已采用的标准。为每个回合/插件执行/工具调用生成 span，支持导出到 Jaeger、Langfuse 等后端
- **结构化错误事件**：参考 CrewAI 的事件系统，定义类型化的错误事件（`PluginError`、`ToolError`、`LLMError`、`StateError`），通过事件总线广播，让前端可以展示友好的错误提示
- **插件执行隔离**：确保单个插件的失败不会导致整个回合崩溃。参考 CrewAI 的"任务失败不腐蚀其他 Agent 状态"设计，实现插件级别的错误边界

---

## 八、Covel 的差异化优势总结

对比分析揭示了 Covel 在几个维度**领先于主流开源项目**：

**Proposal → Commit 状态管理**在 10 个项目中是唯一的事务性状态变更模式。LangGraph 的 Reducer、AG2 的 ContextVariables、CrewAI 的 Flow State 都是直接 mutation。Covel 的"先提议再确认"语义提供了更强的一致性保证和审计能力，特别适合 RPG 游戏中需要校验合法性的状态变更。

**PLUGIN.md Markdown 插件定义**是独特的设计。Codex CLI 的 AGENTS.md/SKILL.md 是最接近的方案，但仅用于指令注入，不承载插件元数据和执行配置。Covel 用 frontmatter 定义元数据 + Markdown 体定义 prompt 的方式，同时服务于人类开发者和 LLM。

**json-render 声明式 UI 系统**在对比项目中没有等价物。Rivet 有可视化 IDE 但不生成运行时 UI；其他项目完全不涉及 UI 生成。这对 RPG 游戏框架是关键差异化。

**Guard 函数**是一个被低估的创新。AG2 的 Guardrails 和 LangGraph 的 Conditional Edges 都在解决类似问题，但 Covel 将它定义为"LLM 调用前的条件检查"更加聚焦。建议保持并扩展这一机制。

---

## 九、AI Agent 生态的六大新兴趋势

基于对 10 个项目的分析，以下趋势已形成共识，Covel 应当关注：

**MCP 成为工具互通标准。** 10 个项目中 7 个已支持 MCP（Hermes、Mastra、OpenCode、Codex、LangGraph、CrewAI、Rivet），它已是事实标准。Covel 应优先实现 MCP Client（消费外部工具）和 MCP Server（暴露游戏工具）。

**Agent-to-Agent 协议兴起。** AG2 原生支持 Google 的 A2A 协议，AG-UI 协议标准化了 Agent → 前端通信。跨框架 Agent 互通正在成为现实。

**Observational Memory 代替简单截断。** Mastra 的 Observer/Reflector 模式、Hermes 的四层记忆、OpenCode 的 Compaction + Pruning 表明，上下文管理正从"丢弃旧消息"演进为"智能压缩 + 分层检索"。

**检查点和时间旅行是产品级功能。** LangGraph 的时间旅行调试、CrewAI 的检查点 TUI、Codex 的 session fork/resume 表明，"从任意点恢复"已从调试工具升级为核心产品能力。对 RPG 游戏而言，这就是存档系统。

**Suspend/Resume 实现人机协作。** Mastra、LangGraph、Julep、CrewAI 都在工作流层面支持暂停等待人类输入后恢复。这比简单的"请求-响应"模式更适合需要玩家决策的游戏场景。

**OpenTelemetry 成为可观测性标准。** AutoGen v0.4、AG2、Mastra 内建 OTEL 支持，CrewAI 集成 17+ 可观测平台。对于 Covel 这样的复杂系统，tracing 不再是可选项。

---

## 结论：Covel 的三阶段改进路线

Covel 的核心设计哲学——Markdown 插件、Proposal → Commit、turn-based 执行、json-render UI——在 AI Agent 生态中形成了独特的定位，尤其适合 RPG 游戏的结构化、规则驱动场景。需要补强的主要是基础设施层能力。

**第一阶段（基础强化）**应聚焦检查点持久化（利用现有存储后端）、分层上下文管理（核心/活跃/归档三层）、结构化错误事件和分级重试。这些能力不改变现有架构，但显著提升可靠性和可调试性。

**第二阶段（能力扩展）**应实现 MCP 协议支持（Client + Server）、Suspend/Resume 原语、生命周期钩子系统、OpenTelemetry 集成。这些能力让 Covel 可以接入外部工具生态，支持更复杂的游戏交互模式，并实现产品级的可观测性。

**第三阶段（架构演进）**可以探索图执行层（在 turn-based 之上叠加插件间依赖图）、Observational Memory（后台 Agent 压缩历史）、工具返回值扩展（附带状态更新和路由提示）。这些是更深层的架构变更，需要在前两阶段的基础上审慎推进。**整体上 Covel 的设计直觉是正确的**——它的许多选择（Zod schema、SSE streaming、多存储后端、命名空间隔离）与行业最佳实践高度一致，改进方向是在保持这些优势的同时补齐持久化、压缩和可观测性三根支柱。
# Covel 架构改进方案（代码审计 + 生态交叉验证）

> 本文不是对 `compass_artifact.md` 的延续，而是一次返工。该文的总体方向正确，但过度对齐通用 Agent 框架（LangGraph/Mastra/Julep），忽略了 Covel 真正的定位——**AI RPG 叙事框架**——而这一定位已经有一套成熟生态：SillyTavern、RisuAI、KoboldAI、NovelAI、AI Dungeon。所有建议均以 Covel 现有代码的真实不足为出发点，辅以外部验证。

---

## 一、本次调研结论速记

### 1.1 compass_artifact 中可信的技术事实
| 声明 | 结论 |
|---|---|
| Mastra Observational Memory（Observer 30K / Reflector 40K，LongMemEval 94.87%） | **真**（`mastra.ai/research/observational-memory`） |
| LangGraph Super-Step 边界自动 checkpoint + pending writes 恢复 + `Command(goto, update)` | **真** |
| Mastra Workflow 的 `suspendSchema` / `resumeSchema` 是 **step 级**，非 workflow 级；`requiresApproval` 拼写不准确（真实字段是 `requireApproval`，且仅用于 Agent Network 工具审批） | **部分真** |
| OpenCode 双重压缩：自动 Compaction + Pruning，阈值 `PRUNE_PROTECT=40K / PRUNE_MINIMUM=20K`，保护最近 2 轮用户对话 | **真** |

### 1.2 Covel 代码的真实状态（非设计文档）
| 维度 | 声明/设计 | 代码真相 |
|---|---|---|
| **Token 预算与历史截断** | CLAUDE.md 没提，但 `TurnMessageRecord` 注释承诺"read-time view with truncation" | ❌ **完全没实现**。`packages/context/src/context-builder.ts:206-232` 每回合把 `listTurnMessages()` 的全部历史塞进 prompt。长 session 会线性增长直至 provider 报错 |
| **Compactor / 摘要压缩** | CLAUDE.md 提到 "Compactor handles long-session history compaction" | ❌ **不存在**。类型定义里有空壳，无调用 |
| **Prompt Cache 友好度** | — | ❌ systemPrompt 每回合重组装（world object、player form values、inject 块、locale 注入），前缀不稳定，**无法命中 OpenAI/Anthropic 的 prompt cache** |
| **Hook 生命周期** | CLAUDE.md 承诺 `TurnStart/PreToolUse/PostToolUse/PreStateCommit/PostStateCommit/TurnStop` 6 个 hook | ⚠️ **虚构**。实际只有 `eventBus` 发 `game.turn.started/completed`、`runtime.started/completed/failed` 4 个事件。没有 tool 或 state 级 hook，也无真实订阅用例 |
| **Priority Scheduler + DAG** | CLAUDE.md 说支持 "priority scheduler"（分组并行） | ⚠️ **一半是死代码**。`scheduler.ts:44-129` 有 `extractDependencies()` / `detectCycles()`，但 `turn-executor.ts:221` 只调用 `scheduleByPriority()`，**依赖声明从未被用于重排序或约束调度** |
| **Commit 链 / 事务** | 框架卖点 "Proposal → Commit 事务性" | ❌ **一阶无原子性**。`session-kernel.ts:152-158` 串行 `commitAll()`，中途失败不会回滚已提交的 proposal。commit handler 不做 schema validation（只按类型分发） |
| **Snapshot / Fork / 时间旅行** | Protocol 定义了 `session.fork`，UI 有"存档"设想 | ❌ **只读**。`snapshot-builder.ts` 只做聚合查询。没有 `branches` 表，没有 `state_snapshot` PUT 端点，无法从任意回合 fork 新线 |
| **Suspend / Resume** | — | ❌ 无原语。暂停等待玩家输入完全由前端返回 `interactions[]` 驱动，框架没有"回合挂起到存储、之后恢复"的能力 |
| **错误边界 & 重试** | — | ⚠️ 同优先级组通过 `Promise.allSettled` 做了隔离（`parallel-executor.ts:31`），但 LLM 调用失败**无重试**，流式异常可能被吞（`turn-executor.ts:567`） |
| **Trace / 可观测性** | `trace_events` 表 + Langfuse 可选 | ✅ **真实可用**，但粒度偏粗（请求级），没有 span 层级（turn → runtime → llm → tool），无 OpenTelemetry |
| **MCP 协议** | — | ❌ 零实现，`@modelcontextprotocol/sdk` 未引入 |
| **长期/跨会话记忆** | — | ❌ 仅 `plugin_data` 做 session-scoped KV，**无向量、无 embedding、无 pgvector、无跨 session 记忆** |
| **角色卡资产规范** | 自定义 `characters` 表 + `create-character` builtin tool | ⚠️ **与生态不互通**。SillyTavern/RisuAI/Agnai/Chub 共同使用 Character Card V2/V3（PNG tEXt chunk 或 `.charx` ZIP），Covel 无导入导出 |

### 1.3 compass_artifact 漏掉的 RPG 生态共识
这是本轮返工的关键——作为 RPG 框架，以下机制在 SillyTavern / NovelAI / KoboldAI / RisuAI / AI Dungeon 中已经是**事实标准**，而 compass_artifact 完全没提：

1. **三段式 Prompt 骨架**：`Memory`（顶，永久世界设定） + `World Info / Lorebook`（中段，关键字触发条目） + `Author's Note`（末尾，高权重导演指令）。行业共识：**末尾权重更大**。
2. **Keyword-triggered World Info** 是 RPG 上下文预算的**核心解**：扫描最近 N 条消息，命中的条目才注入。三态激活 `constant / selective / vectorized` 并存。
3. **位置即权重**：所有成熟系统都把 `position`（Before/After Char Defs、`@Depth N`、insertion_order）作为一等参数。不是"是否插入"，而是"在哪插"。
4. **Reserved Tokens + Budget Cap**（NovelAI 最先进）：lorebook 必须有独立预算上限，并**先预留再组装**，防止主历史吃光。
5. **Recursive scanning + Sticky / Cooldown / Delay / Probability**：条目可互相唤醒形成知识图遍历；一旦激活保持 N 轮避免抖动；概率触发做随机事件。
6. **Summarization + Vector Recall 双层长期记忆**（AI Dungeon Memory Bank、RisuAI HypaMemory）：滚动总结 + embedding 召回相关旧片段，几乎是长会话的事实标准。
7. **Character Card V2/V3 可携带规范**：PNG tEXt chunk / CharX ZIP，整个生态跨前端可迁移。
8. **Persona 机制**：把"玩家身份"从角色卡独立出来，可锁定到 chat / character / default 三级。

这 8 条**没有一条在 Covel 现有代码中实现或规划**。

---

## 二、Covel 真正的 P0—P3 改进清单

排序原则：**会立刻崩溃的 > 决定 RPG 体验下限的 > 稳健性 > 生态对齐**。

### P0｜立刻会让长 session 崩的硬伤

#### P0-1 · Context Token Budget & 历史截断（最紧急）
- **现状**：`context-builder.ts:206` 无条件把 `listTurnMessages()` 全量塞入 prompt。一个 30 回合的 session 就能把 128K 窗口挤爆。
- **方案**：在 `buildContext()` 增加：
  - `contextBudget: { maxInputTokens, reservedForSystem, reservedForLorebook, reservedForResponse }`（参考 NovelAI 的 **Reserved Tokens** 思路——先分配再组装）。
  - 消息裁剪采用 OpenCode 的 **Pruning** 策略：保护最近 2 轮 user 消息，仅当总 tool_output > 40K 且可裁剪 ≥ 20K 时才裁剪，裁剪占位为 `[older tool result pruned]`。常量放在 `packages/context/src/budget.ts`。
  - 对 non-tool message 做"从旧往新裁剪"保留 `keepLastN`。
- **验收**：长 session 测试脚本连续跑 50 回合，prompt 输入 token 保持单调有界。
- **不要做**：把截断推到 provider 层。这是 Covel 自己的责任。

#### P0-2 · 自动摘要 Compactor（真正实现，不再空壳）
- **现状**：CLAUDE.md 承诺的 Compactor 不存在。
- **方案**：实现 `packages/context/src/compactor.ts`：
  - 触发条件：当前 prompt 估算 token > `compactThreshold`（默认窗口的 60%）。
  - 调 `fast` slot 生成 "summary block"，替换被摘要掉的旧消息段，**原始消息在 store 保留不动**，仅在发送给 LLM 时使用压缩版本（这是 OpenCode 的关键设计）。
  - 摘要写入 `turn_messages` 的一个新 `role: "summary"` 类型或独立 `summaries` 表。
- **RPG 加强**：借鉴 SillyTavern Summarize Extension 的 "Injection Template"，让每个插件 PLUGIN.md 可声明自己需要的摘要视角（叙事线 / 角色互动 / 事件链）。
- **进阶**：参考 Mastra OM（Observer 30K / Reflector 40K，LongMemEval 94.87% 已验证），作为 P3 再升级为后台 Agent 模式。

#### P0-3 · LLM 调用重试 & 流式异常兜底
- **现状**：`turn-executor.ts:567-605` 流式循环中的异常未 try-catch，可能产生不完整的 `streamedContent`。非流式 `llm.generate()` 异常直接冒泡。
- **方案**：在 `ai-provider` 的 `http.ts` 层加**分级重试**：
  - 429/5xx：指数退避 3 次（现成 `p-retry` 即可）。
  - 流式：捕获后 fallback 到 non-stream 重试一次。
  - 其它：作为 RuntimeResult.failed 返回，允许 `error-retry` trigger 下回合重试。
- **验收**：注入 mock provider 模拟 429，turn 不崩溃。

---

### P1｜决定 RPG 体验下限的差异化能力

#### P1-1 · World Info / Lorebook 子系统（**最重要的 RPG 能力缺失**）
> 这是 compass_artifact 完全漏掉，但**每一个主流 RPG 前端都必备**的机制。

- **动机**：Covel 现在把世界设定整块塞进 `{{ config.worldEntries }}`（来自 `core-world-init` 的 plugin_data）。随着世界复杂度上升，这会吃光预算，而且每回合都注入所有条目——低效且污染上下文。
- **方案**：新建 `packages/lorebook/`（或并入 context 包），实现下列最小可行集：
  - **Entry 模型**：`{ id, keys[], secondaryKeys[], selectiveLogic, content, position, insertionOrder, probability, scanDepth, budgetCap, stickyTurns, cooldownTurns, delayTurns, inclusionGroup, groupWeight, strategy: 'constant'|'selective'|'vectorized' }`。这是 SillyTavern / NovelAI 的最小公集。
  - **Position 枚举**：`before_char_defs | after_char_defs | before_examples | after_examples | author_note_top | author_note_bottom | at_depth:N`。
  - **Scan & Trigger**：每回合开始，对最近 `scanDepth` 条消息做关键字扫描（支持 `/regex/` 和 AND/OR 组合），命中即候选。
  - **Budget allocation**：先为 `constant` 占坑 → 然后按 `insertionOrder` + `groupWeight` 装填 `selective` → 若配了 vector backend 再装填 `vectorized`。预算耗尽就停。
  - **递归扫描**：候选条目的 content 再扫一轮（带 max_recursion_steps）。
  - **Sticky / Cooldown**：用 `plugin_data` namespace 记状态即可，不需要新表。
- **与 Covel 插件模型的融合**：
  - 每个 plugin 在 `PLUGIN.md` 的 frontmatter 可声明 `lorebook: ./lore/*.yaml`，插件独立的 lorebook 随插件装卸。
  - 世界包 `world.yaml` 可以带 `lorebook:` 字段作为全局世界书。
  - 合并顺序参考 SillyTavern：chat lorebook → persona lorebook → character lorebook → world lorebook。
- **不要做**：不要一开始就上向量，先把 constant + selective（关键字）做对。向量是 P2 的事。

#### P1-2 · 三段式 Prompt 骨架 + Author's Note
- **现状**：`buildContext()` 是单块 systemPrompt + 消息历史二分结构。没有末尾高权重注入位。
- **方案**：把 `systemPrompt` 组装拆成命名段（参考 SillyTavern Prompt Manager）：
  ```
  [system-main] [char-defs] [wi-before-char] [scenario] [wi-after-char]
   ...messages...
  [wi-at-depth:N] [author-note @ depth:4] [post-history-instructions]
  ```
  每段都有独立 token budget 和可重排的 order，插件通过 PLUGIN.md 的 `promptSections:` 字段声明要写入哪一段。
- **Author's Note**：加一个全局"导演指令"段，默认注入到倒数第 4 条消息前。插件可以写，runtime 也可以写。这是 RPG 场景里锚定风格和当前目标的关键。
- **收益**：立刻解锁 lorebook 的各种 `position` 选项；同时为 prompt cache 友好化铺路。

#### P1-3 · Working Memory（结构化跨会话状态）
- **动机**：玩家偏好、主剧情进度、长期标志位目前只能塞进消息历史里消耗 token。
- **方案**：新增 `working_memory` 表（或复用 `plugin_data` + 约定 namespace `wm`），存小而结构化的 JSON（Zod schema 验证）。在 prompt 组装时作为 `[system-main]` 的一段注入，格式极简：
  ```
  [Working Memory]
  player.preferences: ...
  story.flags: ...
  ```
- 参考 Mastra 的 Working Memory 设计，**跨 session 持久化**。
- **与 Character Card 的关系**：玩家的 persona 和 preference 属于 working memory，不属于 character record。

#### P1-4 · Prompt Cache 兼容性
- **现状**：systemPrompt 前缀每回合都变，provider 缓存完全不生效。
- **方案**：
  - 把 `[system-main]` 和 `[char-defs]` 两段设计为"每 session 内稳定"——动态值（世界配置、player form）放到 `[scenario]` 之后的段。
  - 给 Anthropic/OpenAI provider adapter 加 `cache_control` 标记能力（Anthropic 是显式标记，OpenAI 是自动前缀匹配）。
  - 跟 P0-2 Compactor 协调：摘要追加为新 block 而非修改旧 block（OpenCode 的做法）。
- **收益**：直接省钱 + 降低 TTFT。

---

### P2｜稳健性与一致性

#### P2-1 · Commit 原子性 + Snapshot 生成
- **现状**：`commitAll()` 串行无回滚；snapshot-builder 只读。
- **方案**：
  - 把 `commitAll()` 包成 DB transaction（PgStore/SqliteStore 都支持），失败整体回滚。内存 store 做 two-phase snapshot。
  - 每个成功的 turn 在 `state_snapshots` 表生成一个快照（仅存 diff + 引用 turnId），体量可控。
  - 同步实现 `POST /api/sessions/:id/fork?fromTurn=N`，用已有 snapshot 建新 session——这就是"存档/读档"。
- **收益**：玩家存档是 RPG 的核心功能，不是调试能力。

#### P2-2 · 清理 Scheduler 死代码或升级为条件边
- **现状**：`extractDependencies` / `detectCycles` 从未被调用。
- **两条路二选一**：
  - **Option A（务实）**：直接删掉，不要误导。scheduler 保持纯优先级分组即可。
  - **Option B（升级）**：真的接入 DAG 排序。插件在 PLUGIN.md 声明 `dependsOn:` 或 `produces:/consumes:`（能力标签），scheduler 按拓扑排序。再加一个 `when:` 条件表达式即可覆盖 LangGraph 的 conditional edges 场景。
- **建议**：先走 Option A 降低认知负担，真的遇到需要时再上 Option B。死代码比没代码更危险。

#### P2-3 · 真正的 Hook 生命周期（对齐 CLAUDE.md 承诺）
- **现状**：只有 4 个 event bus 主题，无 `PreToolUse/PostToolUse/PreStateCommit/PostStateCommit`。
- **方案**：在 `turn-executor.ts` 的关键点真的 emit 这些事件。插件在 `PLUGIN.md` 可声明 `hooks:` 订阅：
  ```yaml
  hooks:
    - event: PreToolUse
      matcher: tool.name == 'create-character'
      handler: ./hooks/validate-character.ts
  ```
- 参考：Codex CLI 的 hooks 设计（外部进程 JSON stdin/stdout）可作为 P3 升级，初期同进程即可。

#### P2-4 · Suspend / Resume 原语
- **动机**：目前"等玩家输入"是靠前端 UI 停在 interactions UI 上，框架层没有概念。结果就是任何"回合中需要玩家决策"都必须拆成多个 turn。
- **方案**：在 Runtime Runner 增加 `kernel.suspend(reason, resumeSchema)` API。实现策略：
  - 调用后序列化当前 turn context 到 `suspensions` 表（turnId、runtimeId、schema、reason）。
  - turn 结束但不 commit proposal（或按阶段提交）。
  - `POST /api/sessions/:id/resume { suspensionId, data }` 反序列化、验证、恢复 runtime 执行。
- 参考：Mastra 的 step-level suspend/resume 机制（已验证）。

---

### P3｜生态对齐 & 长期价值

- **P3-1 · MCP Client/Server**：Covel 的 `tool()` 封装很接近 MCP，适配器薄薄一层。先做 **Client**（消费外部 MCP 工具）价值最大；Server（把 Covel 工具对外暴露）可随后。
- **P3-2 · OpenTelemetry 标准化 trace span**：现有 `trace_events` 表直接映射到 OTel span 结构（turn → runtime → llm → tool 层级）。同时保留 Langfuse 作为一个 exporter。
- **P3-3 · Character Card V2/V3 导入导出**：对接 SillyTavern/RisuAI 生态。实现 `POST /api/characters/import`（接 PNG tEXt chunk 或 `.charx` ZIP），映射到 Covel 的 `characters` 表 + `character_book` 映射到 P1-1 的 lorebook。这打开了一个**现成的 UGC 资产池**。
- **P3-4 · Vector Memory (pgvector)**：上向量召回（embedding 存 `turn_messages`，查询时召回相关片段），作为 lorebook 的 `vectorized` strategy 后端 + 长期记忆召回通道。
- **P3-5 · Observational Memory 化的 Compactor 升级**：把 P0-2 的简单 Compactor 升级为 Mastra 式的 Observer+Reflector 双 Agent。只有在 P0-2 真的被长 session 压力验证之后再做。
- **P3-6 · Persona 系统**：把"玩家身份"从 character record 独立出来，允许 chat-level / character-level lock。这是 SillyTavern 的核心 UX。

---

## 三、Covel 已经做对的事（不要动）

- **Proposal 语义**（尽管目前 commit 不原子，但数据结构方向正确）。加上 P2-1 的事务就变成真正的事务性状态机。
- **PLUGIN.md 承载 prompt + metadata** 是 Covel 最独特的优势，跟 Codex `AGENTS.md` / `SKILL.md` 相比还多了插件执行配置。P1/P2 的 lorebook、hooks、promptSections 都挂在 PLUGIN.md 上即可，不需要另起规范。
- **json-render 声明式 UI**：这是对比的所有 RPG 前端都没有的差异化能力。
- **多存储后端 + 合同测试**：P0/P1 的新表（snapshots、suspensions、summaries、lorebook state）只要加进合同测试套件就行。
- **ai-provider slot 系统**：P0-2 的摘要用 `fast` slot、P3-4 的 embedding 用新增 `embedding` slot，天然契合。

---

## 四、落地顺序建议

**Sprint 1（P0，两周内，不改动架构）**
- P0-1 Token Budget + Pruning 截断
- P0-3 LLM 重试和流式异常兜底
- P2-2 Scheduler 死代码清理（Option A）

**Sprint 2（P0-2 + P1 骨架）**
- P0-2 Compactor（简单版）
- P1-2 三段式 Prompt 骨架 + Author's Note
- P1-4 Prompt Cache 兼容

**Sprint 3（P1 RPG 能力）**
- P1-1 Lorebook 子系统（constant + selective 两态）
- P1-3 Working Memory
- P2-3 Hook 生命周期落地

**Sprint 4（P2 稳健性）**
- P2-1 Commit 事务 + Snapshot + Fork
- P2-4 Suspend/Resume

**Sprint 5+（P3 生态）**
- P3-3 Character Card V2/V3 互通（易出爆点）
- P3-4 pgvector 长期记忆
- P3-1 MCP client
- P3-2 OTel span 标准化
- P3-5 OM 化升级

---

## 五、与 compass_artifact 的分歧

| compass_artifact 的建议 | 本方案的态度 |
|---|---|
| 图执行层 / LangGraph 风格 DAG | **降级到 P2**。先清理现有 dead code；真正需要 conditional routing 时再上。Covel 的回合制对大多数 RPG 场景已经够用 |
| OpenTelemetry 作为基础设施优先级 | **降级到 P3**。Langfuse 已能满足当前需求，OTel 在有业务压力时再做 |
| 把 Observational Memory 作为 P1 方案 | **拆分**：P0-2 是简单 Compactor 先救命，P3-5 才是 OM 升级。Mastra OM 有研究论文加持但也有隐藏成本（两个后台 Agent） |
| Suspend/Resume / Checkpoint / 时间旅行作为同级能力 | **拆分**：Checkpoint/Fork 是玩家存档（P2-1 必做），Suspend/Resume 是插件能力（P2-4），不一定要一起上 |
| **Lorebook / World Info / 三段式 Prompt / Character Card 互通** | compass_artifact **完全没提**，而这是 RPG 场景最迫切的补齐方向。本方案作为 P1 核心 |

---

## 六、一句话总结

> Covel 的定位是 AI RPG 框架，而不是通用 Agent 编排框架。当前代码的真实短板集中在两层：**一是基础健壮性**（token 失控、commit 无事务、scheduler 死代码、hook 虚构），**二是 RPG 专属能力缺口**（没有 lorebook、没有三段式 prompt 骨架、没有 working memory、没有 character card 互通、没有长期记忆）。补前者让框架能活过长 session，补后者让框架在 RPG 生态里有真正的差异化与资产复用能力。通用 Agent 生态的图执行、checkpoint、OTel 都应该往后排——它们重要，但不是 Covel 明天就要面对的问题。

---

## 七、测试分层策略（新增）

> 文档前身完全没讨论测试策略，而"测试慢且不稳"是用户最常抱怨的痛点之一。本节确立 Covel 的测试分层矩阵，并明确**不引入全局 aimock**的理由。

### 7.1 现状事实核对（2026-04-13 盘点）

| 层 | 文件 | 是否打网络 | 默认 `pnpm test` 是否跑 |
|---|---|---|---|
| 单元/集成（85 测试） | `packages/**/tests/*.test.ts`、`apps/server/tests/api/*.test.ts` | ❌ 全部走 `MockLLM` / stub adapter | ✅ 跑，<10 s |
| Live opt-in | `packages/ai-provider/tests/live/{deepseek,dashscope,image-generation}.test.ts` | ✅ 真实 LLM | ❌ `describe.skipIf(!LIVE_LLM_ENABLED)` 默认跳过 |
| 手动脚本 | `scripts/test-real-llm.ts`、`scripts/test-full-3plugins.ts`、`scripts/long-session-50turns.ts` | 视脚本而定 | ❌ 不在 turbo 任务中 |
| Playwright E2E | `tests/e2e/*.spec.ts`（`pnpm e2e:docker`） | ✅ 后端通过 Docker 连真 LLM | ❌ 单独命令，非默认 |

**核心结论**：默认 `pnpm test` **已经快且稳**，`MockLLM` 足够覆盖业务逻辑。真正慢/不稳的是 **E2E Playwright 的后端调用真 provider**。

### 7.2 分层矩阵（决策版）

| 层 | 用途 | Backend | 触发 | 位置 |
|---|---|---|---|---|
| **fake/unit** | 编排、状态机、schema、pipeline、prompt 组装 | `MockLLM` via `@covel/plugin-test-utils` | `pnpm test` | 各包 `tests/` |
| **replay**（新增） | provider HTTP 序列化、`cache_control` 注入、流式分片、fallback | 本地 record/replay fixture | `pnpm test:replay` | `packages/ai-provider/tests/replay/` |
| **live opt-in** | 供应商漂移、真实响应格式、pricing 校准 | 真 LLM | `LIVE_LLM_ENABLED=1` | `packages/ai-provider/tests/live/` |
| **e2e-fake** | 全栈用户流（web-v2 + server + store） | Docker + 注入 `COVEL_FAKE_LLM=1` | `pnpm e2e` | `tests/e2e/` |
| **e2e-live** | 冒烟（release gate） | Docker + 真 LLM | `pnpm e2e:docker` + `.env.llm` | `tests/e2e/` |

### 7.3 关于 aimock 的明确判断

**不引入全局 aimock**。理由：

1. `@covel/plugin-test-utils` 已提供 `MockLLM` 同等能力，业务逻辑测试没有 HTTP 边界可回放。
2. 真正需要"回放"的只有 provider adapter 层（Anthropic `cache_control` 头、OpenAI function_calling 序列化、DeepSeek/Qwen 流式分片），范围极小。
3. 引入第三方 record/replay 库会增加 CI 启动开销与依赖表面积，对 80% 的测试无收益。
4. Covel 自有的 provider `baseUrl` 切换（`validateBaseUrl`、`COVEL_ALLOWED_LLM_HOSTS`）足以把 replay 测试指向本地 HTTP stub server，无需外部 runtime。

**代替方案**：新建 `packages/ai-provider/tests/replay/` 子目录，使用 vitest + 内置 `MockAgent`（undici）或 `msw/node`，fixture 采用 JSON 文件（首次录制后人工校对入库）。

### 7.4 需要补的测试（绑定到剩余 ticket）

| 目标 | 覆盖 ticket | 产物 |
|---|---|---|
| Anthropic `cache_control` 4 breakpoint 注入 | S2-T3 | `tests/replay/anthropic-cache.test.ts` |
| OpenAI / DeepSeek / Qwen 自动前缀缓存（无改动） | S2-T3 | `tests/replay/auto-prefix.test.ts`（断言请求体不变） |
| 流式异常 → non-stream fallback | S1-T3 补测 | `tests/replay/stream-interrupt.test.ts` |
| Compactor 在长 session 下只调 1 次 fast slot | S2-T2 已覆盖 | 扩展既有 `compactor.test.ts` |
| Suspend 序列化 → 反序列化 round-trip | S4-T4 补测 | `packages/runtime/tests/suspend-roundtrip.test.ts` |
| `COVEL_FAKE_LLM=1` 的后端注入开关 | 新基建 | `apps/server/src/ai/fake-provider.ts` + 端到端 smoke |

### 7.5 验收门槛

- `pnpm test` 总时长 ≤ 15 s，覆盖率 ≥ 80%
- `pnpm test:replay` 总时长 ≤ 30 s，零网络
- `pnpm e2e`（FAKE 模式）在 CI 上稳定 green，总时长 ≤ 3 min
- `pnpm e2e:docker`（真 LLM）只在 release pre-check 跑

---

## 八、Sprint 进度账本（progress ledger）

> **硬规则**：每个 ticket 合并时必须在同一 PR 更新此账本。此区块是 session 失忆时的唯一 ground truth。

**最后更新**：2026-04-13（由 `main @ f5540cf` 对照生成）

### 8.1 状态图例
- ✅ merged to main
- 🔧 in review / rebase
- ⏳ not started
- 🚧 blocked（见下方 fix queue）

### 8.2 Sprint 完成度

**Sprint 1 — "不崩" 地基** — 5/5 ✅

| 票号 | 状态 | 备注 |
|---|---|---|
| S1-T1 Tokenizer 基础设施 | ✅ `7f795e0` | — |
| S1-T2 Context budget + Pruning | ✅ `a5e1b42` | — |
| S1-T3 LLM 重试 + 流式兜底 | ✅ `63d0fc6` | P3: stream-interrupt replay 测试待补 |
| S1-T4 Scheduler 死代码清理 | ✅ `4e8251d` | — |
| S1-T5 长 session 压测脚本 | ✅ `d80c08c` + `16e916c` + `1e1bf29` | — |

**Sprint 2 — Prompt 三段式 + Compactor + Cache** — 5/5 ✅

| 票号 | 状态 | 备注 |
|---|---|---|
| S2-T1 三段式 Prompt assembler | ✅ `df820eb` | 段 1/3/5/7 基础；段 9/10 见 S3-T4 |
| S2-T2 Compactor + `session_summaries` | ✅ `cca779c` + `ee6db4d` (I4 fix) | loadPrompt 已就绪 |
| S2-T3 Prompt cache + Anthropic `cache_control` | ✅ `35a0374..0b70cd9` merge `6036141` | PUA sentinel 方案；段 1/3/6 打 3 个 breakpoint；第 4 个 mid-history 留作 FU-5 |
| S2-T4 core-narrator + core-guide 迁 V2 | ✅ `bbf2889` merge Wave B | `promptVersion: 2` 双重 gate；6+6 parity tests；V1/V2 语义等价 |
| S2-T5 `prompt-structure.md` 文档 | ✅ `a3618ec` merge Wave C | 10 段结构 + 迁移 playbook + 已迁移插件清单 |

**Sprint 3 — Lorebook + Working Memory + Author's Note** — 6/6 ✅（S3-T2 含 FU-8 double-write 兜底）

| 票号 | 状态 | 备注 |
|---|---|---|
| S3-T1 Lorebook 核心 | ✅ `4dec3b5` | — |
| S3-T2 core-world-init 迁 Lorebook | ✅ `4ebf79a` + `207307c` (store/runtime) + `85d0d8a..347428b` (插件 double-write + context-builder) merge Wave B/C | Store + commit handler + snapshot FU-4 + `set-world-entries-batch.js` 双写 lorebook + plugin_data；context-builder `{{ config.worldEntries }}` lorebook-first fallback，通过 `world-data-provider` capability 发现插件 id，无硬编码 |
| S3-T3 Working Memory 表 + 段 2 | ✅ `916cba6` + `fe0264d` (B1) | WM 实际 inject 到 context |
| S3-T4 段 9/10 Author's Note + Post-History | ✅ `9bcb0ee..e1a3997` merge `973c112` | RuntimeManifest 加 authorsNote / postHistory；14 + 9 新测试 |
| S3-T5 其余 core 插件 V2 迁移 | ✅ `85d0d8a..347428b` merge Wave C | 5a: codex (6 parity) + char-creator 双 runtime (12 parity)；5b: world-init 并入 S3-T2 |
| S3-T6 Lorebook 玩家 UI | ✅ `7e5387a..556b0b2` merge Wave C | `GET/PATCH/DELETE /api/sessions/:id/lorebook`；React 右面板 tab；11+5 新测试 |

**Sprint 4 — 稳健性** — 5/5 ✅

| 票号 | 状态 | 备注 |
|---|---|---|
| S4-T1 Commit 事务 | ✅ `e942fce` + `ce56048` | — |
| S4-T2 Snapshot + Fork API | ✅ `80ff240..a74ac9a` merge `ed42b9f` | 4 backends + 8 contract tests + auto snapshot @ turn-executor.ts:428；fork = copy 策略；CLAUDE.md 20 → 21；session.forked 加入 ProtocolEventType；lorebook FU-4 在 S3-T2 合一起做 ✅ |
| S4-T3 Hook lifecycle pipeline | ✅ `c0bb9ed` + `627787d` + `87ed8d8` | — |
| S4-T4 Suspend/Resume 原语 | ✅ `f5540cf` + `07c5fd6` (M4) | — |
| S4-T5 SSE 协议扩展 + 文档同步 | ✅ `9114802..c00d108` merge | `state.snapshot.created` 加入 union + 3 emit 点；`stream.interrupted/resumed` 延迟为 FU-7 |

**Sprint 5 — 生态长尾** — 0/5 ⏳

全部未启动（S5-T1..T5）。

### 8.3 Fix queue

**Wave 2 发现的 8 项已全部在 Wave 0 清空（2026-04-13）**：

| 编号 | 严重度 | 位置 | 修复 commit | 备注 |
|---|---|---|---|---|
| **B1** | BLOCKER | `packages/runtime/src/turn-executor.ts` | `fe0264d` → merge `8e65a75` | `listWorkingMemory()` probe-then-call，`COVEL_WORKING_MEMORY_V1` 控制段 2 注入；3 个新注入测试 |
| **B2** | BLOCKER | `apps/server` vitest workspace | 无代码改动 | 合并后重现，`pnpm install` 即恢复。**根因**：stale node_modules/workspace symlink。已记入 §八.5 |
| **I1** | IMPORTANT | `CLAUDE.md` | `5b26cea` → merge `6a52728` | 18 → 20 tables，列表补 `session_summaries` / `suspensions` |
| **I2** | IMPORTANT | `docs/reference/protocol.md` | `5b26cea` | 补 `turn.suspended` / `turn.resumed`。**重要发现**：`working_memory.changed` / `context.compacted` 实为 KernelEvent / trace-only，**不在** `ProtocolEventType`——已标注"kernel-only"。promote 到 SSE 是否必要 → 见 §八.6 follow-up |
| **I3** | IMPORTANT | `docs/reference/api.md` | `5b26cea` | 补 resume / suspensions 3 个路由 |
| **I4** | IMPORTANT | `packages/context/src/compactor.ts` | `a069c34` → merge `ee6db4d` | 新增 `packages/context/src/prompts-loader.ts`（`loadPrompt` + `interpolate`，此前整个仓库仅在 CLAUDE.md 有规范未实现）；compactor 改走 `loadPrompt('server','compactor',locale)`；md 文件以 inline 为 ground truth 重写；4 个新外部化测试 |
| **I5** | IMPORTANT | `docs/reference/tools.md` | `5b26cea` | 补 `suspend` builtin + `working_memory.set` proposal + 完整 11 项 ProposalType 列表 |
| **M4** | MINOR | `apps/server/src/routes/api/resume.ts` | `0afe002` → merge `07c5fd6` | `GET /suspensions` flag off → 503，对齐兄弟路由格式 |

**Wave 0 验证**：`pnpm test` 20/20 包绿，`pnpm lint` 16/16 包绿。

### 8.4 Progress ledger 更新规则

1. 每个 ticket 合并时在 `feat:...` commit 中同时修改 §八.2 对应行：`⏳` → `✅ <short-sha>`
2. 每次 unified review 结束时把发现清单追加到 §八.3
3. Fix queue 清空时把 §八.3 归档到 `devs/docs/insights/fix-queue-archive/YYYY-MM-DD.md`
4. CI gate：PR 若改动 `packages/`、`apps/server/` 但未修改本文档的 §八.2 视为未完成（后续加 danger.js / github action）

### 8.5 Wave 0 经验教训（供 Wave A 及后续参考）

1. **合并后必须 `pnpm install`**：多个 worktree 平行开发 + 后合并时，pnpm workspace symlink 会漂移。Stream B 在 `.worktrees/server-test-fix` 里测试原本就绿（所以报告 B2 无需修复），但 4 个 branch 合到 main 后 `apps/server` 测试报 `Cannot find package '@covel/context'`——root cause 是 main worktree 的 `node_modules` 未刷新，而非代码问题。`pnpm install` 后立刻 103/103 绿。**下一个 wave 合并完成务必先 `pnpm install` 再跑测试**。
2. **同一文件的多 branch 修改不会冲突但会漂移**：`packages/context/src/index.ts` 被 Stream A（export `WorkingMemoryEntry`）和 Stream D（export `loadPrompt` / `interpolate`）同时修改，`git merge` 自动合并成功。验证合并结果仍然 tsc 干净即可。
3. **"worktree 里绿"不等于"merge 后绿"**：Stream B 报告 B2 无需修复是**真实**的——它的 worktree 自包含，但一旦换 host worktree 就可能再现。Wave 的 unified review 必须以 main 为准，不能信 stream self-report。
4. **跨 worktree 搭脚手架**：`apps/web/src/routeTree.gen.ts` 是 gitignore 的生成产物，worktree install 后需要从主 worktree 复制（已在每个 stream prompt 里说明，实际执行 OK）。

### 8.6 Wave 0 发现的 follow-up（非阻塞）

| 编号 | 说明 | 触发 ticket |
|---|---|---|
| FU-1 | **`working_memory.changed` / `context.compacted` → SSE 提升**？当前只是 KernelEvent / trace。若要前端实时反应 WM 与压缩事件，需把这 2 个字符串加入 `packages/shared/src/types/protocol.ts` 的 `ProtocolEventType` union 并接入 SSE forwarder。**决策点**：前端是否真的需要实时感知？如果是——在 Wave A 的 S4-T2 或 S3-T4 顺手做（+5 行）。如果否——更新 §七文档标注为 "kernel-internal by design" 即可 |
| FU-2 | **Compactor locale 管道**：I4 修复把 locale 参数留在 `maybeCompact()` 签名上，但 `CompactorRunner.run()` 还没 plumbing session locale。需扩展 runner 签名从 session context 提取 locale。半天工作量，可顺手并入 Wave A 的 S2-T3（反正 S2-T3 要动 compactor）|
| FU-3 | **loadPrompt 推广**：`apps/server/src/routes/api/ai.ts`（generate-world / extract-dimensions）仍然内联 TS template literal。Wave 0-D 创建的 `loadPrompt` 第一次真正可用，这些 server 路由 prompt 都可以迁移。非阻塞，可作为 Sprint 5 清理票 |
| FU-4 | **Lorebook list API**：S4-T2 fork 需要 `listLorebookEntries(sessionId, { source: 'session' })` 但 `@covel/lorebook` 的 store 接口还没加。当前 snapshot.lorebookEntries 是空数组 TODO。需要在 `@covel/store` / `@covel/lorebook` 加 `listSessionLorebookEntries`，然后回填 `snapshot-payload-builder.ts`。Wave B 顺手（<30 行），或在 S3-T2 world-init 迁移时一起做 |
| FU-5 | **S2-T3 第 4 个 Anthropic breakpoint**：`§A15` 规定 4 个 breakpoint，其中 "段 7 中部"（messages 中段）需要 turn-executor 改动。A-1 留作 follow-up，因为 S2-T3 scope 不碰 runtime。Wave B / Wave C 顺手 |
| FU-6 | **Wave A-3 session.forked SSE 前端消费**：后端已发 SSE 事件，但 `apps/web-v2/src/services/sse.ts` 未 `addEventListener('session.forked', ...)`，等 fork UI（Sprint 5 或 S3-T6）实装时再接。S4-T5 把 `state.snapshot.created` 加进同一组，前端挂载时一次性接 2 条 |
| FU-7 | **流式重试事件未接 SSE**：`packages/ai-provider/src/adapters/http.ts:postJson` 的 S1-T3 retry 路径是**静默** fallback，没有 callback / event hook。S4-T5 调研后确认无法在不改 ai-provider gateway 的前提下接出 `stream.interrupted` / `stream.resumed`。需在 `gateway.ts` / `context-builder` 层插一个 EventBus 注入点（或回调），让 retry 触发时通过 turn-executor 的 `eventBus` 广播。Wave B 或 Sprint 5 单独处理。本 ticket **未** 把这两个 type 加入 `ProtocolEventType`，等真有发射点再加 |
| FU-8 | **`core-world-init` 插件迁移到 `lorebook.upsert`**：Wave B-1 agent rate limit 在 store 层完成后中断；runtime commit handler + snapshot FU-4 wiring 由主干补齐。还缺最后一步：`plugins/core-world-init/server/*.ts` 的 schema-gen runtime 改为 emit `lorebook.upsert` proposal（而非写 plugin_data），`packages/context/src/context-builder.ts` 把 `{{ config.worldEntries }}` 的值源从 plugin_data 改为 `listSessionLorebookEntries`。单文件级别的插件改动，Wave C 顺手或 Sprint 5 清理即可 |

### 8.4 Progress ledger 更新规则

1. 每个 ticket 合并时在 `feat:...` commit 中同时修改 §八.2 对应行：`⏳` → `✅ <short-sha>`
2. 每次 unified review 结束时把发现清单追加到 §八.3
3. Fix queue 清空时把 §八.3 归档到 `devs/docs/insights/fix-queue-archive/YYYY-MM-DD.md`
4. CI gate：PR 若改动 `packages/`、`apps/server/` 但未修改本文档的 §八.2 视为未完成（后续加 danger.js / github action）

---

## 九、并行 Wave 调度图（parallel waves）

> 补齐规划缺的"哪些 ticket 可以并行"指引。规则：wave 内 ticket 完全独立；wave 之间严格串行；每个 wave 结束汇合到 main 做统一 review。

### 9.1 前置：清 Fix queue

**Wave 0（必须最先做）**：

| Stream | 任务 | 工作树 |
|---|---|---|
| A | B1 Working Memory inject 到 turn-executor context | `.worktrees/wm-inject` |
| B | B2 vitest workspace resolution + M4 503 返回 | `.worktrees/server-test-fix` |
| C | I1+I2+I3+I5 文档同步 | `.worktrees/wave2-docs` |
| D | I4 Compactor prompt 外部化决策 | `.worktrees/compactor-prompt` |

Wave 0 全绿后再启动 Wave A。

### 9.2 Wave A（3 票并行，完全独立）

| 票号 | 工作树 | 关键文件 | 依赖 |
|---|---|---|---|
| S2-T3 Prompt cache + Anthropic cache_control | `.worktrees/s2-t3-cache` | `ai-provider/src/adapters/anthropic.ts`、新增 `cacheStrategy` 字段 | S2-T1 已完 |
| S3-T4 Author's Note 段 9 + Post-History 段 10 | `.worktrees/s3-t4-author-note` | `packages/context/src/prompt-assembler.ts` 补段 8/9/10 | S2-T1 已完 |
| S4-T2 Snapshot 表 + Fork API | `.worktrees/s4-t2-snapshot` | 新表 `state_snapshots`、新端点 `/fork` `/snapshot` | S4-T1 + **S3-T3 B1 修好** |

### 9.3 Wave B（依赖 Wave A 全绿）

| 票号 | 依赖 | 说明 |
|---|---|---|
| S3-T2 core-world-init 迁 Lorebook | Wave A 完 + S3-T1 | **合并 S3-T5b** 一起做，world-init 只迁一次 |
| S2-T4 core-narrator + core-guide 迁 V2 | Wave A 的 S2-T3 | cache 注入需要 V2 路径 |
| S4-T5 SSE 协议扩展 | Wave A 的 S4-T2 | `session.forked` 事件需要 fork 路由已 ready |

### 9.4 Wave C（依赖 Wave B）

| 票号 | 依赖 | 说明 |
|---|---|---|
| S3-T5a core-codex + core-char-creator 迁 V2 | Wave B 完 | 不碰 world-init（已在 S3-T2 完成） |
| S3-T6 Lorebook 玩家 UI (`web-v2`) | Wave B 完 | 依赖 `/api/ui-specs` |
| S2-T5 `prompt-structure.md` 文档 | Wave A+B 完 | 模式已稳定 |

### 9.5 冲突守卫（critical）

1. **`core-world-init` 只迁一次**：把 S3-T5 拆成 S3-T5a (codex+char-creator) 和 S3-T5b (world-init)，S3-T5b 并入 S3-T2 的同一 PR。规划表里 §附录 B 的 S3-T5 描述应同步改。
2. **`core-narrator` 不双写**：S2-T4 先做 V2 迁移；任何后续票若需要 narrator 读 lorebook，走 S3-T5a 的同一 PR。
3. **`turn-executor.ts` 热点文件**：S4-T2 `Snapshot` 需要在 `postCommit` 插 snapshot 写入点；S4-T5 需要发 SSE——两者都动 `turn-executor.ts` 的相邻行，要求 S4-T2 先合再起 S4-T5。
4. **`prompt-assembler.ts` 段扩展**：S3-T4 和 S2-T3 都改它，但段位不重叠（S3-T4 加段 9/10，S2-T3 只加 `cache_control` 标记）——可并行但 rebase 时注意。

### 9.6 Wave 执行规则（承自本 session 已验证模式）

1. 每个 wave 在开始前从 main 拉最新，创建 worktree + 独立 branch
2. Wave 内每个 stream 一个 subagent 执行，skip 子分支 spec/code review（用户指令）
3. Stream 完成直接 merge 到 main（no PR），merge 顺序任意
4. 整个 wave 合并完后在 main 跑 **一次统一 review**（spec compliance + code quality + security + doc drift）
5. Review 发现写入 §八.3 fix queue，下一个 wave 启动前必须清空
6. 每次 merge 必须同步更新 §八.2 进度表

### 9.7 Wave D（Sprint 5 生态层，非阻塞）

S5-T1 (Character Card) / S5-T2 (MCP) / S5-T3 (pgvector) / S5-T4 (OTel) / S5-T5 (OM 升级) 互相独立，且与 Wave A/B/C 无文件冲突（新包为主），可在任意时机与 Wave B/C 并行启动。优先级应在 Wave C 完成后由业务决定，不走本文档强制排序。

---

# 附录 A：奠基决策（回答 spec self-review 的 17 个问题）

下列决策是后续所有 P 项实现的共同地基。每条 = 决策 + 理由 + 影响面。

## A1. Tokenizer 策略（回答 #1）

**决策：** 使用 `gpt-tokenizer` npm 包（纯 TS、ESM 原生、零依赖）以 `cl100k_base` 为本地同步估算器，并按 slot 套安全系数。

**具体实现：**
- 新文件 `packages/ai-provider/src/tokenizer.ts` 暴露单一函数 `estimateTokens(text: string, slot?: string): number`
- 内部逻辑：`tokenize(text, 'cl100k_base').length * safetyMultiplier[providerOfSlot]`
- 安全系数表（根据官方数据偏差 + 10% 余量）：
  - `openai` / default: `1.0`（cl100k 对 GPT 模型精确）
  - `anthropic`: `1.25`（官方建议值，对应 Claude tokenizer 的约 15–20% 偏差）
  - `deepseek` / `qwen`: `1.35`（中文为主模型的偏差可达 30%+）
- **所有预算代码都用估算值**。跨 provider 切换无需重新计算。
- 精确计数（Anthropic 的 `/v1/messages/count_tokens` 或 OpenAI 的 `usage` 回传）**不走预算决策**，只用于 trace 和 logging。

**理由：** 原因已列明（调研项 6）。精确 API 需要网络往返，不能用于每回合的 prompt assembly 决策。15–35% 的安全余量是可接受的工程代价。

**影响面：** P0-1 (budget)、P0-2 (compaction trigger)、P1-1 (lorebook budgetCap)、P1-4 (cache split points) 全部依赖此 API。

---

## A2. Prompt 三段式的归属模型（回答 #2）

**决策：** **Session 级三段式外壳 + Plugin 级指令段**。PLUGIN.md 正文仍然是每个插件自己的 system prompt，但它被包装在 session 级的外壳内。

**Assembly 最终形态（每次 LLM 调用）：**
```
[1 Framework Preamble]        ← session 稳定（游戏规则、locale、世界标题）
[2 Working Memory]            ← session 稳定+慢变（玩家偏好、长期标志位）
[3 Plugin Instructions]       ← PLUGIN.md 正文，per-plugin 稳定
[4 WorldInfo: before-plugin]  ← 关键字触发（constant + selective）
[5 Injects from upstream]     ← 动态（本回合上游 runtime 的输出）
[6 WorldInfo: after-plugin]   ← 关键字触发
---- messages ----
[7 history (after pruning)]   ← 动态
[8 WorldInfo: at-depth:N]     ← 插在倒数第 N 条消息前
[9 Author's Note]             ← 深度 4，session+plugin 可写
[10 Post-History Instructions]← 导演级高权重指令
```

**为什么这样设计：**
- 1 + 3 是 session 内稳定的，适合作为 prompt cache 前缀。
- 2 是"慢变"的，放在缓存段外但紧邻，平衡精度与命中率。
- 4 / 5 / 6 / 8 / 9 是动态的，不进缓存。
- Plugin 无需重写：已有的 PLUGIN.md 正文原封不动填入段 3。

**PLUGIN.md 扩展（向后兼容）：**
```yaml
promptVersion: 2               # 未声明默认为 1，走老路径
authorsNote:                   # 可选
  content: "{{template}}"
  depth: 4
  role: system
summaryFocus:                  # 供 Compactor 使用，见 A5
  - "主角的情绪线"
  - "当前目标进度"
```

**理由：** 保留"每个插件是独立 LLM 调用"的 Covel 架构（这是它的核心设计），只在组装层加一层外壳，不改变 runtime runner 和 tool loop 的任何现有逻辑。迁移成本最低。

**影响面：** P1-2（新设计）、P1-4（cache 划分）、P1-1（position 注入点）、P2-3（hook 位置）。

---

## A3. Lorebook 的归属、CRUD、生命周期（回答 #3）

**决策：三层归属 + 两种 CRUD 模式**

| 层 | 存储 | 生命周期 | 谁能写 |
|---|---|---|---|
| **World-level** | `worlds/<id>/lorebook/*.yaml` 文件 | 世界包的一部分，启动时加载，**运行时只读** | 世界包作者（手写 YAML） |
| **Plugin-level** | `plugins/<id>/lorebook/*.yaml` 文件 | 随插件装卸，**运行时只读** | 插件作者（手写 YAML） |
| **Session-level** | 新表 `lorebook_entries(sessionId, entryId, source, ...)` | 随 session 生灭，可读可写 | 插件通过 Proposal `lorebook.upsert` / 玩家 UI 直接编辑 |

**合并顺序（从低到高优先级，后写入的越靠近 prompt 末尾）：**
`world → plugin → session(imported) → session(runtime-written) → session(player-edited)`

**`core-world-init` 的迁移路径：**
- 现状：它把世界维度作为一整块 `worldEntries` 字符串注入到 `{{ config.worldEntries }}`。
- 目标：它仍然负责 LLM 生成世界维度，但**写出的结果通过 `lorebook.upsert` 进入 session-level lorebook**，每个维度成为一条 `constant` 条目（保持现有语义）。
- 过渡期：保留 `{{ config.worldEntries }}` 模板变量，值改为从 session-level lorebook 拼接；插件不用改。

**Schema（P1 范围内，vectorized 字段不纳入——见 A4）：**
```ts
interface LorebookEntry {
  id: string
  source: 'world' | 'plugin' | 'session'
  pluginId?: string                   // source = plugin 时
  keys: string[]                      // 关键字触发词
  secondaryKeys?: string[]
  selectiveLogic: 'and_any' | 'and_all' | 'not_any' | 'not_all'
  content: string                     // 最终注入的文本
  strategy: 'constant' | 'selective'  // P1 仅二选一
  position: LorebookPosition          // 见 A2 的段位
  insertionOrder: number              // 同段位内排序
  budgetCap?: number                  // 本条 token 上限
  probability?: number                // 0-1，selective 用
  scanDepth?: number                  // selective 用：往回扫几条消息
  stickyTurns?: number
  cooldownTurns?: number
  delayTurns?: number
  enabled: boolean
  inclusionGroup?: string
  groupWeight?: number
}
```

**预算分配算法（借鉴 NovelAI Reserved Tokens）：**
1. 为 `constant` 条目预留 token；不够则警告并截断末位条目。
2. 扫描最近 `scanDepth` 条消息（每条目各算），收集命中的 `selective` 候选。
3. 递归扫描：候选的 content 再做一轮关键字匹配，直到 `maxRecursionSteps`（默认 3）。
4. 按 `inclusionGroup` 去重（同组按 `groupWeight` 抽签选一）。
5. 按 `insertionOrder` 填入，遇预算耗尽即停。
6. 更新 sticky/cooldown 状态到 `plugin_data` 下的 `__lorebook_state__` namespace（无需新表）。

**影响面：** P1-1 新建、`core-world-init` 迁移、`buildContext` 加 lorebook pass、`docs/reference/plugins.md` 说明加载路径。

---

## A4. Vectorized 从 P1 移除（回答 #4）

**决策：** Schema 的 `strategy` 枚举在 P1 中就是 `'constant' | 'selective'` 两个值。P3 加向量召回时**再扩展枚举**为 `| 'vectorized'`，不是 P1 留位、P3 填实现。

**理由：** 留位但不实现会让插件作者误写 `strategy: 'vectorized'`，静默无效。Schema 显式就是契约。

---

## A5. Compactor 的粒度与成本（回答 #5）

**决策：Session 级共享摘要 + 插件级 focus 提示**。一次触发只产生一次 LLM 调用。

**触发条件：** 当前估算 token（A1 的 `estimateTokens`）超过 `contextBudget.compactThreshold`（默认为 slot contextWindow 的 60%）。

**压缩输入：** 从最旧一条消息开始，取到 "保护最近 2 轮 user 消息且不触碰最近 5 条" 为止。剩下的交给摘要 LLM。

**摘要生成：**
- 用 `fast` slot
- System prompt 固定："你是叙事摘要器。按下列 sections 分块输出。保留名称、数字、因果链，不要解释。"
- 用户 prompt 组装：所有启用插件的 `summaryFocus` 字段汇总成一个 `sections:` 清单（去重），然后附上要压缩的消息。
- 输出：单个结构化文本块，按 section 划分。

**持久化：**
- 原始 `turn_messages` **不删**，只标 `compactedAtTurnId`。
- 摘要写入新表 `session_summaries(sessionId, turnRange, content, focusSections, createdAt)`。
- `buildContext` 读消息历史时，遇到已被标记压缩的区段就用对应的 session_summary 替代。

**成本：** 一次 summary LLM 调用约等于一次普通插件回合的成本，但发生在"每 N 回合一次"而不是"每回合每插件一次"。实测 N 预期 ≥ 20。`fast` slot（通常是 Haiku / DeepSeek-chat）比主叙事 slot 便宜一个数量级。

**影响面：** 新增 `packages/context/src/compactor.ts`、新表 `session_summaries`、`buildContext` 多一次 pass。

---

## A6. Snapshot / Fork 的具体 Schema（回答 #6）

**决策：物化快照，不走事件溯源。**

**表结构：**
```sql
CREATE TABLE state_snapshots (
  id            UUID PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  payload       JSONB NOT NULL,  -- 整份 state 拷贝
  parent_id     UUID NULL,       -- fork 时指向源 snapshot
  kind          TEXT NOT NULL    -- 'auto' | 'manual' | 'fork'
);
```

**payload 内容：**
```ts
interface SnapshotPayload {
  schemaVersion: 1
  turnId: string
  characters: CharacterRecord[]
  stateEntries: StateEntryRecord[]
  pluginData: PluginDataRecord[]
  workingMemory: WorkingMemoryRecord[]       // 见 A9
  lorebookEntries: LorebookEntry[]           // 仅 source='session' 的
  messagesCursor: string                     // 最后一条 turn_message 的 id
}
```

**语义：**
- `auto` 快照：每 turn 结束自动生成（命中 feature flag 后）。
- `manual` 快照：玩家点"存档"按钮触发。
- `fork` 快照：`POST /api/sessions/:id/fork?fromSnapshotId=X` 创建新 session，新 session 的所有 turn_messages 到 `messagesCursor` 位置被拷贝（或用 session reference，实现看收益）。

**为什么不做事件溯源：** Covel 的 state 涉及 `characters`（schemaless JSON）、`state_entries`（dynamic tables）、`plugin_data`（KV），重放成本高、一致性陷阱多。JSONB 物化快照在 PG 下有透明压缩，session 总规模可控（典型 RPG session 的 state < 1MB）。

**影响面：** P2-1 新建、`fork` 路由新增、`datastore` 接口加 `saveSnapshot/loadSnapshot` 方法、contract test 补一组。

---

## A7. Suspend / Resume 的粒度与再入语义（回答 #7）

**决策：Runtime 边界粒度。** 不进入 tool loop 内部断点续传。

**触发方式（两种，任选其一）：**
1. **Function runtime** 直接返回 `{ status: 'suspended', reason, resumeSchema, partialProposals }`。
2. **Agent runtime** 内工具通过返回值标记：`tool.suspend({ reason, schema })`——runtime runner 捕获后中止 tool loop，把截止当前的所有 tool_call/tool_result 打包成 `pendingContinuation` 存入 suspensions 表。

**持久化：**
```sql
CREATE TABLE suspensions (
  id                  UUID PRIMARY KEY,
  session_id          TEXT NOT NULL,
  turn_id             TEXT NOT NULL,
  runtime_id          TEXT NOT NULL,
  plugin_id           TEXT NOT NULL,
  reason              TEXT NOT NULL,
  resume_schema       JSONB NOT NULL,  -- Zod schema 序列化
  pending_continuation JSONB NOT NULL, -- 已完成的 tool_calls + LLM 已生成内容
  created_at          TIMESTAMPTZ NOT NULL,
  resolved_at         TIMESTAMPTZ
);
```

**Resume 流程：** `POST /api/sessions/:id/resume { suspensionId, data }` →
1. 校验 `data` 对 `resume_schema` 有效；
2. 把 `data` 作为新的 `tool_result` 或 `user message` 追加到 `pending_continuation`；
3. 重新进入 LLM tool loop（从 LLM 端看就是"收到工具结果，继续决策"）；
4. 不重放已完成的 tool call。

**不处理：** Provider API keys 不落库。Resume 需要玩家仍然在浏览器侧保留 keys（现有 `X-Provider-Keys` header 机制不变）。若 key 丢失，resume 失败并回退为 pending 状态。

**影响面：** P2-4 新建、`ai-provider` 加 `tool.suspend` sentinel、`turn-executor` 加 suspension path、新增 SSE 事件 `turn.suspended`/`turn.resumed`。

---

## A8. 向后兼容：feature flag `COVEL_PROMPT_V2`（回答 #8）

**决策：渐进式开关，不做一次性大迁移。**

| 阶段 | 动作 | 现有插件影响 |
|---|---|---|
| 0 | P0 完全追加式（budget、pruning、retry）。不改 systemPrompt 结构 | 零 |
| 1 | 引入 `COVEL_PROMPT_V2` 环境变量，默认 `off`。v2 走三段式，v1 走老逻辑。PLUGIN.md 新增 `promptVersion: 2` 字段可逐插件切换 | 零（不声明就走 v1） |
| 2 | 核心插件（core-narrator / core-guide / core-codex / core-world-init / core-char-creator）逐个迁移到 v2 | 逐个迁移 |
| 3 | 文档宣布 v1 deprecated，保留 1 个 minor release | 提醒作者升级 |
| 4 | 下个 minor 删除 v1 代码路径 | 需全部升级 |

**验证点：** 同一世界 + 同一插件集，v1 和 v2 的 LLM 输出语义相同（小偏差允许，用 snapshot 测试确认核心字段稳定）。

---

## A9. Working Memory：新独立表（回答 #9）

**决策：新表 `working_memory`，不复用 `plugin_data`。**

**Schema：**
```sql
CREATE TABLE working_memory (
  id           UUID PRIMARY KEY,
  session_id   TEXT NOT NULL,
  key          TEXT NOT NULL,
  scope        TEXT NOT NULL,    -- 'player' | 'story' | 'shared'
  value        JSONB NOT NULL,
  schema_ref   TEXT,             -- 关联的 Zod schema 名
  updated_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, scope, key)
);
```

**与 `plugin_data` 的关键差异：**
- **Framework 级读写**，不按 plugin 隔离。所有插件的 prompt 组装中都会被注入到 `[Working Memory]` 段。
- **写入走 Proposal**（`working_memory.set`），进入 commit chain，有事务保证。
- **每次 turn 都被读取**（贴近 "core context"），`plugin_data` 是按需读取。
- **schema_ref** 强制类型：framework 在 commit 前做 Zod 校验。

**注入格式（段 2）：** 结构化 YAML 视图，不是原始 JSON：
```yaml
[Working Memory]
player.preferences: { tone: "dark", pacing: "slow" }
story.flags: { metMentor: true, questLog: ["rescue_sister"] }
```

**影响面：** 新表、新 Proposal 类型、`buildContext` 组装 [2] 段、`datastore` 接口扩展。

---

## A10. 流式重试的 UX 策略（回答 #10）

**决策：已流式内容不回滚，只补齐尾部。**

**实现：**
1. 流式过程中累计 `streamedContent`（现有逻辑）。
2. 中途异常 → 捕获，发 SSE `stream.interrupted`。
3. 用**非流式** call 只请求"基于已有前缀继续输出"——具体做法：把已流式内容作为 assistant partial 消息，要求 LLM continue。
4. 收到结果后直接 append 到 `streamedContent`，发 SSE `stream.resumed`。
5. 前端感知这两个事件，UI 上显示"重连中..."提示 2-3 秒，然后继续 append 文字。

**影响面：** `ai-provider/http.ts`、`turn-executor.ts` 流式路径、`docs/reference/protocol.md` 加两个事件。

---

## A11. Hook 执行模型（回答 #11）

**决策：同步、有序、可中止的 pipeline，对齐 OpenCode。**

**Hook 签名：**
```ts
interface HookHandler<Payload> {
  (ctx: HookContext, payload: Payload): Promise<HookResult<Payload>>
}

type HookResult<P> =
  | { action: 'continue' }
  | { action: 'continue'; replace: Partial<P> }  // 修改 payload
  | { action: 'abort'; reason: string }          // 中止本阶段
```

**执行顺序：** 全局 hooks → plugin hooks（按 manifest 声明顺序）。

**失败处理：**
- Hook 抛异常 = `abort`，本 turn 阶段中止（e.g. `PreToolUse` 阻止工具执行）。
- `abort` 产生 RuntimeResult.failed，不 crash 整个 turn。

**Hook 类型（P2-3 范围）：** `TurnStart / PreRuntime / PostRuntime / PreToolUse / PostToolUse / PreStateCommit / PostStateCommit / TurnStop`。

**PLUGIN.md 声明：**
```yaml
hooks:
  - event: PreToolUse
    match: { tool: "create-character" }
    handler: ./hooks/validate-character.ts
```

**影响面：** P2-3 新建 `packages/hooks/`（或纳入 `packages/runtime/src/hooks/`）、`turn-executor` 每阶段调用 pipeline、event-bus 保留作为 observability 通道（hooks ≠ events）。

---

## A12. MemoryStore 事务（回答 #12）

**决策：基于 `structuredClone` 的两阶段快照。**

**实现：**
```ts
begin() { this.shadow = structuredClone(this.tables) }
commit() { this.shadow = undefined }
rollback() { this.tables = this.shadow!; this.shadow = undefined }
```

- Node 20+ 原生支持 `structuredClone`，Covel 的 engines 要求已满足。
- 只对"被本次 commit 触及的 table"快照（首次写入时 lazy clone），避免全量拷贝。
- 不克隆 functions（Covel 的 store 不存函数）。遇到 DataCloneError 就视为 bug。

**影响面：** `packages/store/src/memory-store.ts` 加三个方法；contract test 新增事务用例。

---

## A13. SSE 协议扩展（回答 #13）

**决策：一次性加入下列事件到 `docs/reference/protocol.md`。**

| 事件名 | 触发点 | Payload 核心字段 |
|---|---|---|
| `context.compacted` | Compactor 完成 | `{ sessionId, turnRangeStart, turnRangeEnd, summaryId, tokenSavings }` |
| `state.snapshot.created` | 快照落库 | `{ sessionId, turnId, snapshotId, kind }` |
| `session.forked` | Fork 完成 | `{ sourceSessionId, newSessionId, fromSnapshotId }` |
| `turn.suspended` | 插件 suspend | `{ sessionId, turnId, suspensionId, reason, resumeSchema }` |
| `turn.resumed` | Resume 成功 | `{ sessionId, turnId, suspensionId }` |
| `lorebook.entry.triggered` | 可选，debug 用 | `{ sessionId, turnId, entryId, source, keys }` |
| `stream.interrupted` | 流式异常 | `{ sessionId, turnId, runtimeId, reason }` |
| `stream.resumed` | 流式恢复 | `{ sessionId, turnId, runtimeId }` |
| `working_memory.changed` | WM 变更 | `{ sessionId, scope, key }` |

所有事件走现有 `ProtocolEventType` 机制。

---

## A14. Character Card V2/V3 信任模型（回答 #15）

**决策：默认不信任，白名单字段 + UI 显式确认。**

**导入管线：**
1. **字段白名单**：只保留 `name / description / personality / scenario / first_mes / mes_example / alternate_greetings / character_book / tags`。
2. **字段黑名单**（**硬丢弃**）：`system_prompt / post_history_instructions / jailbreak / creator_notes / extensions`。理由：这些是指令注入向量。
3. **文本 sanitizer**：strip 控制字符 `\x00-\x1F`，限制单字段长度上限。
4. **character_book 导入**：转换为 session-level lorebook entries，source 标为 `'imported'`，`enabled: false` 默认关闭，等玩家在 UI 勾选启用。
5. **UI 显式确认**：首次使用前弹一个 "此角色卡由第三方提供，是否允许其世界书条目参与 prompt" 确认框。
6. **来源 badge**：session 内 UI 始终显示 "imported character" 标签。

**影响面：** P3-3 实现路径 + `docs/reference/plugins.md` 补一节信任说明。

---

## A15. Prompt Cache 的跨 provider 抽象（回答 #16）

**决策：统一"稳定前缀 + 可选显式标记"策略，所有 provider 都受益。**

**关键发现（见本次调研）：** Anthropic / OpenAI / DeepSeek / Qwen **全部支持** prompt caching。其中 OpenAI / DeepSeek / Qwen 是**自动前缀匹配**（客户端零改动），Anthropic 是**显式 `cache_control` 标记**。

**抽象：** `provider.cacheStrategy: 'anthropic-explicit' | 'auto-prefix' | 'none'`

**实现：**
- 所有 slot 都要求 A2 的段 1–3（Framework / WM / Plugin Instructions）保持 session 内稳定——这对所有 provider 都有收益。
- `anthropic-explicit`: 在段 1 末、段 3 末、段 6 末、段 7 中部共 4 处打 `cache_control: { type: 'ephemeral' }`。用满 breakpoint 上限。
- `auto-prefix`: 无额外操作，自动命中。
- `none`: 作为兜底，暂时不适用于任何已知 provider。

**Working Memory (段 2) 特殊处理：** WM 是"慢变"的——故意放在缓存段外，避免每次 WM 微调就击穿缓存。段 2 的内容变化只影响它自己之后的部分。

**影响面：** P1-4 实现细节、`ai-provider/adapters/anthropic.ts` 加 cache_control 注入、其他 adapter 零改动。

---

## A16. P2-2 vs P2-4 的耦合注释（回答 #17）

**决策：P2-2 走 Option A（删死代码），但保留设计文档作为 P2-4 后的复盘输入。**

**具体动作：**
- `packages/runtime/src/scheduler.ts` 中的 `extractDependencies` / `detectCycles` 实际删除。
- 在 `docs/superpowers/specs/` 下保留一份 `dag-scheduler-option-b.md` 作为冷冻设计，记录如果未来 Suspend/Resume 暴露出 conditional routing 需求时的恢复路径。
- P2-4 完成后做一次复盘：suspend/resume 的真实用例是否暴露了 "一个插件的 suspend 需要激活另一个插件路径" 这类需求？若有，重启 Option B 讨论。

---

## A17. 每个 P 项的验收标准 + 回滚开关（回答 #14）

**决策：统一模板。** 下表在附录 B 执行计划里为每个 ticket 填空。

```yaml
ticket: P0-1
feature_flag: COVEL_CONTEXT_BUDGET_V1   # 环境变量，默认 off，灰度开
owner: <TBD>
acceptance:
  - "测试脚本 scripts/long-session-50turns.ts 在 128K 窗口 provider 下不报 token 超限"
  - "单元测试 packages/context/tests/budget.test.ts 覆盖 pruning 6 种场景"
  - "所有现有 vitest 测试绿"
rollback: "unset COVEL_CONTEXT_BUDGET_V1 → 走老逻辑"
observability: "新增 trace 字段 context.budgetUsed / budgetRemaining / prunedTokens"
```

---

# 附录 B：可执行计划（5 个 Sprint）

**通用原则：**
- 每个 Sprint 两周。
- 每个 ticket 一个 feature flag，默认 off。灰度先在 dev 开，绿了再默认 on。
- 每个 ticket 一个独立 PR，contract test 跟同一 PR。
- **一条硬规则**：没有 acceptance 全绿的 ticket 不进主干。

---

## Sprint 1 — "不崩" 地基（P0）

**目标：** 跑 50 回合的长 session 不崩、LLM 偶发失败不崩、scheduler 死代码清零。

| 票号 | 标题 | 依赖 | 关键文件 | Feature flag |
|---|---|---|---|---|
| S1-T1 | Tokenizer 基础设施（A1） | — | `packages/ai-provider/src/tokenizer.ts` (新) + adapter 的 `providerKind` 字段 | 无（基建） |
| S1-T2 | Context token budget + OpenCode 式 Pruning（P0-1） | S1-T1 | `packages/context/src/budget.ts` (新)、`context-builder.ts:206` 附近加 pruning pass | `COVEL_CONTEXT_BUDGET_V1` |
| S1-T3 | LLM 调用分级重试 + 流式异常兜底（P0-3 + A10） | — | `packages/ai-provider/src/adapters/http.ts`、`turn-executor.ts:567-605` 加 try/catch | `COVEL_LLM_RETRY_V1` |
| S1-T4 | Scheduler 死代码清理（P2-2 + A16） | — | 删除 `scheduler.ts:44-129`，保留 `docs/superpowers/specs/dag-scheduler-option-b.md` | 无（直接删） |
| S1-T5 | 长 session 压测脚本 | S1-T2 | `scripts/long-session-50turns.ts` (新) | — |

**Acceptance（Sprint 结束门槛）：**
- `pnpm test` 全绿
- S1-T5 在 MemoryStore + mock provider 下跑完 50 turn，平均 prompt token ≤ 窗口的 70%
- 注入 30% 429 的 mock provider，10 turn session 不崩
- git log --grep=DEAD_CODE 可看到 S1-T4 的清理记录

---

## Sprint 2 — Prompt 三段式 + Compactor + Cache（P0-2 + P1-2 + P1-4）

**目标：** Prompt 结构升级到可缓存、可压缩的三段式。

| 票号 | 标题 | 依赖 | 关键文件 | Feature flag |
|---|---|---|---|---|
| S2-T1 | 三段式 Prompt assembler（A2） | S1-T1, S1-T2 | `packages/context/src/prompt-assembler.ts` (新) 实现段 1–10，但只处理段 1/3/5/7；其他段占位 | `COVEL_PROMPT_V2` |
| S2-T2 | Compactor + `session_summaries` 表（A5） | S1-T1, S2-T1 | `packages/context/src/compactor.ts` (新)，`packages/store/` 所有 backend 加 summaries 表 + contract test | `COVEL_COMPACTOR_V1` |
| S2-T3 | Prompt cache 抽象 + Anthropic `cache_control` 注入（A15） | S2-T1 | `ai-provider/src/adapters/anthropic.ts`，新增 `cacheStrategy` 字段 | `COVEL_PROMPT_CACHE_V1` |
| S2-T4 | core 插件的 V2 迁移（第一批：core-narrator + core-guide） | S2-T1 | `plugins/core-narrator/PLUGIN.md` + `core-guide/PLUGIN.md` 加 `promptVersion: 2` | — |
| S2-T5 | 文档同步：`docs/reference/prompt-structure.md`（新） | S2-T1 | 新文档 | — |

**Acceptance：**
- 两个 core 插件在 V2 路径下输出语义不变（snapshot test）
- Compactor 在 mock long session（30 turns）上触发 1 次并让总 token 回落
- Anthropic adapter 在集成测试里真的发出带 `cache_control` 的请求体（snapshot test，无需真实 API）

---

## Sprint 3 — RPG 差异化：Lorebook + Working Memory + Author's Note（P1-1 + P1-3 + 段 8/9）

**目标：** Covel 首次具备真正的 RPG 叙事能力。

| 票号 | 标题 | 依赖 | 关键文件 | Feature flag |
|---|---|---|---|---|
| S3-T1 | Lorebook 核心（constant + selective）（A3 + A4） | S2-T1 | 新包 `packages/lorebook/`、新表 `lorebook_entries`、contract test | `COVEL_LOREBOOK_V1` |
| S3-T2 | `core-world-init` 迁移到 Lorebook API（A3 的过渡） | S3-T1 | `plugins/core-world-init/server/*.ts` | — |
| S3-T3 | Working Memory 表 + 段 2 注入（A9） | S2-T1 | 新表 `working_memory`，`packages/store/` + contract，新 Proposal `working_memory.set` | `COVEL_WORKING_MEMORY_V1` |
| S3-T4 | Author's Note 段 9 + Post-History 段 10（A2 的剩余段） | S2-T1 | `prompt-assembler.ts` 补全段 8/9/10 | — |
| S3-T5 | 其余 core 插件的 V2 迁移（core-codex, core-char-creator, core-world-init） | S3-T1..T4 | 各 PLUGIN.md | — |
| S3-T6 | Lorebook 玩家 UI（panel 编辑 session-level entries） | S3-T1 | `apps/web-v2/src/components/lorebook/*` | — |

**Acceptance：**
- 全部 core 插件跑在 V2 路径
- 演示场景：预置一个世界包，带 ≥10 条 lorebook。玩家输入包含关键词时，prompt trace 中能看到对应条目被注入
- `core-world-init` 生成的世界维度自动变成 constant lorebook 条目，可在 UI 中查看

---

## Sprint 4 — 稳健性：Commit 事务 + Snapshot/Fork + Hooks + Suspend/Resume（P2-1 / P2-3 / P2-4）

**目标：** 框架层容错与"存档"。

| 票号 | 标题 | 依赖 | 关键文件 | Feature flag |
|---|---|---|---|---|
| S4-T1 | Commit 事务（PG + SQLite + Memory A12） | — | `packages/store/src/*` 所有 backend、`session-kernel.ts:152-158` 包事务 | `COVEL_COMMIT_TXN_V1` |
| S4-T2 | Snapshot 表 + auto/manual snapshot + fork API（A6） | S4-T1, S3-T3 | 新表、新端点 `POST /api/sessions/:id/fork`、`POST /api/sessions/:id/snapshot` | `COVEL_SNAPSHOTS_V1` |
| S4-T3 | Hook lifecycle pipeline（A11） | — | 新模块 `packages/runtime/src/hooks/`，`turn-executor.ts` 8 处 emit | `COVEL_HOOKS_V1` |
| S4-T4 | Suspend/Resume 原语（A7） | S4-T1 | 新表 `suspensions`，`turn-executor.ts` suspension path，`POST /api/sessions/:id/resume` | `COVEL_SUSPEND_V1` |
| S4-T5 | SSE 协议扩展 + 文档同步（A13） | S4-T1..T4 | `docs/reference/protocol.md`、`packages/shared/src/protocol.ts` 加事件类型 | — |

**Acceptance：**
- 故意在第 3 个 proposal 抛异常，前 2 个提交被回滚（PG + Memory 都验证）
- Snapshot → Fork 后的新 session 可独立推进，原 session 不变
- Suspend 后重启服务器，resume 仍能继续（持久化验证）
- 注入一个 `PreToolUse` hook abort 某工具 → 工具不被调用，turn 继续正常结束

---

## Sprint 5 — 生态与长尾（P3）

**目标：** 对接 SillyTavern 生态 + 长期记忆 + 可观测性。

| 票号 | 标题 | 依赖 | 关键文件 | Feature flag |
|---|---|---|---|---|
| S5-T1 | Character Card V2/V3 导入（A14） | S3-T1 | 新模块 `packages/character-card/`、API `POST /api/characters/import` | `COVEL_CARD_IMPORT_V1` |
| S5-T2 | MCP Client（消费外部 MCP 工具） | — | 新包 `packages/mcp-client/`，runtime runner 集成 | `COVEL_MCP_CLIENT_V1` |
| S5-T3 | pgvector 后端 + Lorebook `vectorized` 策略扩展（A4 的后续） | S3-T1 | `packages/store/pg-store.ts` 加 pgvector 列，`lorebook/vectorized-strategy.ts` | `COVEL_LOREBOOK_VEC_V1` |
| S5-T4 | OpenTelemetry span 导出（turn → runtime → llm → tool 四层） | — | `packages/observability/` (新)，`turn-executor.ts` 加 tracer | `COVEL_OTEL_V1` |
| S5-T5 | Observational Memory 升级（可选，按 S2-T2 Compactor 压力决定） | S2-T2 | `compactor.ts` 重写为 Observer/Reflector 双 Agent | `COVEL_OM_V1` |

**Acceptance：**
- 导入 SillyTavern 生态的 .png 角色卡能生成可用的 Covel character + lorebook entries
- MCP Client 能连到一个参考 MCP server（filesystem）并让工具被 agent 调用
- pgvector 下向量召回的 top-k 在 mock session 上可复现

---

## 贯穿始终的文档同步清单

按 `CLAUDE.md` 的 "Documentation Sync Rules"，每个 sprint 结束前必须更新以下文件（不更新就算未完成）：

| 动过的事 | 必改的 reference 文档 |
|---|---|
| 新 table / 新字段 | `CLAUDE.md` 的 "17 tables" 列表（要涨） |
| 新 plugin 或插件字段扩展（promptVersion / hooks / lorebook / summaryFocus） | `docs/reference/plugins.md` |
| 新 builtin tool（`working_memory.set` / `lorebook.upsert` / `tool.suspend`） | `docs/reference/tools.md` |
| 新 SSE 事件 | `docs/reference/protocol.md` |
| 新右侧面板（Lorebook UI） | `docs/reference/ui-panels.md` |
| 新路由（`/fork`、`/snapshot`、`/resume`、`/import`、`/mcp/*`） | `docs/reference/api.md` |
| 新包（`packages/lorebook`, `packages/mcp-client`, 等） | `CLAUDE.md` 的 Workspace Layout + Dependency Flow |

---

## 谁先动手？（给动手者的出发指南）

**最可并行的三个切入点：**
1. **S1-T1 Tokenizer** — 零依赖、1 天能完成，后续所有 budget 代码都需要它。**强烈建议这是第一个 merge 的 PR。**
2. **S1-T4 Scheduler 死代码清理** — 完全独立、纯删除、能立刻降低新人认知负担。
3. **S1-T3 LLM 重试** — 与 S1-T1 / T2 无依赖，可并行开工。

**第一条阻塞链：** `S1-T1 → S1-T2 → S2-T1 → (S2-T2 ∥ S2-T3) → S3-T1 → S3-T2..T6 → S4-* → S5-*`

**最大的风险票：** S3-T5（core 插件大范围 V2 迁移）和 S4-T4（Suspend/Resume 的持久化）。建议这两个 ticket 各自单独 spec + 单独 PR review 轮次。

---

# 附录 C：变更溯源

本文档的决策基于以下已验证技术事实：

- **Anthropic prompt caching**：最多 4 个 `cache_control` breakpoints；TTL 5m / 1h (beta)；write 1.25x / 2x base，read 0.1x。https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- **OpenAI automatic prompt caching**：1024+ tokens 起自动触发，50% 读折扣，客户端零改动。https://platform.openai.com/docs/guides/prompt-caching
- **DeepSeek Context Caching on Disk** + **Qwen (DashScope) Context Cache** 均自动命中，OpenAI 兼容。https://api-docs.deepseek.com/guides/kv_cache
- **tiktoken `cl100k_base`** vs Claude 偏低约 15-20%（Anthropic 官方建议用 `/v1/messages/count_tokens`），vs 中文模型偏差可达 30%+。https://docs.anthropic.com/en/docs/build-with-claude/token-counting
- **Node.js `structuredClone`** 自 Node 17 起原生支持；不能克隆 functions/Proxy/WeakMap。https://nodejs.org/api/globals.html#structuredclonevalue-options
- **`gpt-tokenizer` npm 包**：纯 TS、零依赖、ESM 原生，是 Node ESM 项目主流选择。https://github.com/niieani/gpt-tokenizer
- **Mastra Observational Memory**：Observer 30K / Reflector 40K tokens，LongMemEval 94.87% SOTA，5-40x 压缩。https://mastra.ai/research/observational-memory
- **LangGraph Super-Step checkpoint + Command(goto, update)** 机制。https://docs.langchain.com/oss/javascript/langgraph/persistence
- **Mastra Workflow step-level suspend/resume**（`suspendSchema`/`resumeSchema`）。https://mastra.ai/docs/workflows/suspend-and-resume
- **OpenCode 双重压缩**：`PRUNE_PROTECT=40000` / `PRUNE_MINIMUM=20000`，保护最近 2 轮 user 对话。https://deepwiki.com/sst/opencode/2.4-context-management-and-compaction
- **SillyTavern World Info** 三态激活 + `position` + `insertionOrder` + sticky/cooldown + recursive scan。https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- **NovelAI Lorebook** Reserved Tokens + Category + Key-Relative Insertion + Phrase Bias。https://docs.novelai.net/en/text/lorebook/
- **KoboldAI Memory / Author's Note / World Info 三件套**，三段式 prompt 骨架的行业事实标准。https://github.com/KoboldAI/KoboldAI-Client/wiki/Memory,-Author's-Note-and-World-Info
- **Character Card V2 spec**（PNG tEXt chunk, character_book, system_prompt 注入漏洞）。https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
- **RisuAI CharX / CCv3**。https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
- **AI Dungeon Memory Bank + Story Cards 混合预算分配**。https://help.aidungeon.com/faq/the-memory-system

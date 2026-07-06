# Pi 架构对照探索 — 借鉴点与 Covel 改进方向

> 探索分支：`claude/pi-architecture-exploration-bw836j`
> 日期：2026-06-18
> 参考项目：[earendil-works/pi](https://github.com/earendil-works/pi)（开源编码 Agent 框架，~64k stars）
> 范围：**架构分离 / 插件设计 / Hook 系统 / 状态管理**。这是探索记录，不改动代码、不发 PR。

---

## 0. TL;DR

Pi 是一个 **编码 Agent CLI 框架**(不是 RPG),但它在 _"把纯 Agent 循环、可持久化编排层、UI 集成层彻底分离"_ 这件事上做得比 Covel 干净。它的核心可借鉴点有四条:

1. **三层切分**:`pi-ai`(纯 Provider 抽象) → `pi-agent-core`(纯 Agent 循环,无持久化) → `AgentHarness`(编排 + 持久化 + Hook 语义) → `AgentSession`/CLI(集成)。Covel 的 `turn-executor.ts` 把这四层揉成了一个巨型函数。
2. **统一的扩展 API + 更细的 Hook 点**:pi 有 ~30 个生命周期事件,单一 `ExtensionAPI.on(event, handler)` 入口,而且包含 Covel 缺失的 `context`(改写发往 LLM 的 messages)、`before_provider_request` / `after_provider_response`(Provider 级拦截)。
3. **每事件独立的变更语义**:pi 对不同 Hook 定义了不同的 mutation 协议——veto(`tool_call.block`)、patch 累积(`tool_result`/`context`)、直接 mutate(`tool_call.input`)。Covel 当前是统一的 `replace: Partial<P>`,表达力较弱。
4. **"会话即唯一可持久真相 + API resolve 前必须落盘"**:pi 把 transcript **和** 运行时配置(model / thinking level / active tools)统一写进一棵 append-only(id/parentId)条目树,fork/branch 是同文件内挂新父节点,无需新建文件。Covel 用 Run/Branch/Snapshot 多对象 + 23 张表,更结构化但分叉更重。

下面逐条展开,并给出 Covel 的对照与可落地的改进建议。

---

## 1. 架构分层对照

### 1.1 Pi 的分层

| 层              | 包                                                  | 职责                                                                                                                           | 是否触碰持久化 |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| Provider 抽象   | `@earendil-works/pi-ai`                             | 多 Provider 统一流式 API、prompt caching、thinking、跨 Provider handoff                                                        | 否             |
| 核心 Agent 循环 | `@earendil-works/pi-agent-core`                     | `Agent` 类:维护 `_state.messages` transcript、跑 `agentLoop`、执行工具、发射生命周期事件、管理 `steeringQueue`/`followUpQueue` | **否**(纯内存) |
| 编排 Harness    | `AgentHarness`(agent-core 内,概念层)                | 会话持久化、运行时配置、资源解析(skills/prompts)、操作锁、**Hook 变更语义**、save-point 快照、abort 控制                       | 是(单一真相源) |
| 集成 / CLI      | `@earendil-works/pi-coding-agent` 的 `AgentSession` | 把上面三者粘起来,接 TUI、SessionManager(JSONL)、扩展发现                                                                       | 是             |

关键设计意图(来自 `packages/agent/docs/agent-harness.md` / `durable-harness.md`):

- **核心循环 `runAgentLoop()` 不知道"持久化"存在**。它只吃 messages、吐 events。
- **Harness 拥有整个生命周期**:abort、queue draining、stream 配置、事件归并、save-point。
- **"durable"语义**:会话是所有可持久 Agent 状态的唯一真相源——不只是 transcript,还包括 model / thinking level / active tools 这些配置变更;**每一个被接受的 mutation 必须在 public API resolve 之前落盘**。
- **"semi-durable resume"**:Harness 维护会话树里的当前 leaf,重开存储时从最新条目重建;它承认工具实现 / Provider 这类运行时注入的依赖无法序列化,所以是"半持久"。

### 1.2 Covel 的现状

Covel 的包划分本身是清晰的(`shared ← context ← runtime ← server`),但**核心循环与编排/持久化没有在代码层面分离**:

- `packages/runtime/src/turn-executor.ts` 的 `executeTurn()` 一个函数里串联了:TurnStart hook → 载入会话状态 → 触发选择 → DAG 调度 → 上下文装配 → guard → Agent/Function 执行 → 工具循环 → 提案提交 → TurnStop hook。
- 相比 pi,Covel **没有一个"纯内存、可独立测试、不碰 store"的 agent 循环对象**。`turn-agent-tool-loop.ts` 已经比较接近"核心循环",但它通过 `deps`(含 `store`、`eventBus`、`toolExecutor`、`memorySystem`...)直接拿到了持久化与副作用句柄。

> Covel 的 `TurnExecutorDeps` 有 **20+ 个字段**(`store`、`eventBus`、`hookPipeline`、`compactor`、`memorySystem`、`mediaStore`、各种 `on*` 回调……),这正是"编排层职责泄漏进核心循环"的信号——它实际上同时扮演了 pi 的 core + harness + session 三个角色。

### 1.3 改进建议 A:抽出"纯 Turn 核心"与"Turn Harness"

把 `executeTurn` 拆成两层(不改对外行为,纯内部重构):

```
TurnHarness(编排/持久化/Hook 语义)
  ├─ 拥有 store / eventBus / commit pipeline / compactor / memorySystem
  ├─ 负责:触发选择、DAG 调度、提案提交、落盘、事件发射、trace
  └─ 调用 ↓
TurnCore(纯执行,无 store)
  ├─ 输入:已装配的 AssembledContext + 工具列表 + LLMAdapter
  ├─ 输出:RuntimeResult + Proposal[](内存对象,不落盘)
  └─ 只跑:guard → LLM 循环 → 工具调用 → 收集提案
```

收益:

- `TurnCore` 可在没有 SQLite/PG 的情况下用 `MockLLM` 单测,契合现有 `@covel/plugin-test-utils`。
- 提案的"产生"与"提交"彻底解耦,`PreStateCommit`/`PostStateCommit` 的边界更自然。
- 对应 pi 的 `runAgentLoop`(core)vs `AgentHarness`(orchestration)。Covel 已经有 `session-commit-pipeline.ts`,把它升格为 Harness 的一等成员即可。

---

## 2. Hook / 扩展系统对照

### 2.1 事件点:Pi ~30 个 vs Covel 8 个

Covel 现有 8 个(`packages/runtime/src/hooks/types.ts`):
`TurnStart` · `PreRuntime` · `PostRuntime` · `PreToolUse` · `PostToolUse` · `PreStateCommit` · `PostStateCommit` · `TurnStop`。

Pi 的事件(节选,与 Covel 对齐看缺口):

| Pi 事件                                      | 作用                                                            | Covel 是否有等价                          |
| -------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `session_start` / `session_shutdown`         | 会话起止                                                        | ~ 部分(无显式扩展钩子)                    |
| `before_agent_start`                         | 用户提交后、循环开始前,可注入 message / 改 system prompt        | ~ 接近 `TurnStart`,但不能改 prompt        |
| `turn_start` / `turn_end`                    | turn 边界                                                       | ✅ `PreRuntime`/`PostRuntime` 近似        |
| **`context`**                                | **每次 LLM 调用前,非破坏性改写 messages**                       | ❌ **缺失**                               |
| **`before_provider_request`**                | **Provider 请求前,检查/替换 payload、改 streamOptions/headers** | ❌ **缺失**                               |
| **`after_provider_response`**                | **拿到响应、消费流之前拦截**                                    | ❌ **缺失**                               |
| `tool_call`                                  | LLM 发起工具调用时拦截(可 block / 改 input)                     | ✅ `PreToolUse`                           |
| `tool_result`                                | 工具返回后改写 content/isError/terminate                        | ✅ `PostToolUse`                          |
| `model_select` / `thinking_level_select`     | 模型/思考档位选择拦截                                           | ❌ 缺失(Covel 有 slot resolver 但无 hook) |
| `session_before_compact` / `session_compact` | 压缩前后(可取消/自定义摘要)                                     | ~ 有 compactor,但无扩展 hook              |
| `input` / `user_bash`                        | 用户输入/bash 拦截(CLI 专属)                                    | N/A(Covel 非 CLI)                         |

**最值得补的三个缺口**:`context`、`before_provider_request`、`after_provider_response`。

- Covel 目前用 `promptHistoryRewriterPluginId`(一个被 turn-executor 显式持有的 capability)来做 prompt 历史改写。这其实**违反了 CLAUDE.md 的"框架代码禁止硬编码插件能力路径"精神的边缘**——框架要专门记一个 rewriter 插件 id 并在装配时调用它。
- 如果改成一个通用 **`PreLLMCall`(≈ pi 的 `context`)hook**,任何插件都能非破坏性地改写发往 LLM 的 messages,框架不必特殊对待"rewriter"这一角色,`prompt-history-rewriter` capability 可退化为"声明我注册了一个 PreLLMCall hook"。更符合"capability 发现"而非"id 硬编码"。

### 2.2 变更语义:Pi 每事件不同 vs Covel 统一 replace

Covel 的 Hook 结果(`packages/runtime/src/hooks/types.ts`):

```ts
type HookResult<P> =
  | { action: "continue" }
  | { action: "continue"; replace: Partial<P> } // 浅合并替换 payload
  | { action: "abort"; reason: string };
```

Pi 的 handler 签名统一,但**每个事件的返回语义不同**:

| Pi 事件                   | 语义                   | 说明                                                                                       |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `context`                 | **return-based 链式**  | 顺序执行,每个 handler 拿到上一个的 `messages`,返回 `{messages}` 改写,返回 `undefined` 不变 |
| `before_provider_request` | **return-based patch** | 返回 `{streamOptions}` 替换/补丁,下游 handler 看到累积结果                                 |
| `tool_call`               | **veto + mutate**      | 返回 `{block:true, reason}` 直接否决并短路;`input` 对象可直接 mutate                       |
| `tool_result`             | **patch 累积**         | 返回部分 patch(`content`/`isError`/`terminate`...),省略字段保留原值                        |

Covel 的统一 `replace: Partial<P>` 已经能表达"patch 累积"(浅合并)和"abort"(≈veto),**但缺少 pi 的两个细节**:

1. **`PreToolUse` 缺少结构化的 `block + reason`**。现在只能 `abort` 整个 pipeline,无法"只挡这一个工具调用、但让 turn 继续"。pi 的 `tool_call.block` 是 per-call 否决,语义更精细。Covel 的 approval pipeline(`@covel/approval`)其实在做类似的事,但那是另一条链路,没和 Hook 统一。
2. **没有"`terminate` 提前结束工具循环"的出口**。pi 的 `tool_result.terminate` 让插件能在工具返回后主动停掉 agent 循环。Covel 的 `loopDetectionThreshold`/`maxSteps` 是框架内置的硬约束,插件无法语义化地"我满意了,停"。

> 建议 B:给 `HookResult` 增加 per-event 的判别字段——`PreToolUse` 支持 `{ action: "skip-tool", reason }`(否决单个工具但不 abort turn),`PostToolUse` 支持 `{ replace, terminate?: true }`。保持向后兼容(老的 `continue/abort` 不动)。

### 2.3 注册入口:Pi 单一 `ExtensionAPI` vs Covel 声明式 PLUGIN.md

Pi 的扩展是一个 default-export 工厂,拿到 `pi: ExtensionAPI` 后用命令式 API 注册一切:

```ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (e, ctx) => { if (dangerous(e)) return { block: true }; });
  pi.registerTool({ name, parameters, execute });
  pi.registerCommand("hello", { handler });
  pi.registerProvider(...);
}
```

Covel 是 **声明式**:PLUGIN.md frontmatter 声明 `hooks[]` / `tools` / `rpc`,handler 指向相对路径模块。两种风格各有取舍:

|                                  | Pi 命令式 `ExtensionAPI` | Covel 声明式 PLUGIN.md                                 |
| -------------------------------- | ------------------------ | ------------------------------------------------------ |
| 静态可分析(信任分级、工具白名单) | 弱(要执行才知道注册了啥) | **强**(frontmatter 直接读)                             |
| 动态注册(运行时条件注册工具)     | **强**                   | 弱                                                     |
| 样板代码                         | 少                       | 多(每个 hook 一个文件 + frontmatter 条目)              |
| 与信任分级 / 沙箱契合            | 需运行才能裁决           | **契合**(community 插件 defer import 前就能看清能力面) |

Covel 的声明式选择对它的信任模型(builtin/official/community + `import()` 延迟)**是正确的**——不该照搬 pi 的命令式。但可以借鉴一点:

> 建议 C:为 **function-runtime** 插件提供一个**轻量编程式注册门面**,减少"一个 hook 一个文件 + frontmatter 三行"的样板。即在保留声明式清单(用于信任/白名单静态分析)的前提下,handler 内部可用 `ctx.registerXxx`-风格 helper。本质是"声明面"与"实现面"分离:清单负责"我要什么权限",代码负责"具体怎么做"。

---

## 3. 状态管理对照

### 3.1 Pi:append-only 条目树 + 配置入 log

- 会话 = JSONL,每行一个 entry(message / CompactionEntry / 自定义扩展 message)。
- entries 用 `id` / `parentId` 组成**树**,**in-place 分叉无需新建文件**——fork/branch 只是挂一个新父指针。
- **配置变更也是 entry**:model、thinking level、active tools 的改动都写进同一棵树,而非旁路字段。
- 压缩 = 追加 `CompactionEntry`(含 summary + `firstKeptEntryId`)→ reload 时从 `firstKeptEntryId` 起 + summary。原始历史**不删除**,仍在文件里,可回溯。
- 重开 = 沿当前 leaf 往上重建。

### 3.2 Covel:多对象 + 关系表 + 提案提交

- 核心对象 **Run / Branch / Snapshot / State / Event / Record / Character / PluginData** 不塌缩成单一 JSON。
- `StateManager` 按 `table.field` 存,且每个字段带 `changeLog`(谁、哪个 turn、为什么改),粒度比 pi 细。
- 所有写入走 **Proposal → validate → commit**(13 种 `ProposalType`),`SessionEvent` 带单调 id 支持 replay——**已经是事件溯源风格**。
- 分叉靠 Branch/Snapshot 对象。

### 3.3 对照结论

Covel 在状态**结构化**与**审计**上比 pi 强得多(per-field changeLog、proposal 校验、关系查询)。这是 RPG 场景的正确取舍——你需要查询"角色 X 的好感度变更历史",pi 的扁平 JSONL 做不到。

但有两点 pi 的思路值得吸收:

**借鉴 1 —— "config 即 event,统一进 log"。**
Covel 的 `sessions.runtime_model_overrides` 是旁路 JSONB 字段,每 turn 快照进 `TurnInput`。这其实是"配置游离在事件流之外"。若把"运行时模型覆盖变更""插件启用/禁用变更"也建模成 `SessionEvent`(类似 `event.emit` 提案),则:

- 时间旅行 / replay 时配置能自然重建(目前 replay 一个旧 turn,override 状态是"当前值"而非"当时值")。
- `/debug` 的 Session Timeline 能显示"第 5 turn 玩家把 narrator 切到了 fast slot"。

> 建议 D:新增 `config.patch` 提案类型(或复用 `state.patch` 写入一张 `session_config` 表),让运行时配置变更也流经 commit pipeline,获得 replay/audit 一致性。需同步 `docs/reference/tools.md`(提案类型)与 `transactions.md`。

**借鉴 2 —— "durable 不变量:API resolve 前必落盘"。**
Pi 明确要求"每个被接受的 mutation 在 public API resolve 前必须 durable"。Covel 的 commit pipeline 已经落盘,但建议把这条**写成显式契约**并在 `transactions.md` 里声明:`executeTurn` 返回 `TurnResult` 之前,所有 committed 提案必须已在 store 落盘(而非 fire-and-forget)。目前 `EventBus` 的持久化是"fire-and-forget"(见 event-bus 注释),这与"durable before resolve"是冲突的——审计事件可能丢。

---

## 4. Provider 抽象对照(Covel 反而更强)

这一块 Covel 不弱于 pi,甚至更全:

| 维度             | Pi `pi-ai`              | Covel `ai-provider`                                                    |
| ---------------- | ----------------------- | ---------------------------------------------------------------------- |
| 多 Provider      | OpenAI/Anthropic/Google | OpenAI-chat / OpenAI-responses / Anthropic-messages                    |
| 流式             | ✅                      | ✅ `streamText`                                                        |
| Prompt caching   | ✅                      | ✅ `CacheStrategy`(anthropic-explicit / auto-prefix)                   |
| 能力检测         | 有                      | **更强**:多模态 input/output modality + features + LiteLLM 2597 模型库 |
| 多模态操作       | 文本为主                | text/object/stream/embed/image/speech/transcription 全覆盖             |
| Slot/Preset 路由 | 模型注册表              | **更强**:named slots + tag-aware fallback + per-runtime override       |

唯一可借鉴:pi 的 **`before_provider_request` / `after_provider_response`** 是在 Provider 边界上的 hook(见 §2.1),让插件能改 headers / 替换 payload / 拦截响应流。Covel 的 gateway 目前没有暴露这个扩展点。这与 §2.1 的建议合并即可。

---

## 5. 改进建议汇总(按性价比排序)

| #     | 建议                                                                                                   | 影响面                  | 风险         | 对应 pi 设计                                |
| ----- | ------------------------------------------------------------------------------------------------------ | ----------------------- | ------------ | ------------------------------------------- |
| **B** | `HookResult` 增加 per-event 语义:`PreToolUse` 的 `skip-tool`(单工具否决)、`PostToolUse` 的 `terminate` | runtime                 | 低(向后兼容) | `tool_call.block` / `tool_result.terminate` |
| **E** | 新增 `PreLLMCall`(≈`context`)hook:非破坏性改写发往 LLM 的 messages                                     | runtime + context       | 中           | `context` 事件                              |
| **D** | 运行时配置变更建模为 event/proposal,流经 commit pipeline                                               | store + runtime         | 中           | "config 即 entry,统一进 log"                |
| **A** | 把 `executeTurn` 拆为 `TurnHarness`(编排/持久化)+ `TurnCore`(纯执行)                                   | runtime(大)             | 中高(纯重构) | `AgentHarness` vs `runAgentLoop`            |
| **F** | Provider 边界 hook:`before_provider_request` / `after_provider_response`                               | ai-provider + runtime   | 中           | 同名事件                                    |
| **C** | function-runtime 的编程式注册门面(声明面/实现面分离)                                                   | plugin-loader + runtime | 中           | `ExtensionAPI`                              |
| **G** | "durable before resolve"写成显式契约;审计事件落盘不再 fire-and-forget                                  | events + store          | 中           | durable-harness 不变量                      |

**不建议照搬**:

- ❌ pi 的扁平 JSONL append-only 单文件状态。Covel 的关系化 + per-field changeLog 对 RPG 查询/审计是更优解。
- ❌ pi 的命令式 `ExtensionAPI` 全面替换声明式 PLUGIN.md。Covel 的声明式清单对信任分级 / community 沙箱是刚需。
- ❌ pi 的 jiti 运行时 TS 加载用于 community 插件(安全面更大);Covel 现有 `import()` defer + 信任分级更稳。

---

## 6. 建议的落地顺序(若后续推进)

1. **先做 B**(Hook 语义增强):最小、向后兼容,立刻让 approval/工具拦截更顺手。
2. **再做 E + F**(LLM/Provider 边界 hook):把 `promptHistoryRewriterPluginId` 这类硬编码 capability 收敛成通用 hook,顺手清理 turn-executor 对特定 capability id 的持有。
3. **然后 A**(Turn 拆层):在 1/2 把 hook 点理顺后,拆 `TurnCore`/`TurnHarness` 的接缝会更清晰。
4. **D + G**(状态/持久化一致性):独立推进,需同步 `transactions.md` / `tools.md` / `protocol.md`。
5. **C** 最后做,属锦上添花。

---

## 附:关键文件索引(便于后续精读)

**Covel 侧**

- Hook:`packages/runtime/src/hooks/{types,pipeline}.ts`
- 清单类型:`packages/shared/src/types/plugin.ts`(`RuntimeManifest` / `TriggerType` / `HookDeclaration`)
- 事件总线:`packages/events/src/event-bus.ts`
- 状态:`packages/state/src/state-manager.ts`、`packages/shared/src/types/state.ts`
- 提案:`packages/shared/src/types/proposal.ts`、`packages/runtime/src/session-commit-pipeline.ts`
- Turn 执行:`packages/runtime/src/turn-executor.ts`、`turn-agent-tool-loop.ts`、`turn-executor-types.ts`
- 上下文:`packages/context/src/{index,types}.ts`
- Provider:`packages/ai-provider/src/{gateway,types}.ts`、`adapters/`

**Pi 侧**(DeepWiki 路径)

- Extension System:wiki §6(API、loading、events、patterns)
- AgentSession / 生命周期:wiki §2.2
- 压缩:wiki §2.3
- AgentHarness / durable-harness:`packages/agent/docs/agent-harness.md`、`durable-harness.md`、`hooks.md`
- Provider:wiki §3(streaming、registry、caching/thinking/handoff)

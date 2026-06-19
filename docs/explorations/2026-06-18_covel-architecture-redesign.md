# Covel 架构演进蓝图 — 以 pi 为参照的深度适配

> 探索分支：`claude/pi-architecture-exploration-bw836j`
> 起草：2026-06-18 · 参照：[earendil-works/pi](https://github.com/earendil-works/pi)
> 目标：**不照抄 pi**,而是把 pi 的架构原则深度适配进 Covel 现有结构。四条主线:
> ① 微调 · ② 更多 hook · ③ 更灵活的调用 · ④ 功能分离

本蓝图是「目标结构 + 分片路线」。每一片(slice)独立可交付、独立提交、独立验证。已落地的写 ✅。

---

## 设计原则(从 pi 提炼,按 Covel 约束改写)

| pi 原则                        | Covel 适配后的表述                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| core 循环不碰持久化            | `turn-agent-tool-loop` 只依赖「执行三件套」(llm / toolExecutor / hookPipeline),编排句柄(store / eventBus / compactor / memorySystem)留在外层 harness |
| 单一 `ExtensionAPI` 命令式注册 | **不照搬**。Covel 保留声明式 PLUGIN.md(信任分级/静态白名单刚需),但为 function-runtime 提供编程式 helper 门面,声明面与实现面分离                      |
| ~30 个生命周期事件             | 按 Covel 真实管线补 hook,只加**有真实拦截点**的事件,不为对齐而对齐                                                                                   |
| 每事件独立 mutation 语义       | 已有 `replace`/`abort`;按需补 `terminate`(✅)、`skip` 等 per-event 语义                                                                              |
| 配置即 append-only event       | Covel 已是 proposal→commit 事件溯源;把旁路配置(`runtime_model_overrides`)也纳入(Phase D,暂缓)                                                        |
| capability 发现而非硬编码 id   | Covel 已遵守;问题是**发现逻辑在 4 个 route 重复**,需收敛到单一来源                                                                                   |

---

## 轴① 微调(低风险,随手做)

- ✅ **`PostToolUse` 语义修正**:`parallel` 会丢弃 `replace`(latent no-op),改 `sequential`,result patch 与 terminate 才生效。
- **`hookOpts` 收敛**:工具循环里每个工具迭代曾重建 hook options;已抽成循环级共享(✅,随 Phase 1 一起)。
- **capability id 解析去重**(见轴④ slice S1)。

## 轴② 更多 hook(对齐 pi,但只加有拦截点的)

已落地:

- ✅ `PreLLMCall` / `PostLLMResponse`(LLM 调用边界,每次调用)
- ✅ `PostToolUse.terminate`(工具循环提前退出)
- ✅ `PostContextAssembly`(H1:turn 级改写已装配 systemPrompt / 投影历史)
- ✅ `PreCompaction` / `PostCompaction`(H2:压缩否决门 + 结果观察;顺带把 `CompactorRunner.run` 的 `CompactorResult` 透出)
- ✅ `PreSchedule`(H3:触发选择后、调度前收窄本回合 runtime 集;服务轴③)

蓝图新增(按价值排序):

| 事件                               | 语义                  | 拦截点                            | pi 对应                                      | 价值                                                                                     |
| ---------------------------------- | --------------------- | --------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PostContextAssembly`              | sequential            | `buildContext` 之后、进 loop 之前 | `before_agent_start`                         | 让插件改写**已装配的 systemPrompt**(turn 级,一次/runtime,比 per-call 的 PreLLMCall 更省) |
| `PreCompaction` / `PostCompaction` | sequential / parallel | `compactor.run` 前后              | `session_before_compact` / `session_compact` | 插件可取消压缩 / 提供自定义摘要 / 观察                                                   |
| `SessionStart` / `SessionEnd`      | parallel              | session 创建 / 结束(server 层)    | `session_start` / `session_shutdown`         | 插件级初始化与清理,session 作用域                                                        |
| `PreSchedule`                      | sequential            | Trigger Router 选完触发集之后     | (无直接对应)                                 | 让插件影响「本回合跑哪些 runtime」,服务轴③                                               |

> 注意:`PreLLMCall` 已能改写 messages(含 systemPrompt 作为 messages[0]),所以 `PostContextAssembly` 不是为了 message-shaping,而是为了**turn 级、一次性**地塑造 systemPrompt,避免每次循环迭代重复跑重逻辑。两者职责不重叠。

## 轴③ 更灵活的调用(Covel 最弱、最值得补)

pi 的灵活来自:运行时注册(tool/provider/command)、steering/followUp 队列、recursiveCall。Covel 现状与目标:

1. **function-runtime 编程式注册门面**(对应 pi `ExtensionAPI`,但受信任分级约束):
   - 现状:hook/tool/rpc 全靠 PLUGIN.md frontmatter 声明 + handler 文件,样板多。
   - 目标:handler 内可用 `ctx.hooks.on(event, fn)` / `ctx.registerProposalShaper(...)` 之类 helper **动态**注册(仅限已在清单声明权限范围内),声明面管「能做什么」,代码面管「具体怎么做」。
2. ✅ **统一调用门面 `RuntimeInvoker`**(F1 已交付):`executeOneRuntime` 本就是统一调度器(上游门控 → skip → load → function/agent 分派 → recursiveCall),但曾是 **19 个位置参数**的签名,3 个调用点各自照抄一长串实参。改成单一 `RuntimeInvocation` options 对象 + 调用侧 `invoke(manifest, triggerEvent)` 闭包(`sessionMeta`/`sessionContext` 会被 recordPreGameCompletion 重赋值,故按引用读取)。纯重构零行为变化(485 测试全绿)。resume 路径仍独立 = F1.b 待办。
3. **`recursiveCall` 已有**,深度/预算控制现已收敛在 `RuntimeInvocation` 内(`turnOptions` + `recursionDepth`)。

## 轴④ 功能分离(结构骨架)

1. **S1 — capability 解析单一来源**(本轮实现):`worldDataPluginId` / `personaPluginId` / `promptHistoryRewriterPluginId` 的发现逻辑在 `turn.ts` / `actions.ts` / `plugin-rpc.ts` 重复三处。收敛成 `resolveTurnCapabilityPluginIds(registry, sessionId)` 单一来源。新增框架消费的 capability 时只改一处。
2. ✅ **S2 — `AgentLoopDeps` 窄依赖**(已交付):`turn-agent-tool-loop` 及其 helper(`requestLLMResponse` / `handleSuspension`)曾吃整个 `TurnExecutorDeps`(20+ 字段)。抽出 `AgentLoopDeps`(仅 8 个执行/观测字段:`llm` / `toolExecutor` / `resolveModel` / `store` / `eventBus` / `onDelta` / `onRuntimeComplete` / `emitter`),`TurnExecutorDeps extends AgentLoopDeps` 保证全量 deps 仍可赋值。核心循环在类型层面**够不到** compactor / memorySystem / contextBudget / capability-id / loadRuntime 等编排字段。对应 pi 的 core vs harness。纯类型重构,零行为变化(482 测试全绿)。`store` 作为 suspension 持久化的逃生口暂留,标注待 S3 上移。
3. **S3 — `TurnHarness` 显式化**:把「触发选择 / 调度 / 提案提交 / 落盘 / 事件」聚成 harness 角色(可先是命名与边界,不强搬代码),core 只产出内存提案。

---

## 分片路线(执行顺序)

| Slice | 轴  | 内容                                      | 风险 | 状态      |
| ----- | --- | ----------------------------------------- | ---- | --------- |
| P1    | ②   | `PreLLMCall` / `PostLLMResponse`          | 低   | ✅ 已交付 |
| P2    | ②①  | `PostToolUse.terminate` + 语义修正        | 低   | ✅ 已交付 |
| S1    | ④   | capability 解析单一来源                   | 低   | ✅ 已交付 |
| S2    | ④   | `AgentLoopDeps` 窄依赖接缝                | 中   | ✅ 已交付 |
| H1    | ②   | `PostContextAssembly` hook                | 中   | ✅ 已交付 |
| H2    | ②   | `PreCompaction` / `PostCompaction` hook   | 中   | ✅ 已交付 |
| H3    | ②③  | `PreSchedule` hook(收窄本回合 runtime 集) | 中   | ✅ 已交付 |
| F1    | ③   | `RuntimeInvoker` 统一调用门面(options 化) | 中高 | ✅ 已交付 |
| F1.b  | ③④  | 把 resume 路径并入同一 invoker            | 中高 | 待办      |
| F2    | ③   | function-runtime 编程式注册门面           | 中高 | 待办      |
| D1    | —   | config 即 event(状态溯源一致性)           | 高   | 暂缓      |

**做/不做的明确判断**:

- ✅ 做:S1/S2(分离)、H1/H2(更多 hook)、F1/F2(更灵活)。
- ❌ 不做:把 rewriter「迁移成 hook」——它现在走的是 capability 发现 + plugin-data 读取,是**正确**模式,改成 hook 是平移不是改进。S1 只去重发现逻辑,不改架构。
- ❌ 不做:照搬 pi 扁平 JSONL 状态、命令式 ExtensionAPI 全替换、jiti 运行时加载 community 插件。

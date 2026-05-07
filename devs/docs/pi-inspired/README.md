# pi.dev / pi-mono 借鉴提案（结合 Covel 代码库版）

> 本目录收录从 [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) / <https://pi.dev/> 吸取、再针对 Covel 任务重新设计的架构提案。
>
> 本版已按当前 Covel 代码库校准：`packages/shared/src/types/plugin.ts`、`packages/store/src/types.ts`、`packages/context/src/prompt-internals.ts`、`packages/runtime/src/hooks/*`、`packages/runtime/src/{scheduler,dag-scheduler,trigger}.ts`、`packages/plugin-loader/src/{types,registry}.ts`、`apps/server/src/routes/api/{actions,bootstrap,snapshots}.ts` 等。

## 为什么开这个目录

pi-mono 是一个极简但设计成熟的 coding-agent 框架。它的 extensions / skills / prompt templates / themes / packages、生命周期事件、session 树、渐进披露、资源 provenance 等设计，对 Covel 这种“插件承载玩法、内核做编排”的 AI RPG 框架有参考价值。

但 Covel 不是 coding-agent：

- 玩家面向 vs 开发者面向 → trust tier / capability gate 不能砍
- 多 runtime 协作 vs 单 agent loop → 不能照搬 pi 的单循环 steering 语义
- 持久游戏状态 vs 临时 coding session → JSONL/tree 可以做 export/replay，不能替代 Store
- 多优先级带 + DAG 调度 vs 单 agent 工具循环 → 生命周期点必须映射到 Covel turn pipeline
- 稳定叙事 prompt vs coding-agent 自主探索 → 不让游戏 runtime 自己 read 文档发现能力

所以本目录里的提案借的是**架构形状**，不是实现和安全模型。

## 借鉴原则

1. **框架和插件必须分离**：框架只提供执行原语、调度、上下文装配、tool/proposal/commit、store、protocol、trust/capability gate；具体玩法、叙事策略、NPC 图谱、图鉴、图片生成等必须由插件通过 manifest/capability/proposal/tool/ui 声明接入。框架代码不得硬编码具体插件 ID、名称、namespace 或 UI 文件路径。
2. **借资源发现，不借全权限执行**：pi package / extension 默认 full system access；Covel 必须保留 `builtin / official / community` 与 approval/capability gate。
3. **借渐进披露，不借游戏 LLM 自主探索文件系统**：Covel 已有 `PluginSummary → LoadedRuntime` 分层，适合作者侧/调试侧，不适合 narrator runtime 动态 read 文档。
4. **借 session tree，不借 JSONL 主存储**：Covel 已有 `DataStore`、`SnapshotRecord`、`RuntimeOutputRecord`、`InteractionRecordRow`、`trace_events`；JSONL 更适合 export/replay/share。
5. **借 middleware 生命周期，不借 mutable event 风格**：Covel `HookPipeline` 已使用 `replace/abort` + trace diff，比 pi 的 in-place mutation 更适合服务端审计。
6. **借 package filtering，不借按文件路径猜权限**：Covel 应按 plugin/runtime/tool/ui resource ID + provenance 过滤，而不是直接让 glob 决定安全边界。
7. **借 CustomEntry / CustomMessageEntry 的语义拆分**：落到 Covel 是 `plugin_data.visibility`，区分 private state 与 prompt-visible context。

## 框架 ↔ 插件分离边界

这是所有 pi-inspired 提案的硬约束。

### 框架负责

- 加载与校验 plugin manifest / runtime manifest。
- 维护 session scope、trust tier、capability gate、approval policy。
- 根据 priority band、DAG、trigger、event delivery mode 调度 runtime。
- 装配 prompt context，但只根据 manifest/capability/visibility 等通用声明工作。
- 执行 tool loop、hook pipeline、proposal normalize / validate / commit。
- 提供 store、trace、SSE/HTTP protocol、debug/export/replay 基础设施。
- 暴露通用 UI slots 与 json-render catalog，但不理解具体插件 UI 的业务语义。

### 插件负责

- 声明自己的 runtime、trigger、capabilities、tools、hooks、input.inject、outputKind、UI specs。
- 承载玩法逻辑：叙事、图鉴、NPC 图谱、角色创建、图片生成、战斗、经济、任务等。
- 决定自己写入的 `plugin_data` 哪些是 private，哪些是 context-visible。
- 通过 proposal / scoped pluginData writer / local tools 写入自己的数据。
- 通过 `_eventType`、manifest capabilities、outputKind 等通用协议与框架协作。

### 禁止事项

| 禁止                                               | 替代做法                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| 框架代码判断 `pluginId === 'narrator'`             | 判断 `outputKind === 'story'` 或 capability `narrative`                         |
| 框架代码读取固定 namespace，如 `world-init/schema` | 通过 capability `world-data-provider` 或 manifest-declared inject/provider 发现 |
| 框架代码为某个插件特殊拼 prompt                    | 插件通过 `input.inject`、authorsNote、postHistory、context visibility 声明      |
| 框架代码识别具体 block 类型                        | block 用 `_eventType` 或 schema/capability 声明事件语义                         |
| 框架代码默认启用/禁用某个具体 runtime              | session/world scope 用 resource ID/filter 声明，kernel 只执行通用过滤规则       |

这意味着本目录所有提案都必须以“通用机制”形式落地：visibility、provenance、hook payload、PreInput、event delivery、budget breakdown 都不能内置任何核心插件特例。

## 当前代码库现状速览

| 领域                | Covel 当前代码现状                                                                                                                                 | 结论                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| plugin-data context | `PluginDataRecord` 无 `visibility`；`resolvePluginDataInject()` 直接 `listPluginData(sessionId, pluginId, namespace)` 后整 namespace 候选进 prompt | #01 是真实缺口，P0                                          |
| hook middleware     | `HookPipeline` 已有 `parallel / sequential / first / stream`、`replace`、`abort`、`enforce`、timeout、trace                                        | #02 不是从零做，而是补齐 payload 语义                       |
| input interception  | `apps/server/src/routes/api/actions.ts` 从 request 直接推导 `playerMessage` 并进入 `executeTurn()`                                                 | #03 是真实缺口，P0                                          |
| plugin source/trust | `PluginDiscoveryResult.source/rootPath`、`PluginRegistryEntry.source` 已存在；但 runtime/tool/UI 下游没有统一 `sourceInfo/provenance`              | #08 应作为 filtering/package/debug 地基                     |
| scheduling          | 已有 priority band、DAG scheduler、trigger router、`activePlugins` session scope                                                                   | #05/#09 应补 runtime/tool/UI 粒度，不替代 trigger/scheduler |
| context budget      | `applyBudget()`、`BudgetOptions`、`BudgetResult` 已有；缺 segment/plugin-data 级 breakdown                                                         | #11 是“可观测化”，不是重做预算                              |
| snapshots/fork      | `apps/server/src/routes/api/snapshots.ts` 已有 manual snapshot / list / fork                                                                       | #04/#07 应复用 snapshot+compactor，不照搬 pi JSONL tree     |
| hot reload          | `RegistryChangeEvent` 有 `plugin-reloaded` 类型，但 registry 无 reload 实现                                                                        | #06 dev-only 可做                                           |

## 全景图：从 pi-mono 借的 13 条想法

| #   | 主题                                                               | 原版来源                                       | Covel 代码现状                                                                | 状态               | 说明                                                                        |
| --- | ------------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| 01  | [plugin-data 上下文可见性双轴](./01-plugin-data-visibility.md)     | `CustomEntry` vs `CustomMessageEntry`          | `PluginDataRecord` 无 visibility；plugin-data inject 整 namespace 进 prompt   | **P0 proposed**    | 最贴合当前代码的地基提案                                                    |
| 02  | [Hook payload middleware 语义收敛](./02-hook-payload-semantics.md) | `tool_call` mutate + `tool_result` patch chain | `HookPipeline` 已实现 sequential/parallel/replace/abort                       | **P1 refine**      | 不是新增 hook，而是钉死 payload patch / validation / parallel 返回值语义    |
| 03  | [PreInput 钩子](./03-pre-input-hook.md)                            | `input` 事件：continue / transform / handled   | `actions.ts` 当前无输入前置拦截                                               | **P0 proposed**    | 玩家输入、UI action、快捷指令进入 turn 前的统一入口                         |
| 04  | Fork 分支切换自动摘要                                              | `BranchSummaryEntry` + `/tree` summary         | 已有 snapshots/fork + compactor                                               | P2 backlog         | 写入 child session summary 或 fork snapshot metadata，不照搬 pi 同文件 tree |
| 05  | Plugin/runtime/tool/UI 过滤语法                                    | packages 的 `+path` / `-path` / glob 过滤      | 当前 `activePlugins` 只有 plugin 粒度                                         | P1 backlog         | 细化 world/session scope；按 resource ID 过滤                               |
| 06  | Dev-only hot reload + resources_discover                           | `/reload` + `resources_discover`               | 有 `plugin-reloaded` 事件类型，无 reload 方法                                 | P1/P2 research     | 仅 dev，生产禁用；reload 影响下一 turn                                      |
| 07  | Session export / replay / share tree                               | JSONL session tree                             | 已有 `InteractionRecord` / `RuntimeOutputRecord` / `trace_events` / snapshots | P2 research        | 作为 debug/replay/share 格式，不替代 Store                                  |
| 08  | [Resource provenance / sourceInfo](./08-resource-provenance.md)    | `sourceInfo`                                   | 有 `PluginSource/rootPath`，未贯穿 runtime/tool/UI                            | **P0 proposed**    | trust、debug、package filtering 的地基                                      |
| 09  | Runtime / tool 动态激活策略                                        | `getActiveTools()` / `setActiveTools()`        | trigger/scheduler 已强；缺 tool-level/session-level active scope              | P1 backlog         | Kernel 控制，不交给 LLM 自由开关                                            |
| 10  | Event delivery mode                                                | steering / follow-up / nextTurn                | 已有 event trigger、background follower、plugin-rpc，但语义分散               | P1 backlog         | 收敛为 same-turn / follow-up / background / next-player-turn                |
| 11  | [Context budget breakdown](./11-context-budget-breakdown.md)       | `ctx.getContextUsage()`                        | 已有 budget pruning，缺分段 token 归因                                        | **P0/P1 proposed** | 和 #01 联动，支撑 prompt viewer/debug                                       |
| 12  | Authoring progressive disclosure                                   | Skills progressive disclosure                  | 已有 `PluginSummary` / `LoadedRuntime` 分层                                   | P2 backlog         | 限作者侧、调试侧；不让游戏 runtime 自主 read docs                           |
| 13  | Covel package manifest                                             | Pi packages                                    | Covel 有 plugin/world/prompt/ui/asset，但无统一 package manifest              | P2 backlog         | 应在 #08 provenance 与 #05 filtering 后做                                   |

## 不抄的部分（明确放弃）

| pi 的设计                                               | 不抄原因                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| “system prompt 越短越好，让 LLM 自己 read 文档发现能力” | coding-agent 思路；Covel narrator 需要稳定、可控、沉浸的 prompt                      |
| 让 LLM 在 session 里写新 extension 然后 `/reload`       | Covel 是玩家产品；runtime 自我修改属于作者侧 IDE 能力，不进游戏 runtime              |
| 全 system 权限运行 extension/package                    | Covel 的 trust tier / approval / scoped store view 是正确方向，不能砍                |
| 终端树 UI                                               | Web UI 应是 graph/timeline/snapshot view，而不是终端缩进 tree                        |
| 单 agent steering 原样照搬                              | Covel 是 priority band + DAG + multi-runtime；delivery mode 必须映射到 turn pipeline |
| JSONL 作为主 session 存储                               | Covel 已有关系/IDB/PG/SQLite store、snapshot、trace；JSONL 只做导出和 replay         |

## 推荐落地顺序

### P0：真实架构缺口，越早越好

1. #01 plugin-data visibility
2. #03 PreInput hook
3. #08 Resource provenance / sourceInfo
4. #11 Context budget breakdown

### P1：已有雏形，需要收敛成正式机制

1. #02 Hook payload semantics
2. #05 Runtime/tool/UI filtering
3. #10 Event delivery mode
4. #06 Dev-only hot reload

### P2：长线生态、调试、分发

1. #04 Fork branch summary
2. #07 Session export/replay/share
3. #12 Authoring progressive disclosure
4. #13 Covel package manifest

## 阅读顺序建议

1. 先读本 README，了解哪些是代码真实缺口、哪些是已有能力补强。
2. 先评审 P0 文档：#01 / #03 / #08 / #11。
3. 再看 P1：#02 / #05 / #10 / #06。
4. P2 提案依赖前面的 provenance、filtering、budget、summary 机制稳定后再细化。

## 评审 / 落地节奏

- 每份提案在合并落地前，正文 § 0.0 留位置写入 inline 评审意见 + 修订映射。
- 不要把评审意见单独存到 review.md。
- 提案的 P0-a/b/c/d 是该提案内部串行子阶段；P1/P2/P3 是更晚的、可能并行的阶段。
- 任何改变 framework-visible surface 的代码落地必须同步更新正式 docs：`docs/reference/plugins.md`、`docs/reference/tools.md`、`docs/reference/api.md`、`docs/reference/protocol.md` 等。

## 来源

- 仓库：[badlogic/pi-mono](https://github.com/badlogic/pi-mono)
- 关键文档：
  - `extensions.md` — 生命周期事件、ExtensionAPI、input/tool/session hooks
  - `skills.md` — 渐进披露
  - `packages.md` — 分发 + filtering + sourceInfo
  - `session.md` / `tree.md` — JSONL session tree、branch summary、fork/tree navigation

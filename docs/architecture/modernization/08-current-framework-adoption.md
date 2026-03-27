# 08. 现代化蓝图在当前框架下的采纳清单

这篇不是新蓝图。

它的目的只有一个：

- 把 `docs/architecture/modernization/*` 里真正适合现在纳入 `covel` 的部分，收敛成当前框架的执行边界

换句话说：

- 哪些现在就应该并入 `model-gateway + package-runtime + flow-engine + web host`
- 哪些应该作为下一阶段目标
- 哪些现在不应该硬塞进来

## 1. 当前判断

`covel` 现在最合理的方向不是“大换栈”，而是把现有骨架继续推进成：

- `context-centric`
- `capability-centric`
- `artifact-native`
- `host-runtime-first`

也就是：

- 后端继续围绕 `package-runtime + flow-engine + model-gateway`
- 前端继续围绕 `web host + registry-based UI`
- 数据层继续围绕 `storage dual-path + Postgres-first direction`

这同时意味着：

- turn / command / block response / workflow trigger 应共用一套执行模型
- 输出不该再只被理解成“文本回复”
- 前端不该再被理解成“一个聊天页面”

## 2. 现在采纳

### 2.1 Postgres-first, 但不放弃双路径

现在应采纳：

- PostgreSQL 作为长期主方向
- `pgvector + JSONB + event-aware tables`
- 仓库接口保持 `in-memory / postgres` 双实现

不应采纳：

- 现在就把仓库强制改成只支持 Postgres

原因：

- 当前仓库已经有双路径存储能力
- 这与 modernization 文档里的 `Postgres-first` 并不冲突
- 本地 demo、测试、CI 仍然需要 in-memory 路径

对当前框架的落点：

- `modules/storage`
- repository contracts
- retrieval tables
- package state / pending blocks / traces / archive tables

### 2.2 State Patch First

现在应采纳：

- 模型或 package 不直接写数据库
- 由 runtime 统一应用结构化 `state_patch`
- 事件表记录状态演化
- 命令写入统一遵循：
  - `command -> validation -> flow/workflow execution -> transactional persist -> emit`

原因：

- 当前很多旧功能仍停在“叙事文本里”
- 这会让角色、任务、关系、世界旗标无法可靠恢复

对当前框架的落点：

- `flow-engine` 输出结构
- package capabilities / hooks
- `packageState` repository
- future `world_state` / `entity_state` reducers

### 2.3 分层 Memory

现在应采纳：

- 把 memory 分成：
  - turn working memory
  - session memory
  - semantic memory
  - episodic memory
  - archive memory
  - retrieval memory

原因：

- 当前仓库已经有：
  - `context-graph`
  - `prompt-graph`
  - `memory-rag`
  - `archive`
  - `retrievalRuns`
- 这正适合渐进演化，而不是推翻重做

对当前框架的落点：

- package `contextProviders`
- `modules/memory-rag`
- `modules/context-graph`
- `modules/prompt-graph`
- archive restore / retrieval debug

### 2.4 Hybrid RAG -> Entity-aware Retrieval

现在应采纳：

- 先做 Hybrid RAG
- 再做 entity-aware retrieval

不应采纳：

- 一开始就做重型 full GraphRAG

原因：

- modernization 文档本身也明确建议分阶段
- 当前框架已经有足够的接入点，不需要另起系统

对当前框架的落点：

- `memory_documents`
- `memory_chunks`
- `retrieval_runs`
- future `entities / entity_edges`
- package contribution to memory sources

### 2.5 前端作为 Host Runtime

现在应采纳：

- 前端继续作为受信任宿主
- 保留三栏/多面板方向
- 强化 `timeline / blocks / artifacts / panels / inspectors`

不应采纳：

- 把所有 UI 逻辑继续堆进单个容器组件
- package 任意执行第三方前端代码

对当前框架的落点：

- `apps/web`
- registry-based block/artifact/panel rendering
- server-backed state + local interaction state 分层

这里应明确区分：

- `server-backed state`
  - worlds
  - sessions
  - timeline
  - traces
  - archives
  - world state summaries
- `local interaction state`
  - active panel
  - filters
  - drafts
  - playback position
  - optimistic pending action

### 2.6 强 Observability

现在应采纳：

- trace 更细
- retrieval / context / package invoke / state apply / resume 全部打点
- 为之后 eval / replay 做结构化数据准备

对当前框架的落点：

- `modules/observability`
- `traceRecords`
- web trace/debug panels

建议新增事件类型示例：

- `context.assembled`
- `context.provider.failed`
- `memory.retrieved`
- `state.patch.applied`
- `package.capability.invoked`
- `package.hook.invoked`

并且 trace 结构应尽量收敛到：

- `action.accepted`
- `context.resolved`
- `retrieval.completed`
- `prompt.compiled`
- `model.called`
- `package.invoked`
- `state.applied`
- `outputs.emitted`
- `memory.persisted`

## 3. 下一阶段采纳

### 3.1 Durable Workflow / Suspend-Resume Runtime

应作为下一阶段目标：

- `WorkflowDefinition`
- `WorkflowRun`
- `WorkflowSnapshot`
- step-level retry / idempotency

原因：

- 当前 `flow-engine` 已有最小 suspend/resume 骨架
- 但还没到需要直接引入 Temporal/LangGraph 那种完整执行模型的阶段

推荐方式：

- 先增强现有 `flow-engine`
- 再把 run/snapshot/step 显式化

### 3.2 Typed Stream Parts

值得做，但放在后面：

- 文本
- block
- artifact
- state patch
- workflow event

原因：

- 当前 `SSE envelope` 仍以事件流为主
- 现在直接切协议成本太高

### 3.3 Registry-based Panel/Inspector Runtime

值得做，但放在 context/state 跑稳之后：

- block registry
- artifact registry
- panel registry
- inspector registry

注意：

- 仍应坚持 host-bundled allowlist
- 不应开放任意 package frontend code

### 3.4 世界状态读模型

适合在 state patch 跑通之后跟进：

- `world_state_summary_view`
- `character_summary_view`
- `quest_board_view`
- `relationship_view`

## 4. 暂时避免

### 4.1 重型 GraphRAG 先行

暂时避免：

- 一开始就上完整图检索平台
- 独立图数据库
- 复杂图管线先行

### 4.2 过早拆多库

暂时避免：

- 现在就拆向量库
- 现在就拆图数据库
- 现在就拆状态数据库
- 现在就上独立日志平台

### 4.3 全量 local-first / 重同步方案

暂时避免：

- 全量 local-first
- 复杂离线同步优先
- 先上 Electric 式同步层

当前更合理的是：

- server truth
- HTTP / SSE
- 有选择地使用本地缓存

### 4.4 把外部 agent/runtime 框架直接塞进业务层

暂时避免：

- 直接引入 LangGraph / Mastra / Temporal 替换当前内核

更合理的用法：

- 把这些仓库当设计参考
- 先让当前内核显式化这些能力

## 5. 对 Extension / Plugin Framework 的直接影响

这几条应视为当前正式规范：

### 5.1 Extension 首先是 context / capability / artifact 的提供者

不是先把 extension 设计成“一个 UI 插件”。

优先级应是：

1. `contextProviders`
2. `capabilities`
3. `blocks`
4. `artifacts`
5. `commands`
6. `renderers`

### 5.2 五类输出协议应成为框架目标

当前已稳定的输出表面是：

- `message`
- `block`
- `artifact`

应明确预留并在下一阶段纳入的还有：

- `state_patch`
- `workflow_event`

也就是框架目标应是：

- `message / block / artifact / state_patch / workflow_event`

其中：

- 现在已真正可用的是前三类
- 后两类应作为正式路线而不是临时扩展

### 5.2 Package 文档必须服务于宿主和 agent

extension 的文档必须说明：

- 它贡献哪些 runtime surfaces
- 它如何影响 model turn
- 它如何通过 blocks/artifacts 与前端衔接
- 它不拥有哪些能力边界

### 5.3 Panel / Inspector 也应走宿主管理

现在就应接受的方向是：

- block registry
- artifact registry
- panel registry
- inspector registry

但现阶段应坚持：

- host-bundled allowlist
- 不开放任意 package frontend 执行

### 5.4 未来 package 开发速度应建立在模板化表面上

最快的 extension 类型应是：

- `context-only`
- `command-only`
- `host-known block + resume`

而不是：

- 任意自定义 renderer
- 任意自定义 provider
- 任意自定义 transport

## 6. 推荐当前执行顺序

按现在的框架，最值得的推进顺序是：

1. `context-graph -> retrieval -> prompt-graph -> flow-engine` 真闭环
2. `state_patch + reducer + package state + read models`
3. `host-bundled registry-based UI`
4. 再做 `durable workflow` 和 `typed stream parts`

## 7. 与当前文档的关系

这篇的作用是把 modernization 文档收敛成“当前框架的执行边界”。

它应被视为：

- `docs/EXTENSION-AUTHORING-SPEC.md`
- `docs/LEGACY-FEATURE-EXTENSION-MIGRATION.md`
- `.agent/skills/create-extension/*`

的上位约束补充。

# 07. 观测、评测、回放与迁移路线

## 1. 现代 AI 叙事系统为什么必须强观测

如果没有强观测，下面这些问题都会变成猜：

- 为什么这个回合取错了上下文
- 为什么这个 block 被发出来
- 为什么 quest 状态跳错了
- 为什么同一世界在不同 session 表现不一致
- 为什么某个 package 让 token 暴涨

所以 `covel` 必须把 observability 设计成一等能力，不是日志补丁。

## 2. 推荐观测层

### 2.1 Trace

记录一次执行链路上的 span：

- turn flow
- retrieval
- prompt build
- model call
- package invocation
- state reducer
- archive
- memory write

### 2.2 Metrics

- latency
- token usage
- cost
- retrieval hit count
- rerank latency
- block response latency
- workflow suspend duration

### 2.3 Logs

- app logs
- audit logs
- package safety logs
- moderation / policy decisions

### 2.4 Eval

- retrieval quality
- state patch correctness
- summary quality
- narrative consistency
- tool selection quality

## 3. 推荐 trace 结构

```text
trace
  span: action.accepted
  span: context.resolved
  span: retrieval.completed
  span: prompt.compiled
  span: model.called
  span: package.invoked
  span: state.applied
  span: outputs.emitted
  span: memory.persisted
```

## 4. 推荐前端调试面

至少应有：

- trace inspector
- retrieval run inspector
- workflow run inspector
- state patch inspector
- package invocation log
- token/cost inspector

## 5. 推荐评测体系

### 5.1 Retrieval Eval

检查：

- 是否命中正确来源
- 是否漏掉关键 chunk
- graph expansion 是否带来收益
- rerank 是否稳定

### 5.2 Narrative Eval

检查：

- 人设一致性
- 世界规则一致性
- 剧情连续性
- 长会话遗忘率

### 5.3 State Eval

检查：

- patch 是否正确
- quest/event 状态是否跳错
- relationship 是否异常漂移

## 6. 推荐落地路线

### 阶段 1：补闭环

- 把 `context-graph -> retrieval -> prompt-graph -> flow-engine` 接成真主链路
- 落 `memory_documents / memory_chunks / retrieval_runs / entity_edges`
- block 升级为 suspend/resume 节点
- 前端补状态面和 trace 面

### 阶段 2：补现代化能力

- package renderer registry
- typed stream parts
- state patch + reducer + event log
- archive reindex / replay
- retrieval inspector

### 阶段 3：补平台能力

- world editor / character editor / quest editor
- shared optimistic state
- selective local-first sync
- eval dashboard
- package authoring / inspection workbench

## 7. 你可以直接立项的专题

### 专题 A：Memory & GraphRAG M1

交付：

- 混合检索
- entity edges
- retrieval runs
- provenance

### 专题 B：State Patch Runtime M1

交付：

- state patch schema
- reducers
- event log
- read models

### 专题 C：Workflow Suspend/Resume M1

交付：

- workflow snapshots
- emit block / await input
- typed resume

### 专题 D：Workbench M1

交付：

- panel registry
- inspector registry
- trace/debug surfaces
- world/quest/character panels

## 8. 一组最小 demo 建议

### Demo 1：带检索解释的回合

用户输入后，右侧 inspector 能看到：

- 本回合检索了哪些来源
- 哪些 chunk 被选中
- 哪些 entity 邻接被扩展

### Demo 2：带状态面板的回合

用户推进剧情后，右侧面板直接显示：

- 当前 scene 变化
- quest stage 变化
- relationship 变化

### Demo 3：带 suspend/resume 的 block

模型发出 `choices` block 后：

- workflow run 标记为 `suspended`
- 用户点击后恢复到指定 step
- trace 显示恢复前后链路

### Demo 4：带 archive 和 replay 的长会话

用户可：

- 创建 archive
- fork
- 查看 archive summary
- 回放关键事件链

## 9. 这套蓝图和仓库现有文档怎么对应

- 总体产品方向：`docs/plans/next/00-architecture-whitepaper.md`
- 上下文与 flow：`docs/plans/next/04-context-prompt-and-flow-engine.md`
- 客户端方向：`docs/plans/next/05-client-host-and-multidevice-architecture.md`
- 当前差距：`docs/architecture/legacy-vs-current-gap-analysis.md`
- 当前 memory spec：`docs/architecture/specs/03-memory-rag-archive-observability-spec.md`

## 10. 最后的设计判断

如果只补旧项目缺失页面，`covel` 会回到“更复杂的旧项目”。

如果只做底层抽象，`covel` 又会继续停留在“很对但很薄”。

真正值得做的，是把两者合起来：

- 用更现代的 runtime / memory / workflow / host 设计
- 重建旧项目那种完整工作台与玩法闭环

这才是 `covel` 应该长成的下一阶段形态。

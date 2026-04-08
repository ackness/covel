# Phase 5: Kernel Pipeline（调度与提交）

依赖：Phase 1-4  
包名：`@covel/kernel`

## 目标

把 Kernel 明确为**纯编排器**：

- 解析 trigger
- 计算优先级执行计划
- 按组并行执行 runtime
- 在 runtime 级别提交结果
- 产出 published record 和 full trace

## 1. 调度步骤

```text
trigger routing
-> candidate filtering
-> priority grouping
-> same-priority parallel execution
-> runtime-level commit
-> publish records
-> continue to next priority group
```

## 2. 执行计划

### 2.1 分组规则

- 按 `priority` 从小到大分组
- 同优先级为一个并行组
- 当前组提交完成后，才进入下一个优先级组

### 2.2 可见性规则

- 当前组只能看到更小 priority 组已经提交的结果
- 看不到同组其他 runtime 本轮未提交结果
- 较大 priority 组可以读取较小 priority 组的 published records 和 live table 最新状态

## 3. runtime 原子提交

V1 建议 runtime 作为提交边界：

1. runtime 拿到一份执行快照
2. 期间的 tool / script 写操作先进入 runtime 当前事务
3. runtime 结束时：
   - 成功则提交 live tables + published record + trace
   - 失败则只发布 failed record 和 trace

## 4. pre-game 与正式 turn

### pre-game

- `priority < 100`
- 只在 `turn0` 跑一次
- 即使声明多次触发，也不会反复执行

### 正式 turn

- `priority 100-1000`
- 构成 `turn1 -> turn2 -> turn3`
- 默认无限次触发
- 可被 `maxRunsPerSession` / `maxRunsPerTurn` 限制

## 5. skipped / denied / failed

以下状态都要产出标准化记录：

- `success`
- `failed`
- `approval_denied`
- `skipped_condition`
- `skipped_limit`

这样做的目的：

- 调试时能知道为什么没跑
- 历史回放可以看到完整编排轨迹

## 6. schema 变更传播

- 如果较小 priority 的 runtime 修改了表 schema 并提交成功
- 本轮后续较大 priority 的 runtime 立刻可见
- 同 priority 并行 runtime 不可见

## 7. 失败策略

V1 默认：

- 单个 runtime 失败，不阻塞后续较大 priority 的 runtime
- 失败信息通过 published record 和 trace 暴露

## 8. 建议接口

```typescript
interface KernelSession {
  executeTurn(input: KernelInput): Promise<KernelTurnResult>;
  executeRuntime(runtimeId: string, options?: RuntimeExecuteOptions): Promise<RuntimeExecuteResult>;
  executeAction(actionId: string, options?: ActionExecuteOptions): Promise<ActionExecuteResult>;
}
```

## 9. 手动 action workflow

对于插件声明的 `actions`：

- action 本身不是 runtime
- action 是一次统一的手动工作流入口
- workflow steps 由框架顺序执行

建议语义：

1. 前端点击 action
2. 框架创建 `workflowRunId`
3. 按步骤串行执行 runtime
4. 每一步都写 trace 和 published record
5. 下一步显式收到上一 runtime 的结构化输出
6. 前端按 workflow 状态展示 `queued -> running -> completed / failed`

### 错误处理

V1 workflow 错误处理规则：

- **步骤失败即终止**：任一步骤的 runtime 返回 `failed` / `approval_denied`，整个 workflow 立即终止，不继续后续步骤
- **已完成步骤保留**：已成功提交的步骤的 published record 和表写入不回滚
- **workflow 状态**：框架将 workflow 标记为 `failed`，记录失败在哪一步
- **无自动重试**：V1 不提供自动重试，前端可重新发起整个 action
- **无条件分支**：V1 workflow 只支持线性串行，不支持条件分支或并行步骤

workflow 失败结果示例：

```json
{
  "workflowRunId": "wf-001",
  "status": "failed",
  "failedAtStep": "image-generator",
  "steps": [
    { "runtimeId": "prompt-optimizer", "status": "completed" },
    { "runtimeId": "image-generator", "status": "failed" }
  ]
}
```

## 10. Event-triggered Runtime 调度规则

当 runtime 通过 `kernel:emit_domain_event` 产生业务事件时，可能触发其他声明了 `trigger.type = "event"` 的 runtime。

### V1 规则：事件触发统一推迟到下一 turn

- 本 turn 执行期间产生的 domain event **不会**在本 turn 内立即触发新的 runtime
- 框架将本 turn 的 domain events 收集到事件队列
- 在下一 turn 开始时，框架检查队列中的事件，触发匹配的 event-triggered runtime
- event-triggered runtime 仍然按其声明的 priority 参与分组排序

这样做的好处：

- 避免 turn 内调度图不可预测（A 触发 B，B 触发 C...）
- 保持 priority 分组执行的可确定性
- 简化并发模型

### 调度流程

```text
turn N:
  1. 执行 priority group 300 -> runtime A emit "quest.completed"
  2. 框架将 "quest.completed" 加入事件队列
  3. 继续执行 priority group 500, 600...
  4. turn N 结束

turn N+1:
  1. 框架检查事件队列，发现 "quest.completed"
  2. runtime B 声明监听 "quest.completed"，加入本 turn 候选列表
  3. B 按其 priority 参与正常分组执行
```

### 约束

- 同一事件不会重复触发同一 runtime（按 `eventId + runtimeId` 去重）
- event-triggered runtime 同样受 `maxRunsPerSession` / `maxRunsPerTurn` 限制
- 事件队列中未被任何 runtime 消费的事件仍然被记录为 domain event record

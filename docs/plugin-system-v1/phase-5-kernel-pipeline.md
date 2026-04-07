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

- 当前组只能看到更高优先级组已经提交的结果
- 看不到同组其他 runtime 本轮未提交结果
- 低优先级组可以读取高优先级组的 published records 和 live table 最新状态

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

- 如果高优先级 runtime 修改了表 schema 并提交成功
- 本轮后续更低优先级 runtime 立刻可见
- 同优先级并行 runtime 不可见

## 7. 失败策略

V1 默认：

- 单个 runtime 失败，不阻塞后续更低优先级 runtime
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

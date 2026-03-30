# Runtime Kernel 规格

时间：2026-03-29  
状态：草案  
类型：实现规格

## 1. 目的

定义运行时内核的模块边界、执行链、输入输出合同和首轮必须稳定的不变量。

本文件回答：

- kernel 负责什么
- kernel 不负责什么
- 一次 turn 如何执行
- proposal / validate / commit 如何衔接
- 首轮实现最少需要哪些模块

## 2. 范围

### 2.1 纳入范围

- 输入与事件入口
- runtime 选择与调度
- context 组装
- runtime 执行
- tool / hook 控制链
- proposal 收集
- validation / policy
- commit 与 render 衔接

### 2.2 不纳入范围

- 具体世界规则
- 具体插件内部逻辑
- 详细数据库字段实现
- 前端页面结构

## 3. Kernel 边界

### 3.1 Kernel 负责

- 接收用户输入和系统事件
- 将输入转为触发事件
- 根据 trigger 规则选择 runtime
- 按 phase、priority 和 budget 调度 runtime
- 组装 runtime 需要的 context
- 驱动 runtime 的 tool / hook 循环
- 收集 proposal
- 调用 validation / policy / commit
- 输出渲染结果与 follow-up events

### 3.2 Kernel 不负责

- 写死具体玩法规则
- 直接暴露数据库给插件
- 直接持有某个具体 world 的业务逻辑
- 让插件绕过提交链写状态

## 4. 系统级执行链

```mermaid
flowchart TD
    A["Input / Event"] --> B["Trigger Router"]
    B --> C["Runtime Scheduler"]
    C --> D["Context Assembly"]
    D --> E["Runtime Runner"]
    E --> F["Tool / Hook Loop"]
    F --> G["Proposal Collector"]
    G --> H["Validation / Policy"]
    H --> I["Commit Service"]
    I --> J["Render / Side Effects"]
    J --> K["Follow-up Events / Background Jobs"]
```

首轮默认 gameplay profile：

- `story` phase 由主模型负责 narrative
- `post_story` phase 常作为 gameplay / mechanics runtime 的默认触发时机
- 资产类 runtime 默认采用 `manual` 触发
- `background` phase 负责 memory、archive、索引和异步任务

## 5. 核心模块

### 5.1 Trigger Router

职责：

- 识别输入类型
- 生成 `RuntimeTriggerEvent`
- 根据 runtime trigger 规则筛选候选 runtime
- 评估 hook + trigger 条件，而不是只按“对话后”理解触发时机

输入：

- `KernelInput`

输出：

- `RuntimeTriggerEvent`
- `CandidateRuntime[]`

首轮应支持的触发来源至少包括：

- session 开始
- narrative 结束事件
- 显式动作 / 按钮事件
- interval / 每 N 轮
- context 阈值
- 业务目标达成事件

### 5.2 Runtime Scheduler

职责：

- 根据 phase 和排序规则选择执行顺序
- 应用 budget、priority、去重规则
- 将后台任务与同步任务分流

首轮排序规则：

1. `phase`
2. dependency topology layer
3. `plugin.loadingOrder`
4. runtime explicit priority
5. runtime id 稳定排序

首轮 phase：

- `pre_story`
- `story`
- `post_story`
- `background`

规则：

- 同一拓扑层的 plugin runtime 可并行执行
- `post_story` 是常见默认时机，但不是唯一时机
- `manual` 触发型 runtime 仅在显式触发事件下进入调度

### 5.3 Context Assembly

职责：

- 依据 runtime spec 组装最小上下文
- 根据 read scopes 裁剪数据
- 保证 context 为只读视图
- 解析并注入当前 turn 的目标 locale
- 按 locale 回退规则选择 world / plugin / prompt 资源

首轮 slices：

- `chat`
- `world`
- `characters`
- `state`
- `record`
- `events`
- `runtime`
- `runtimeSettings`
- `narrative`
- `archive`

规则：

- 不返回全量系统状态
- 优先裁剪历史与检索结果
- 不裁剪 runtime 自身合同字段
- locale 必须显式进入 context
- 若当前 runtime 依赖主叙事结果，可在 context 中注入当前 turn 的 narrative 输出
- run 的 phase / status、当前 branch 以及必要的 archive summary 应作为可选 slice 注入
- prompt 组装必须优先使用前端当前选择的语言
- 缺失对应语言内容时，先回退到设置默认语言，再回退到资产默认语言

### 5.4 Runtime Runner

职责：

- 加载 runtime instructions
- 绑定 provider binding、tools、hooks、budget
- 驱动 tool calling 循环

首轮支持：

- `story`
- `plugin`
- `background`

首轮保留但不执行：

- `verifier`

### 5.5 Tool / Hook Loop

职责：

- 执行 runtime 请求的 tool / script / provider
- 在生命周期点执行 hook
- 将 observation 回传 runtime

规则：

- runtime 仅可调用白名单中的 tools
- hook 可守卫、改写、审计、阻断
- hook 不应替代 runtime 做主要推演

Hook 排序规则：

同一生命周期点存在多个 hook 时，执行顺序按以下优先级确定：

1. 依赖拓扑层：被依赖的插件的 hook 先执行
2. `plugin.loadingOrder`：拓扑层相同时按 loadingOrder 排序
3. hook 注册顺序：loadingOrder 也相同时，按 manifest 中 hooks 数组的声明顺序

守卫型 hook（effect = `deny`）一旦触发立即终止链路，不执行后续 hook。

### 5.6 Proposal Collector

职责：

- 接收 runtime 与工具返回的 proposal-like 输出
- 统一归一为 `KernelProposalEnvelope`
- 维护 trace 与来源信息

首轮 proposal kinds：

- `narrative.append`
- `state.patch`
- `event.emit`
- `record.upsert`
- `ui.render`
- `asset.generate`

### 5.7 Validation / Policy

职责：

- schema 校验
- 权限校验
- policy 校验
- 幂等和冲突检查

输入：

- `KernelProposalEnvelope`

输出：

- `ValidatedProposalEnvelope`

### 5.8 Commit Service

职责：

- 写 `State`
- 追加 `Event`
- 更新 `Record`
- 生成 `Snapshot` 元数据
- 发出 committed events

输入：

- `ValidatedProposalEnvelope`
- 当前 `run / branch / snapshot` 信息

输出：

- `CommitResult`

### 5.9 Render / Side Effects

职责：

- 将 commit 结果映射到消息块、面板更新和副作用
- 触发 follow-up events 和后台任务

规则：

- 不绕过 commit 直接写状态
- 不重新解释业务事实

## 6. Turn 合同

### 6.1 输入合同

```ts
export interface KernelInput {
  runId: string;
  branchId: string;
  actorId: string;
  type: "user.input" | "system.event";
  locale?: string;
  payload: Record<string, unknown>;
}
```

### 6.2 输出合同

```ts
export interface KernelTurnResult {
  runId: string;
  branchId: string;
  turnId: string;
  traceId: string;
  locale: string;
  proposals: KernelProposalEnvelope[];
  commit?: CommitResult;
  render: RenderResult;
  followUpEvents: RuntimeTriggerEvent[];
}
```

## 7. Proposal 合同

```ts
export interface KernelProposalEnvelope {
  proposalId: string;
  runId: string;
  branchId: string;
  turnId: string;
  runtimeId: string;
  pluginId: string;
  traceId: string;
  items: KernelProposalItem[];
}
```

约束：

- proposal 必须带来源信息
- runtime 不直接落盘
- tool 的写结果必须归并为 proposal

## 8. Runtime Context 合同

```ts
export interface RuntimeContextView {
  run: {
    runId: string;
    worldId?: string;
    branchId: string;
    turnId: string;
    status?: string;
    phase?: string;
    defaultLocale?: string;
    activeBranchId?: string;
  };
  locale: string;
  world?: unknown;
  chat?: unknown;
  characters?: unknown[];
  state?: unknown;
  record?: unknown[];
  events?: RuntimeTriggerEvent[];
  runtimeSettings?: {
    flat?: Record<string, unknown>;
    byPlugin?: Record<string, Record<string, unknown>>;
  };
  narrative?: {
    content: string;
    messageId?: string;
  };
  archive?: {
    activeVersion?: number;
    latestVersion?: number;
    summary?: string;
  };
  runtime: {
    runtimeId: string;
    pluginId: string;
    kind: string;
    phase: string;
    allowedTools: string[];
    providerBinding?: string;
    budget?: RuntimeBudget;
    isolation?: RuntimeIsolationSpec;
  };
}
```

约束：

- context 为只读视图
- runtime 不能假设所有 slice 永远存在
- 修改系统事实只能经由 tool / proposal
- `locale` 是当前轮次的目标输出语言，而不是建议性提示

## 9. Locale 解析与传播

kernel 必须明确处理 locale，而不是把语言选择交给 runtime 或 provider 猜测。

首轮最低支持语言集合固定为：

- `zh-CN`
- `en-US`

解析顺序：

1. `KernelInput.locale`
2. `run.defaultLocale`
3. `world.defaultLocale`
4. 应用默认语言 `zh-CN`

传播规则：

- 解析出的 locale 进入 `RuntimeContextView.locale`
- render 层按该 locale 选择展示文本
- follow-up events 可继承当前 turn locale
- committed events 若包含用户可见文本，应记录生成时 locale
- 请求了超出最低支持集合的 locale 时，kernel 必须显式回退，默认回退到 `zh-CN`

资源选择回退规则：

1. 前端当前选择的语言
2. 设置中的默认语言
3. world / plugin 资源自身默认语言

## 10. 调度不变量

首轮必须满足：

1. 同一 runtime 在同一 turn 默认只执行一次。
2. 多步动作通过 tool calling 完成，而不是再次重新调度同一 runtime。
3. 单 runtime 的 tool calling 次数必须有上限。
4. `background` 不阻塞主响应，但必须有 trace。
5. 所有写操作统一进入 `proposal -> validate -> commit`。
6. 同一阶段先按依赖拓扑分层，再在层内并行执行。
7. `manual` 触发的 runtime 不得在未收到显式事件时自动调度。
8. `budget.maxTokens` 为 best-effort 约束：runner 应在每次 LLM 调用后累加 token 消耗，在接近上限时截断循环，但不保证精确限制（尤其在流式输出场景下）。首轮优先依赖 `maxSteps` 和 `timeoutMs` 作为硬性限制。

### 10.1 并行 Proposal 冲突策略

同层并行 runtime 可能同时产出 `state.patch` proposal 修改相同 scope 下的 key。首轮冲突解决策略：

1. **scope 隔离优先**：每个插件的 state.patch 应声明不同的 scope 前缀（如 `plugin.combat`、`plugin.inventory`），scope 不同的 patch 无冲突。
2. **同 scope 同 key 冲突检测**：若两个并行 runtime 修改了同一 scope 的同一 key，validation 层必须检测到冲突。
3. **默认策略为拒绝**：首轮检测到同 key 冲突时，默认拒绝后提交的 proposal 并记录 trace，不做自动合并。
4. **拓扑层优先级**：若冲突双方处于不同拓扑层，低层（先执行）的 proposal 优先。
5. **后续可扩展**：未来可引入 merge function、last-write-wins 或 OT 策略，但首轮不做。

## 11. 错误处理

首轮 failure policy：

- `continue`
- `stop`
- `retry`
- `disable_runtime`

规则：

- runtime 失败不得破坏已提交事实
- 未通过 validation 的 proposal 不得进入 commit
- background runtime 失败应记录 trace 和审计
- 因 locale 缺失导致的语言决策不得回退为隐式猜测，应使用明确 fallback

## 12. 可观测性

kernel 全链路必须保留：

- `traceId`
- `runId`
- `branchId`
- `turnId`
- `runtimeId`
- `pluginId`

首轮必须追踪：

- runtime 调度
- tool 调用
- hook 决策
- provider 请求
- DB 提交
- locale 解析结果
- 依赖拓扑层结果
- 触发原因（hook / event / interval / manual）

## 13. 首轮建议目录

```text
kernel/
  router/
  scheduler/
  context/
  runner/
  tools/
  hooks/
  proposals/
  validation/
  commit/
  render/
```

## 14. 首轮明确延期项

- 更多公开 phase
- verifier runtime 调度
- 复杂并行 runtime 编排
- 跨小时 durable workflow
- 细粒度可视化回放系统
- 完整多语言内容编排器

## 15. 结论

Runtime Kernel 的核心不是“做更多事情”，而是保证所有运行时行为都经过统一、可追踪、可验证、可提交的执行链。  
只要这条主链稳定，玩法和插件数量的增加通常不会迫使内核整体重写。

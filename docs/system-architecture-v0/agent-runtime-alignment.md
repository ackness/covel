# Covel × Agent Runtime 设计模式 — 架构对比与演进方案

时间：2026-04-01  
状态：草案  
类型：架构演进分析  
参考：design-coding-agent-runtime skill (runtime-blueprint, context-patterns, extension-patterns, trust-and-permissions, reliability-and-recovery)

## 1. 目的

基于成熟 coding-agent runtime 的设计模式（6 层架构、5 类 context carrier、5 阶段 extension lifecycle、4 层信任模型），对 Covel 当前架构做系统性评审，识别可直接复用的模式和必须补齐的能力缺口。

## 2. 评审总分：19/36

| 维度 | 评分(0-4) | 说明 |
|------|-----------|------|
| Runtime Boundaries | 3 | 层次分明，但 bootstrap/session 边界未显式分离 |
| Context Architecture | 3 | 有分层 prompt 组装，但 stable/volatile 未严格分开 |
| Wire Validity | 1 | 缺少消息规范化层 |
| Trust & Permissions | 1 | 仅有 proposal 验证，无工作区信任/源策略 |
| Extension Model | 3 | 5 阶段中已有 discovery/validation/registration/execution |
| Compaction & Resume | 0 | 完全缺失 |
| Reliability | 2 | 有基本错误隔离，缺少分级重试 |
| Productization | 3 | SSE 流式输出、三面板 UI、Model Slot |
| Operability | 3 | traceId 链路追踪设计已有 |

## 3. 已对齐的设计

### 3.1 Turn Loop ≈ Kernel Execution Pipeline

Covel 的 `kernel.ts` 执行管线与 agent runtime 的 Turn Loop 高度同构：

| Agent Runtime Turn Loop | Covel Pipeline |
|------------------------|----------------|
| prepare context | `TurnContextStore.init()` |
| normalize wire messages | _(缺失)_ |
| call model | `runRuntime()` → `executor.execute()` |
| stream output | SSE via gateway |
| execute tools | `executeTool()` in tool loop |
| inject attachments | `contextStore.ingest()` |
| recurse or terminate | `for (group of plan.groups)` 循环 |

关键差异：Covel 的"递归"是多个 runtime 间的优先级组顺序执行，而非单次 turn 内的 tool-call 递归。这是有意的设计——Covel 的 "agent" 是多个协作 runtime 组成的管线。

### 3.2 Extension Registry ≈ PluginHost

`PluginHost` 已覆盖 Extension Patterns 的核心阶段：

| Extension Phase | Covel 实现 |
|----------------|-----------|
| Discovery | `scanPluginDirectory()` — FS 扫描 |
| Validation | `manifestValidator` + `validateConstraints()` |
| Projection | 按 surface 分发到 tool/hook/runtime/command registry |
| Activation | `pluginRegistry.add()` → registries |
| Execution | Turn loop 中消费 projected registries |

亮点：已实现 "canonical record + per-surface registry" 模式。

### 3.3 Context Carriers ≈ PromptAssembler 分层

`assemblePrompt()` 已实现 5 载体中的 4 个：

| Context Carrier | Covel 对应 |
|----------------|-----------|
| Stable System Prompt | Context fragments + PLUGIN.md instructions |
| Appended System Context | `<world>`, `<state>`, `<characters>` sections |
| Meta User Context | 部分（通过 world content） |
| Turn Attachments | `<previous_outputs>` — 前序 runtime 输出注入 |
| Tool Schema | 通过 tool whitelist 声明，但不作为独立 context carrier |

### 3.4 Proposal Chain ≈ Agent Safety Gate

`proposal → validate → commit` 链与 agent runtime 的 per-action approval 对齐。所有副作用都有类型化的 proposal item，这比 agent runtime 的 "tool result" 更结构化。

## 4. 能力缺口与演进方案

### 4.1 [P0] Wire Message 规范化层

**问题**：`assemblePrompt` 直接将 `chat` 数组传给 LLM，无规范化。长 session 中断恢复、工具调用中断、不完整消息序列等场景会导致 API 调用失败。

**参考**：context-patterns.md §Message Normalization Is Mandatory

**方案**：

在 `@covel/context` 中新增 `normalizeMessages()` 函数，在 `assemblePrompt` 输出前调用：

```typescript
// packages/context/src/normalizer/message-normalizer.ts

interface NormalizeOptions {
  /** 目标 LLM 的消息格式要求 */
  provider: 'openai' | 'anthropic' | 'generic';
  /** 是否过滤 UI-only 消息 */
  stripUiMessages: boolean;
}

interface NormalizeResult {
  messages: TextMessage[];
  /** 被移除/修复的消息记录 */
  repairs: RepairRecord[];
}

function normalizeMessages(
  messages: TextMessage[],
  options: NormalizeOptions
): NormalizeResult;
```

规范化规则：
1. 确保消息序列以 user/system 开头（非 assistant）
2. 修复连续相同 role 的消息（合并或插入分隔）
3. 修复 tool-use / tool-result 配对不完整（移除孤立的 tool-result）
4. 过滤 UI-only 消息（`ui.render` block 不应进入 LLM context）
5. 剥离不支持的 content block 类型

**影响范围**：`packages/context/src/assembler/prompt-assembler.ts`

**验收标准**：
- 任意 chat history 经过 normalize 后可直接传给 LLM API 而不报错
- 中断恢复后的不完整对话也能通过规范化

### 4.2 [P0] Compaction & Resume 基础框架

**问题**：长 session 的 chat history 无限增长，没有压缩和恢复机制。RPG 游戏 session 可能持续数百 turn，token 成本和上下文质量都会退化。

**参考**：runtime-blueprint.md §Compaction Blueprint, §Resume Blueprint

**方案**：

#### 4.2.1 Compaction

在 `@covel/context` 中新增 compaction 子系统：

```typescript
// packages/context/src/compaction/compactor.ts

interface CompactionResult {
  /** 压缩边界标记（turn ID） */
  boundary: string;
  /** 摘要文本（由 LLM 生成） */
  summary: string;
  /** 保留的最近消息 */
  preservedMessages: TextMessage[];
  /** 重水化包 — 模型在压缩后仍需知道的状态 */
  rehydrationBundle: RehydrationBundle;
}

interface RehydrationBundle {
  /** 当前 state snapshot */
  state: Record<string, unknown>;
  /** 活跃角色快照 */
  activeCharacters: CharacterCard[];
  /** 最近 N 条 events */
  recentEvents: EventEntry[];
  /** 当前 run phase */
  phase: string;
  /** 活跃的 plugin runtime 配置 */
  activeRuntimes: RuntimeSummary[];
}
```

压缩触发策略：
1. token 估算超过阈值时（如 context window 的 60%）
2. 按 turn 数阈值（如每 50 turns）
3. 手动触发（玩家点击"整理记忆"）

压缩执行顺序（先廉价再昂贵）：
1. 移除旧的 tool-call 详细结果（保留摘要）
2. 移除重复的 state 快照（只保留最新）
3. 合并连续的短对话消息
4. LLM 摘要压缩（最后手段）

#### 4.2.2 Resume

利用 Covel 已有的 **Snapshot + Branch** 模型：

```typescript
// packages/context/src/compaction/resumption.ts

interface ResumeInput {
  /** 从 snapshot 恢复的 state */
  snapshot: SnapshotData;
  /** 压缩摘要 */
  compactionSummary?: string;
  /** 重水化包 */
  rehydration?: RehydrationBundle;
}

interface ResumeResult {
  /** 重建的 TurnContextInit */
  contextInit: TurnContextInit;
  /** 重建的 chat history（摘要 + 最近消息） */
  chatHistory: TextMessage[];
  /** 恢复是否完整 */
  validity: 'full' | 'partial' | 'degraded';
}

function resumeFromSnapshot(input: ResumeInput): ResumeResult;
```

**成功标准**：resume 后的下一个 turn 可以正常执行，不需要手工修复。

**影响范围**：
- 新建 `packages/context/src/compaction/` 目录
- 修改 `TurnContextStore` 增加 `compact()` 接口
- 修改 `kernel.ts` 在 turn 开始时检查是否需要 compaction

### 4.3 [P1] Stable Prefix / Volatile Tail 分离

**问题**：`assemblePrompt` 把所有内容拼进一个 system message。高频变化的 `<state>` 和 `<previous_outputs>` 破坏了 prompt cache。

**参考**：context-patterns.md §Stable Prefix, Volatile Tail

**方案**：

将 system message 拆为两段：

```
System Message 1 (stable, cacheable):
  ├─ Context Provider Fragments
  ├─ Runtime Instructions (PLUGIN.md)
  ├─ [Locale: xx-XX]
  └─ <world>...</world>  (极少变化)

System Message 2 (volatile, per-turn):
  ├─ <characters>...</characters>  (可能变化)
  ├─ <state>...</state>  (每 turn 变化)
  ├─ <archive>...</archive>
  └─ <previous_outputs>...</previous_outputs>
```

实现要点：
- `assemblePrompt` 返回 `stableMessages` + `volatileMessages`
- `@covel/runtime` 的 executor 识别并设置 cache breakpoint
- Anthropic API 使用 `cache_control` 标记
- OpenAI 使用 predicted outputs / system prompt caching

**预期收益**：重复 turn 中 stable prefix 命中 prompt cache，token 成本降低 50-70%。

### 4.4 [P1] Background Task Runtime

**问题**：priority 900+ 的后台 runtime（memory-summarizer、archiver）和前台 runtime 使用同一执行路径，导致玩家需要等待后台任务完成才能看到结果。

**参考**：runtime-structure.md §Background Task Runtime

**方案**：

```typescript
// packages/kernel/src/types.ts

interface BackgroundTask {
  taskId: string;
  runtimeId: string;
  pluginId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
  result?: RuntimeRunResult;
  error?: string;
  startedAt: number;
  completedAt?: number;
}
```

执行策略变更：
1. Kernel `executeTurn` 对 priority < 800 的 runtime 同步执行
2. priority >= 800 的 runtime 包装为 `BackgroundTask`，异步执行
3. Turn result 立即返回给前端（包含前台 runtime 的输出）
4. 后台任务完成后通过 follow-up event 触发下一轮注入
5. `BackgroundTask` 的状态持久化到 session，compaction 时保留

**阈值** 800 可在 runtime settings 中配置。

### 4.5 [P1] Runtime Abort / Timeout 语义

**问题**：runtime spec 中已声明 `budget.timeoutMs` 和 `budget.maxSteps`，但执行时未实际检查。

**参考**：runtime-structure.md §Subagent Runtime — "its own abort semantics"

**方案**：

```typescript
// packages/kernel/src/runner/runtime-runner.ts 修改

async function runRuntime(deps, runtime, context, options) {
  const budget = runtime.spec.budget;
  const controller = new AbortController();

  // Timeout guard
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (budget?.timeoutMs) {
    timeoutHandle = setTimeout(() => controller.abort('timeout'), budget.timeoutMs);
  }

  try {
    const result = await executor.execute(input, { signal: controller.signal });
    return result;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
```

同时需要 `@covel/runtime` 的 executor 支持 `AbortSignal` 传播。

### 4.6 [P2] Bootstrap / Session 显式分离

**问题**：`createKernel()` 将 bootstrap（插件扫描、registry 构建）和 session（game state、turn 执行）混在一个闭包中。

**参考**：runtime-blueprint.md §Layer Responsibilities

**方案**：

```typescript
// 目标 API

// Bootstrap: 一次性初始化，产出不可变的 registries
const bootstrap = await bootstrapKernel({
  pluginsDir: './plugins',
  // settings, policy...
});

// Session: 持有 mutable game state，执行 turns
const session = bootstrap.createSession({
  runId: '...',
  world: worldData,
  characters: [],
});

const result = await session.executeTurn(input);
```

好处：
- 多 session 可共享同一 bootstrap（同一 PluginHost）
- bootstrap 失败不影响已有 session
- 支持 plugin hot-reload：重新 bootstrap 后 swap registries

### 4.7 [P2] Trust Layer 接口预留

**问题**：当前唯一的安全门是 proposal validation。缺少工作区信任、源策略、能力策略。

**参考**：trust-and-permissions.md §四层信任模型

**方案**：

首轮仅定义接口，不实现完整策略引擎：

```typescript
// packages/shared/src/types/trust.ts

interface TrustContext {
  /** 工作区是否可信（允许执行插件代码） */
  workspaceTrusted: boolean;
  /** 插件源信任级别 */
  sourcePolicy: Record<string, 'trusted' | 'sandboxed' | 'blocked'>;
  /** 能力策略：哪些 tool kind 允许自动执行 */
  capabilityPolicy: {
    autoApprove: ToolKind[];
    requireConfirm: ToolKind[];
    blocked: ToolKind[];
  };
}
```

在 `createKernel` 中接受 `TrustContext`，在 `runRuntime` 前检查 `sourcePolicy`，在 `executeTool` 前检查 `capabilityPolicy`。

## 5. Covel 独有的可反向启发 Agent Runtime 的设计

| Covel 特性 | Agent Runtime 可学习点 |
|-----------|---------------------|
| Priority Scheduler (0-1000) | 多 agent 编排不需要递归，优先级组更灵活 |
| Typed Proposal Items | 所有副作用有类型（narrative.append, state.patch, event.emit, record.upsert, ui.render），比 agent 的 "tool result → attachment" 更结构化 |
| TurnContextStore.ingest() | 每个 runtime 输出自动成为下一个 runtime 的 context，比 attachment system 更精确 |
| Model Slot System | Agent runtime 通常只有一个 model；Covel 的 slot routing 适合多 agent 场景 |
| Content Asset Model | World/Character/Plugin 三类资产比 agent 的纯 code context 更丰富 |

## 6. 迁移优先级总表

| 优先级 | 任务 | 影响范围 | 预估复杂度 |
|--------|------|---------|-----------|
| P0 | Wire message 规范化层 | @covel/context | 中 |
| P0 | Compaction & Resume 基础框架 | @covel/context, kernel | 高 |
| P1 | Stable/Volatile prompt 分离 | @covel/context, @covel/runtime | 中 |
| P1 | Background Task Runtime | kernel | 中 |
| P1 | Runtime abort/timeout 语义 | kernel, @covel/runtime | 低 |
| P2 | Bootstrap/Session 显式分离 | kernel | 中 |
| P2 | Trust Layer 接口预留 | shared, kernel | 低 |

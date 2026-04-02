# Observability & Runtime Trace System

时间：2026-04-02
状态：设计方案
目标：玩家可观测完整的 runtime 执行链路（提示词、LLM 请求响应、工具调用、提案产出），前端调试页面可视化，可选对接 Langfuse 等外部 trace 平台。

## 1. 设计原则

1. **玩家数据主权**：所有 LLM 交互数据（prompt、response、tool calls）对玩家完全透明，可在前端调试页查看和导出。
2. **Runtime 为核心粒度**：每个 runtime 执行产生一条 `RuntimeTrace`，是最小可观测单元。Turn 级别聚合为 `TurnTrace`，Session 级别聚合为时间线。
3. **Delta 记录**：LLM 是无状态的，prompt 由历史拼接而成。trace 只记录本轮**新增的 context 部分**（新 instructions、新 fragments、新 chat messages），不重复存储完整 prompt 历史。同时保留一个 `promptSnapshot` 字段存储完整 prompt（可选，默认关闭以节省空间）。
4. **双通道**：runtime trace 走结构化 trace 系统；非 runtime 部分（server 启动、plugin 加载、DB 操作等）走传统日志库（推荐 `pino`）。
5. **Langfuse 可选集成**：trace 数据结构与 Langfuse span 模型对齐，启用 Langfuse 时自动上报，不启用时数据仍完整保留在内存/本地。

## 2. 数据模型

### 2.1 Trace 层级

```
SessionTimeline (session 维度)
  └── TurnTrace (每轮)
        ├── meta: { turnId, traceId, runId, branchId, turnNumber, locale, inputType, startedAt, completedAt }
        ├── triggerResult: { event, candidateCount, candidateRuntimeIds[] }
        ├── executionPlan: { groups: [{ priority, runtimeIds[] }] }
        └── runtimeTraces: RuntimeTrace[] (按执行顺序)
              ├── meta: { runtimeId, pluginId, priority, kind, triggerMode, isBackground }
              ├── provider: { presetId, provider, model, slotId }
              ├── context: ContextTrace
              ├── llm: LlmTrace
              ├── tools: ToolCallTrace[]
              ├── proposals: ProposalTrace[]
              ├── hooks: HookTrace[]
              ├── usage: { inputTokens, outputTokens, totalTokens, durationMs }
              └── result: { status, text, error? }
```

### 2.2 核心类型定义

```typescript
/** 一次 runtime 执行的完整 trace */
interface RuntimeTrace {
  // ── 身份 ──
  traceId: string;
  turnId: string;
  runId: string;
  branchId: string;
  runtimeId: string;
  pluginId: string;

  // ── 调度信息 ──
  priority: number;
  kind: RuntimeKind;                    // story | plugin | background | verifier
  triggerMode: string;                  // always | interval | manual | event
  triggerEvent?: RuntimeTriggerEvent;   // 触发的原始事件
  isBackground: boolean;
  groupIndex: number;                   // 在 executionPlan 中的组序号

  // ── Provider 绑定 ──
  provider: {
    slotId: string;                     // heavy | fast | balance
    presetId: string;
    providerName: string;               // openai | anthropic | deepseek | dashscope
    model: string;
    parameterOverrides?: Record<string, unknown>;
  };

  // ── Context (Delta) ──
  context: {
    /** 本次注入的 context fragments (来自 context providers) */
    fragments: Array<{
      id: string;
      pluginId: string;
      title: string;
      contentPreview: string;           // 截断到 500 chars 的预览
      contentLength: number;
      priority: number;
    }>;
    /** PLUGIN.md 指令（截断预览） */
    instructionsPreview: string;
    instructionsLength: number;
    /** 本轮新增的 chat 消息数量（不重复存储完整历史） */
    newChatMessageCount: number;
    /** 累积的 completed runtime outputs 数量（从 TurnContextStore） */
    priorRuntimeOutputCount: number;
    /** 可选：完整 prompt 快照（仅在 debug 模式或手动开启时） */
    promptSnapshot?: TextMessage[];
  };

  // ── LLM 调用链 ──
  llmCalls: LlmCallTrace[];

  // ── 工具调用 ──
  toolCalls: ToolCallTrace[];

  // ── 提案产出 ──
  proposals: ProposalTrace[];

  // ── Hook 执行 ──
  hooks: HookTrace[];

  // ── 汇总 ──
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    durationMs: number;
    llmCallCount: number;
    toolCallCount: number;
  };
  status: "completed" | "failed" | "timeout" | "budget_exhausted";
  error?: string;
  startedAt: string;    // ISO timestamp
  completedAt: string;
}

/** 单次 LLM 请求的 trace（一个 runtime 可能有多次，因为 tool-calling loop） */
interface LlmCallTrace {
  callIndex: number;                   // 在 loop 中的序号（0-based）
  presetId: string;
  model: string;
  /** Delta: 本次新增的 messages（相对于上一次 call） */
  newMessages: Array<{
    role: string;
    contentPreview: string;
    contentLength: number;
  }>;
  /** 本次发送的总消息数（用于理解上下文窗口占用） */
  totalMessageCount: number;
  /** 是否包含 tools 定义 */
  hasTools: boolean;
  toolCount: number;
  // 响应
  responseText: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

/** 工具调用 trace */
interface ToolCallTrace {
  callIndex: number;
  qualifiedToolId: string;             // pluginId:toolId
  pluginId: string;
  toolKind: string;                    // query | mutate | emit | render | ...
  input: unknown;                      // 原始输入参数
  output: unknown;                     // 原始输出
  proposals: Array<{ kind: string }>;  // 工具产生的 proposal 类型
  blocked: boolean;                    // 是否被 hook 拦截
  blockReason?: string;
  durationMs: number;
  error?: string;
  startedAt: string;
  completedAt: string;
}

/** Proposal trace */
interface ProposalTrace {
  kind: ProposalKind;
  source: "llm" | "tool";             // 来自 LLM 直接输出还是工具
  payloadPreview: string;              // JSON 截断预览
  payloadSize: number;
  validated: boolean;
  rejected: boolean;
  rejectReason?: string;
}

/** Hook 执行 trace */
interface HookTrace {
  hookId: string;
  event: HookEvent;
  pluginId: string;
  allowed: boolean;
  reason?: string;
  durationMs: number;
}

/** Turn 级别聚合 */
interface TurnTrace {
  turnId: string;
  traceId: string;
  runId: string;
  branchId: string;
  turnNumber: number;
  locale: string;
  inputType: string;                   // user.input | session_start | ...
  inputPayloadPreview: string;

  // 调度结果
  trigger: {
    eventType: string;
    candidateCount: number;
    candidateRuntimeIds: string[];
  };
  executionPlan: {
    groups: Array<{
      priority: number;
      runtimeIds: string[];
      isBackground: boolean;
    }>;
  };

  // Runtime traces (按执行顺序)
  runtimes: RuntimeTrace[];

  // 提交结果
  commit?: {
    commitId: string;
    proposalCount: number;
    rejectedCount: number;
    snapshotId?: string;
  };

  // 渲染结果
  render: {
    blockCount: number;
    blockTypes: string[];
  };

  // 汇总
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    durationMs: number;
    runtimeCount: number;
    llmCallCount: number;
    toolCallCount: number;
  };

  startedAt: string;
  completedAt: string;
}
```

## 3. 架构设计

### 3.1 新增 Package: `@covel/trace`

```
packages/trace/
  src/
    types.ts                — 上述类型定义
    trace-collector.ts      — TraceCollector 接口和内存实现
    runtime-trace-builder.ts — 构建 RuntimeTrace 的 builder
    turn-trace-builder.ts   — 构建 TurnTrace 的 builder
    langfuse-exporter.ts    — 可选 Langfuse span 导出
    index.ts
```

**设计决策**：独立 package 而非放在 kernel 内部，因为 trace 数据会被 server（SSE 推送）、前端（调试页面）、以及外部平台（Langfuse）三方消费。

### 3.2 TraceCollector 接口

```typescript
interface TraceCollector {
  /** 开始一个 turn trace */
  startTurn(meta: TurnTraceMeta): TurnTraceHandle;
  /** 查询 session 的所有 turn traces */
  listTurns(sessionId: string): TurnTrace[];
  /** 查询单个 turn 的详细 trace */
  getTurn(turnId: string): TurnTrace | undefined;
  /** 查询单个 runtime 的详细 trace */
  getRuntime(turnId: string, runtimeId: string): RuntimeTrace | undefined;
  /** 导出 session 的全部 trace（用于前端下载） */
  exportSession(sessionId: string): SessionTraceExport;
  /** 清理过期 trace */
  prune(olderThan: Date): void;
}

interface TurnTraceHandle {
  /** 添加调度信息 */
  setTriggerResult(result: TriggerResult): void;
  setExecutionPlan(plan: ExecutionPlanTrace): void;
  /** 开始一个 runtime trace */
  startRuntime(meta: RuntimeTraceMeta): RuntimeTraceHandle;
  /** 设置提交结果 */
  setCommitResult(result: CommitResultTrace): void;
  /** 完成 turn */
  complete(): void;
  fail(error: string): void;
}

interface RuntimeTraceHandle {
  /** 设置 provider 信息 */
  setProvider(info: ProviderInfo): void;
  /** 设置 context 信息 */
  setContext(ctx: ContextTrace): void;
  /** 记录一次 LLM 调用 */
  addLlmCall(call: LlmCallTrace): void;
  /** 记录一次工具调用 */
  addToolCall(call: ToolCallTrace): void;
  /** 记录 proposal */
  addProposal(proposal: ProposalTrace): void;
  /** 记录 hook 执行 */
  addHook(hook: HookTrace): void;
  /** 完成 runtime */
  complete(usage: UsageSummary): void;
  fail(error: string): void;
}
```

### 3.3 存储策略

**首轮方案：内存存储 + SSE 推送**

```typescript
class MemoryTraceCollector implements TraceCollector {
  // sessionId → TurnTrace[]
  private traces = new Map<string, TurnTrace[]>();
  // 保留最近 N 个 turn 的 trace（默认 50）
  private maxTurnsPerSession = 50;
}
```

- 开发阶段和单人游戏足够用，无需持久化
- 前端通过 SSE 实时接收 + REST API 查询历史
- 后续可扩展为 SQLite / IndexedDB（前端侧）/ PostgreSQL

### 3.4 集成点

#### 3.4.1 Kernel 集成（核心）

在 `kernel.ts` 的 `executeTurn` 中注入 trace 收集：

```typescript
// kernel.ts executeTurn() 伪代码
async executeTurn(input, options) {
  const turnHandle = traceCollector.startTurn({
    turnId, traceId, runId, branchId, turnNumber, locale, inputType
  });

  // 1. Trigger routing
  const { triggerEvent, candidates } = routeTrigger(...);
  turnHandle.setTriggerResult({ event: triggerEvent, candidates });

  // 2. Scheduling
  const plan = buildExecutionPlan(...);
  turnHandle.setExecutionPlan(plan);

  // 3. For each runtime
  for (const group of plan.groups) {
    for (const scheduled of group) {
      const rtHandle = turnHandle.startRuntime({
        runtimeId, pluginId, priority, kind, triggerMode, isBackground
      });

      // Provider binding
      rtHandle.setProvider({ slotId, presetId, provider, model });

      // Context assembly (record delta only)
      rtHandle.setContext({
        fragments: contextFragments.map(f => ({ ...f, contentPreview: truncate(f.content) })),
        instructionsPreview: truncate(instructions),
        newChatMessageCount: newMessages.length,
        priorRuntimeOutputCount: completedRuntimes.length,
      });

      // Execute and trace
      const result = await runRuntime(deps, runtime, context, {
        ...options,
        traceHandle: rtHandle,  // 传入 handle 让 runner 记录细节
      });

      rtHandle.complete(result.usage);
    }
  }

  turnHandle.setCommitResult({ commitId, proposalCount, rejectedCount });
  turnHandle.complete();
}
```

#### 3.4.2 RuntimeRunner 集成

`runtime-runner.ts` 在 tool-calling loop 中已有 `onProgress` 回调，增加 `traceHandle` 参数：

```typescript
// runtime-runner.ts 伪代码改动
for (let step = 0; step < maxSteps; step++) {
  const callStart = Date.now();
  const result = await gateway.generateText(...);

  // 记录 LLM 调用
  traceHandle?.addLlmCall({
    callIndex: step,
    presetId,
    model,
    newMessages: getNewMessages(messages, previousMessageCount),
    totalMessageCount: messages.length,
    hasTools: toolDefinitions.length > 0,
    toolCount: toolDefinitions.length,
    responseText: result.text,
    toolCalls: result.toolCalls,
    finishReason: result.finishReason,
    usage: result.usage,
    durationMs: Date.now() - callStart,
  });

  // 工具调用也记录
  for (const toolCall of result.toolCalls) {
    const toolStart = Date.now();
    const toolResult = await executeTool(...);
    traceHandle?.addToolCall({
      callIndex,
      qualifiedToolId: toolCall.name,
      input: parsedArgs,
      output: toolResult.output,
      proposals: toolResult.proposals.map(p => ({ kind: p.kind })),
      blocked: toolResult.blocked,
      durationMs: Date.now() - toolStart,
    });
  }
}
```

#### 3.4.3 Server SSE 推送

新增 SSE 事件类型用于实时 trace 推送：

```typescript
// 新 SSE 事件类型
"trace.runtime.started"    // runtime 开始执行，携带 provider/context 信息
"trace.llm.call"           // 每次 LLM 调用完成，携带 delta messages + response
"trace.tool.call"          // 工具调用完成，携带 input/output
"trace.runtime.completed"  // runtime 执行完成，携带 usage 汇总
"trace.turn.completed"     // turn 完成，携带全局汇总
```

前端可选择是否订阅 trace 事件（通过 query param 或 header）：
- 默认不推送（节省带宽）
- debug 页面开启时自动订阅
- 玩家在设置中可手动开启

#### 3.4.4 REST API 端点

```
GET  /api/trace/sessions/:sessionId/turns          — 列出 session 的所有 turn traces
GET  /api/trace/turns/:turnId                       — 获取单个 turn 的完整 trace
GET  /api/trace/turns/:turnId/runtimes/:runtimeId   — 获取单个 runtime 的详细 trace
GET  /api/trace/sessions/:sessionId/export          — 导出 session 全部 trace (JSON)
GET  /api/trace/sessions/:sessionId/timeline        — 获取 session 时间线（轻量级，只有 meta + usage）
```

#### 3.4.5 Langfuse 集成增强

当前 Langfuse hook 只记录 provider 级别的 request start/success/error。增强为：

```
Langfuse Trace (traceId)
  ├── Span: "turn" (turnId)
  │     ├── metadata: { runId, branchId, turnNumber, locale, inputType }
  │     ├── Span: "runtime:core-persona" (runtimeId)
  │     │     ├── metadata: { pluginId, priority, kind, slotId, presetId }
  │     │     ├── Generation: "llm-call-0"
  │     │     │     ├── input: messages (delta)
  │     │     │     ├── output: response text
  │     │     │     ├── model, usage, duration
  │     │     │     └── metadata: { toolCount, finishReason }
  │     │     ├── Span: "tool:kernel:state.get"
  │     │     │     ├── input, output, duration
  │     │     │     └── metadata: { toolKind, blocked }
  │     │     └── Generation: "llm-call-1" (after tool results)
  │     ├── Span: "runtime:core-narrator"
  │     │     └── ...
  │     └── Span: "commit"
  │           └── metadata: { proposalCount, rejectedCount }
  └── metadata: { sessionId, totalUsage }
```

改造 `langfuse.ts`：

```typescript
// 从 ProviderLifecycleHook 升级为 TraceExporter 接口
interface TraceExporter {
  onTurnStart(turn: TurnTraceMeta): void;
  onRuntimeStart(runtime: RuntimeTraceMeta): void;
  onLlmCall(call: LlmCallTrace): void;
  onToolCall(call: ToolCallTrace): void;
  onRuntimeComplete(runtime: RuntimeTrace): void;
  onTurnComplete(turn: TurnTrace): void;
}
```

现有的 `ProviderLifecycleHook` 保持兼容（仍作为 gateway 级别的 hook），`TraceExporter` 是更高层的 kernel 级别接口。两者可共存——ProviderLifecycleHook 关注单个 LLM 请求，TraceExporter 关注整个执行链。

## 4. 前端调试页面设计

### 4.1 改造现有 `/debug` 页面

现有 debug.tsx 有 4 个 tab（Database Tables / Execution Traces / Live Prompts / Branch Management）但都是 mock 数据。改造为：

**Tab 1: Session Timeline（会话时间线）**
- 左侧：session 列表（从 store 加载）
- 右侧：选中 session 的 turn 时间线
  - 每个 turn 显示为一行：turnNumber | inputType | runtime 数量 | 总 tokens | 耗时
  - 颜色编码：正常(绿) | 有拒绝 proposal(黄) | 失败(红)
  - 点击展开查看 execution plan（priority groups → runtime 排列）

**Tab 2: Runtime Inspector（Runtime 检查器）**
- 选中某个 runtime trace 后的详细视图
- 左栏：基本信息（runtime ID、plugin、priority、provider binding）
- 中栏：LLM 交互流
  - 每次 LLM call 显示为一个卡片
  - 卡片内：新增 messages（delta 部分高亮）| response text | tool calls
  - Token 使用饼图
- 右栏：工具调用列表
  - 每个工具调用：name | input (JSON collapsible) | output (JSON collapsible) | duration | blocked?
- 底部：Proposals 产出列表（kind | payload preview | validated/rejected）

**Tab 3: Prompt Viewer（提示词查看器）**
- 选中 runtime 的完整 prompt 重建视图
- 分段显示：System Prompt | Context Fragments | Instructions | Chat History | Tool Definitions
- 每段标注来源（哪个 plugin 的 fragment、instructions 文件路径等）
- Delta 模式：与上一轮同 runtime 的 prompt 做 diff，高亮新增部分
- 可折叠/展开每个部分
- 一键复制完整 prompt

**Tab 4: Data Explorer（数据浏览器）**
- 保留原有 Database Tables 功能
- 增加：State diff viewer（每轮 state.patch 的变化）
- 增加：Event log（append-only 事件流）
- 增加：Record browser（key-value 记录浏览）

### 4.2 前端 Store

```typescript
// stores/trace-store.tsx
interface TraceState {
  // 当前选中
  selectedSessionId: string | null;
  selectedTurnId: string | null;
  selectedRuntimeId: string | null;

  // 数据
  turnTimeline: TurnTraceSummary[];    // 轻量级时间线
  currentTurn: TurnTrace | null;       // 选中的完整 turn trace
  currentRuntime: RuntimeTrace | null; // 选中的完整 runtime trace

  // 实时
  liveTraceEnabled: boolean;           // 是否接收实时 trace SSE
  liveTurnTrace: Partial<TurnTrace> | null;  // 正在执行的 turn
}
```

### 4.3 实时更新策略

- Debug 页面打开时，自动开启一个 SSE 连接订阅 trace 事件
- trace 事件增量更新到 `liveTurnTrace`
- 当 turn 完成时，`liveTurnTrace` 归档到 `turnTimeline`
- 游戏页面不订阅 trace SSE（避免额外开销）

## 5. 非 Runtime 日志

### 5.1 日志库选择：pino

- 结构化 JSON 日志，高性能
- 支持 child logger（携带 context 字段如 sessionId、pluginId）
- 浏览器端有 `pino/browser` 支持（如需要前端日志）

### 5.2 日志使用场景

```typescript
import pino from "pino";

const logger = pino({ name: "covel" });

// Server 启动
logger.info({ port: 3001 }, "Server started");

// Plugin 加载
const pluginLog = logger.child({ component: "plugin-host" });
pluginLog.info({ pluginId: "core-narrator", version: "1.0.0" }, "Plugin loaded");

// DB 操作
const dbLog = logger.child({ component: "store" });
dbLog.debug({ sessionId, operation: "addMessage" }, "Message stored");

// 非 runtime 的 AI 操作（如 preset ping）
const aiLog = logger.child({ component: "ai-provider" });
aiLog.info({ presetId, latencyMs: 234 }, "Preset ping success");
```

### 5.3 日志与 Trace 的边界

| 场景 | 系统 | 说明 |
|------|------|------|
| Runtime 执行（LLM、工具、提案） | Trace | 结构化，前端可查 |
| Turn 调度（trigger、scheduler） | Trace | 属于 turn trace 的一部分 |
| Hook 执行 | Trace | 属于 runtime trace |
| Server 请求处理 | Logger | Hono middleware |
| Plugin 加载/卸载 | Logger | 启动阶段 |
| DB 读写（非 commit） | Logger | 基础设施层 |
| SSE 连接管理 | Logger | 连接生命周期 |
| 错误/异常 | 两者 | runtime 内的错误进 trace，其他进 logger |

## 6. 实现计划

### Phase 1: 核心 Trace 采集（P0）

1. **新建 `packages/trace`**
   - 定义 types.ts（上述所有类型）
   - 实现 MemoryTraceCollector
   - 实现 RuntimeTraceBuilder / TurnTraceBuilder

2. **Kernel 集成**
   - `kernel.ts` executeTurn 中插入 trace 收集
   - `runtime-runner.ts` 增加 traceHandle 参数，记录 LLM calls 和 tool calls
   - `proposal-collector.ts` 记录 proposal trace
   - `hook-executor.ts` 记录 hook trace

3. **Server 端**
   - 注入 TraceCollector 到 kernel session
   - 新增 `/api/trace/*` REST 路由
   - 在 SSE `/actions` 中可选推送 trace 事件

### Phase 2: 前端调试页面（P1）

4. **Trace Store**
   - 新建 `stores/trace-store.tsx`
   - API service 增加 trace 相关调用

5. **Debug 页面改造**
   - Session Timeline tab
   - Runtime Inspector tab
   - Prompt Viewer tab
   - Data Explorer tab 增强

### Phase 3: Langfuse 增强 + 导出（P2）

6. **Langfuse TraceExporter**
   - 实现 TraceExporter 接口
   - 从 kernel trace handle 同步到 Langfuse span 层级

7. **导出功能**
   - Session trace 导出为 JSON
   - 可导入到其他 trace 平台的格式转换

### Phase 4: 传统日志（P2）

8. **pino 集成**
   - 安装 pino
   - 替换现有 console.warn/error
   - 配置日志级别和输出格式

## 7. 依赖关系

```
@covel/trace (新包)
  ├── 依赖 @covel/shared (类型)
  ├── 被 @covel/kernel 使用 (trace 采集)
  ├── 被 @covel/server 使用 (REST API + SSE)
  └── 可选依赖 langfuse (导出)

@covel/kernel
  └── 新增依赖 @covel/trace

@covel/server
  └── 新增依赖 @covel/trace

@covel/web
  └── 消费 trace REST API + SSE 事件（无直接 package 依赖）
```

## 8. Prompt Delta 策略详解

由于 LLM 是无状态的，每次调用都携带完整的 prompt history。为避免 trace 中存储大量重复数据：

### 8.1 Turn 内 Delta（同一 runtime 的多次 LLM call）

Tool-calling loop 中，每次 LLM call 相比上一次多了：
- 上次 LLM 的 assistant response（含 tool_calls）
- 每个 tool 的 result message

**记录策略**：`LlmCallTrace.newMessages` 只存新增的 messages，`totalMessageCount` 表示总数。

### 8.2 Turn 间 Delta（同一 runtime 跨 turn）

同一个 runtime 在 turn N 和 turn N+1 的 prompt 差异通常是：
- 新增的 chat history（用户消息 + 上一轮助手回复）
- 新增的 context fragments（可能因 state 变化而不同）
- 新增的 prior runtime outputs（TurnContextStore 积累）

**记录策略**：
- `context.newChatMessageCount`：本轮新增 chat 消息数
- `context.fragments`：本轮的 fragments 列表（每轮可能不同）
- `context.priorRuntimeOutputCount`：本轮已完成的前置 runtime 数

### 8.3 完整 Prompt 快照

可选的 `promptSnapshot` 字段存储完整 TextMessage[]。控制方式：
- 环境变量 `COVEL_TRACE_FULL_PROMPT=true`
- 前端 debug 设置中开启
- 默认关闭

## 9. 安全考虑

- Trace 数据可能包含玩家的游戏内容，不应上传到未授权的外部服务
- Langfuse 集成需要明确的用户授权（环境变量配置）
- 前端 trace API 应遵循同源策略，不暴露到公网
- 导出的 trace JSON 不包含 API key（已有保障：key 只在 header 中传递）
- Trace 数据的内存占用需要限制（maxTurnsPerSession 配置）

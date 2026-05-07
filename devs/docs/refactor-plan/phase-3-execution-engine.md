# Phase 3: 执行引擎与调度器

> 预计工作量：5-7 天
> 前置依赖：Phase 1（类型系统）、Phase 2（插件注册表）
> 交付物：优先级调度器、Runtime Runner、LLM 集成、上下文组装

---

## 3.1 目标

实现 Turn 的完整执行管线：从玩家输入到所有 Runtime 按优先级编排执行，输出结构化结果。

## 3.2 执行管线总览

```
TurnInput（玩家消息）
  → Trigger Router（过滤本轮应执行的 Runtime）
  → Priority Scheduler（按优先级分组、排序）
  → [For each priority group, 并行执行:]
      → Context Builder（组装上下文）
      → Runtime Runner（驱动 LLM + tool-calling loop）
      → Output Validator（验证结构化输出）
      → Result Recorder（记录执行结果）
  → Conflict Detector（检测写冲突）
  → [如有冲突] Audit Runtime 执行
  → Turn Complete → 返回 TurnResult
```

## 3.3 Trigger Router

根据 Runtime 的 trigger 配置决定本轮是否执行：

```typescript
// @covel/runtime

export interface TriggerContext {
  sessionId: string;
  turnNumber: number;
  /** 该 Runtime 在本 session 中已执行的次数 */
  triggerCount: number;
  /** 距上次触发的轮次数 */
  turnsSinceLastTrigger: number;
  /** 当前待处理的事件列表 */
  pendingEvents: CovelMessage[];
  /** 前序 Runtime 是否有失败 */
  hasUpstreamFailure: boolean;
  /** 上下文 token 估算 */
  estimatedContextTokens: number;
}

export interface TriggerEvaluator {
  /**
   * 判断 Runtime 是否应在本轮触发。
   * 返回 true = 执行，false = 跳过。
   */
  shouldTrigger(manifest: RuntimeManifest, context: TriggerContext): boolean;
}
```

### 触发类型实现

| 类型          | 判断逻辑                                                      |
| ------------- | ------------------------------------------------------------- |
| `auto`        | 始终返回 true                                                 |
| `manual`      | 仅当 `pendingEvents` 中有 `manual-trigger` 事件且 target 匹配 |
| `scheduled`   | `turnNumber % interval === 0`                                 |
| `conditional` | 评估条件表达式（如 `estimatedContextTokens > 4000`）          |
| `event`       | `pendingEvents` 中有匹配 `topic` 的事件                       |
| `error-retry` | `hasUpstreamFailure === true` 且重试次数未超限                |

还需检查全局限制：

- `maxTriggerCount` → 未超过 session 内最大触发次数
- `cooldownTurns` → 距上次触发轮次间隔足够

## 3.4 Priority Scheduler

```typescript
export interface ScheduledGroup {
  priority: number;
  runtimes: RuntimeManifest[];
  /** 组内是否可并行（无互相依赖） */
  canParallelize: boolean;
}

export interface PriorityScheduler {
  /**
   * 将待执行的 Runtime 按优先级分组排序。
   * 同优先级为一组（并行候选），不同优先级按升序。
   * priority 0 = 最高优先级 = 最先执行。
   */
  schedule(runtimes: RuntimeManifest[]): ScheduledGroup[];
}
```

### 依赖分析

同优先级组内的 Runtime 默认可并行，但需检查 `input.inject` 和 `input.tools` 声明的依赖：

```typescript
export interface DependencyAnalyzer {
  /**
   * 分析 Runtime 间的依赖关系。
   * 返回依赖图（DAG）。
   */
  analyze(runtimes: RuntimeManifest[]): DependencyGraph;

  /**
   * 检查同优先级组内是否有依赖冲突。
   * 如果 A 依赖 B 但 A.priority === B.priority，报警告。
   */
  validate(runtimes: RuntimeManifest[]): ValidationResult;
}

export interface DependencyGraph {
  /** pluginId/runtimeId → 它依赖的 pluginId/runtimeId 列表 */
  edges: Map<string, string[]>;
  /** 拓扑排序后的执行顺序 */
  topologicalOrder: string[];
  /** 检测到的循环依赖 */
  cycles: string[][];
}
```

### 优先级频段

```
0-99    Pre-Game       游戏初始化
100-499 Pre-Turn       叙事前处理
500     Narrator       主叙事输出（核心）
501-999 After-Turn     叙事后处理
1000    Audit          冲突裁决（条件触发）
```

## 3.5 Runtime Runner

核心执行器，驱动单个 Runtime 的 LLM 调用循环。

```typescript
export interface RuntimeRunnerConfig {
  /** 最大 tool-calling 步数 */
  maxSteps: number;
  /** 超时毫秒数 */
  timeoutMs: number;
  /** 最大输出 token */
  maxTokens?: number;
}

export interface RuntimeRunner {
  /**
   * 执行单个 Runtime。
   * 1. 组装上下文（system prompt + 注入的数据）
   * 2. 调用 LLM（带 tool-calling）
   * 3. 处理 tool calls（循环直到 LLM 给出最终回答）
   * 4. 验证输出 schema
   * 5. 返回 RuntimeResult
   */
  execute(params: RuntimeExecuteParams): Promise<RuntimeResult>;
}

export interface RuntimeExecuteParams {
  /** 已加载的 Runtime 资源 */
  loadedRuntime: LoadedRuntime;
  /** 组装好的上下文 */
  context: AssembledContext;
  /** LLM provider */
  provider: LLMProvider;
  /** 可用工具列表 */
  tools: ResolvedTool[];
  /** 执行配置 */
  config: RuntimeRunnerConfig;
  /** 审批回调 */
  onApprovalRequired?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 进度回调（用于 SSE 推送） */
  onProgress?: (event: RuntimeProgressEvent) => void;
}
```

### LLM Tool-Calling Loop

```
1. 构建初始 messages: [system, ...context_messages]
2. 调用 LLM（带 tools 定义）
3. if LLM 返回 tool_calls:
     for each tool_call:
       a. 审批检查 → 通过/拒绝
       b. 执行 tool → 获取 result
       c. 将 tool result 追加到 messages
     goto 2 (步数 < maxSteps)
4. if LLM 返回 text/json → 视为最终输出
5. 验证输出 schema → 通过/重试
6. 返回 RuntimeResult
```

## 3.6 Context Builder

```typescript
// @covel/context

export interface AssembledContext {
  /** 完整的 system prompt（PLUGIN.md body + 注入数据 + UI 组件列表） */
  systemPrompt: string;
  /** 额外的 context messages（历史对话等） */
  messages: LLMMessage[];
  /** 可用工具的 JSON Schema 定义 */
  toolDefinitions: ToolDefinition[];
  /** output schema（如有） */
  outputSchema?: Record<string, unknown>;
}

export interface ContextBuilder {
  /**
   * 为指定 Runtime 组装完整的执行上下文。
   */
  build(params: ContextBuildParams): Promise<AssembledContext>;
}

export interface ContextBuildParams {
  /** Runtime 的 prompt template */
  promptTemplate: string;
  /** Runtime 的 manifest */
  manifest: RuntimeManifest;
  /** 当前 Turn 的输入 */
  turnInput: TurnInput;
  /** 已完成的其他 Runtime 结果（用于 inject） */
  completedResults: Map<string, RuntimeResult>;
  /** 按需加载的 references */
  references: ParsedReference[];
  /** Runtime 的有效配置 */
  config: Record<string, unknown>;
  /** 可用的 UI 组件类型列表 */
  availableUIComponents: string[];
}
```

### 模板变量替换

支持的模板变量语法：

```
{{ inputs.pluginId.runtimeId.fieldName }}  → 其他 Runtime 的输出字段
{{ config.fieldName }}                     → 当前 Runtime 的配置值
{{ session.turnNumber }}                   → 当前轮次号
{{ session.id }}                           → Session ID
{{ player.message }}                       → 玩家当前消息
```

### inject 处理

将 `input.inject` 声明的数据以 XML 标签形式插入 system prompt：

```
原始模板中有：
<narrator-output>{{ inputs.narrator.main.narrativeOutput }}</narrator-output>

替换后：
<narrator-output>你走进了黑暗的森林，空气中弥漫着腐叶的气味...</narrator-output>
```

### References 按需注入

1. 遍历 Runtime 关联的 references
2. 检查当前上下文（玩家消息 + 已有数据）是否包含触发关键词
3. 如果命中关键词，将 reference 内容追加到 system prompt

## 3.7 LLM Provider 抽象

沿用现有的 `@covel/ai-provider` 包的 slot 机制，但简化接口：

```typescript
export interface LLMProvider {
  /** 调用 LLM（非流式） */
  generate(params: LLMGenerateParams): Promise<LLMGenerateResult>;
  /** 调用 LLM（流式） */
  stream(params: LLMGenerateParams): AsyncIterable<LLMStreamChunk>;
}

export interface LLMGenerateParams {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  /** Structured Output 的 JSON Schema */
  responseFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  };
  maxTokens?: number;
  temperature?: number;
}

export interface LLMGenerateResult {
  content: string | null;
  toolCalls: LLMToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  finishReason: "stop" | "tool_calls" | "length" | "error";
}
```

## 3.8 Turn Executor（编排入口）

```typescript
export interface TurnExecutor {
  /**
   * 执行一个完整的 Turn。
   * 这是整个执行引擎的入口点。
   */
  executeTurn(input: TurnInput): Promise<TurnResult>;
}
```

### 执行流程伪代码

```typescript
async function executeTurn(input: TurnInput): Promise<TurnResult> {
  // 1. 获取 session 的活跃 Runtime 列表
  const activeRuntimes = registry.getActiveRuntimes(input.sessionId);

  // 2. Trigger Router 过滤
  const triggeredRuntimes = activeRuntimes.filter(rt =>
    triggerEvaluator.shouldTrigger(rt, buildTriggerContext(input))
  );

  // 3. Priority Scheduler 分组排序
  const groups = scheduler.schedule(triggeredRuntimes);

  // 4. 逐组执行
  const allResults = new Map<string, RuntimeResult>();
  for (const group of groups) {
    if (group.canParallelize) {
      // 并行执行同优先级组
      const results = await Promise.allSettled(
        group.runtimes.map(rt => executeOneRuntime(rt, input, allResults))
      );
      // 收集结果
    } else {
      // 按依赖顺序串行执行
      for (const rt of group.runtimes) {
        const result = await executeOneRuntime(rt, input, allResults);
        allResults.set(`${rt.pluginId}/${rt.name}`, result);
      }
    }
  }

  // 5. 检测写冲突
  const conflicts = conflictDetector.detect(allResults);

  // 6. 如有冲突，触发 Audit Runtime
  let auditResult: RuntimeResult | undefined;
  if (conflicts.length > 0) {
    auditResult = await executeAuditRuntime(conflicts, input);
  }

  // 7. 组装 TurnResult
  return { ... };
}
```

## 3.9 最低保障原则

Narrator（priority 500）的正常运行是最高优先级：

1. 任何 Pre-Turn Runtime 失败不得影响 Narrator 执行
2. 如果 Narrator 依赖的 inject 数据不可用（上游失败），使用空值或降级提示
3. After-Turn Runtime 失败不影响已完成的 Narrator 输出返回给玩家
4. 错误被记录但不传播到 Turn 级别

```typescript
export interface ErrorPolicy {
  /** Runtime 失败时的处理策略 */
  onRuntimeFailure(
    failedRuntime: RuntimeManifest,
    error: Error,
    dependents: RuntimeManifest[],
  ): FailureAction;
}

export type FailureAction =
  | { type: "skip-dependents" } // 跳过所有依赖它的 Runtime
  | { type: "continue" } // 忽略错误继续
  | { type: "retry"; maxRetries: number }; // 重试
```

## 3.10 验收标准

- [ ] 完整的 Turn 执行管线可运行（输入 → 调度 → 执行 → 输出）
- [ ] Trigger Router 六种触发类型均正确判断
- [ ] Priority Scheduler 正确分组排序，依赖分析正确
- [ ] Runtime Runner 的 tool-calling loop 正常工作
- [ ] Context Builder 正确填充模板变量和 inject 数据
- [ ] References 关键词触发机制正常
- [ ] 同优先级 Runtime 可并行执行
- [ ] Narrator 失败保护机制生效
- [ ] 单元测试 + 集成测试覆盖率 ≥ 80%

## 3.11 参考实现

- **VoltAgent** 的 Supervisor Pattern：supervisor agent 协调多个 sub-agent，每个 sub-agent 有独立的 tools 和 instructions。类比 Covel 的 Turn Executor 协调多个 Runtime
- **Mastra** 的 Workflow Pipeline：`createStep` → `.then()` → `.commit()`，步骤间可传递 typed data。类比 Covel 的优先级分组串行执行 + inject 数据传递
- **LangGraph.js** 的图式执行引擎：节点是 agent/tool，边是执行流，支持条件分支和循环

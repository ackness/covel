# Phase 6: 并发编排、冲突裁决与审批管线

> 预计工作量：4-5 天
> 前置依赖：Phase 3（执行引擎）、Phase 4（工具系统）、Phase 5（状态管理）
> 交付物：并发执行控制、写冲突检测与 Audit Plugin、审批管线、错误处理

---

## 6.1 目标

实现多 Runtime 的安全并发执行、状态写冲突的 LLM 裁决机制、工具调用的 Human-in-the-Loop 审批管线。

## 6.2 并发执行控制

### 6.2.1 并行执行器

```typescript
// @covel/runtime

export interface ParallelExecutor {
  /**
   * 并行执行一组 Runtime。
   *
   * 策略：
   * 1. 同优先级组内的 Runtime 默认并行执行
   * 2. 如果存在组内依赖（A inject B 的输出），自动调整为串行
   * 3. 使用 Promise.allSettled 确保一个失败不影响其他
   * 4. 所有结果收集后统一提交状态变更
   */
  executeGroup(
    group: ScheduledGroup,
    input: TurnInput,
    completedResults: Map<string, RuntimeResult>,
  ): Promise<Map<string, RuntimeResult>>;
}
```

### 6.2.2 依赖解析与执行图

```typescript
export interface ExecutionGraph {
  /** 构建执行图（基于 input.inject 和 input.tools 声明） */
  build(runtimes: RuntimeManifest[]): ExecutionPlan;
}

export interface ExecutionPlan {
  /** 可并行的执行批次 */
  batches: RuntimeManifest[][];
  /** 依赖关系 */
  dependencies: Map<string, string[]>;
  /** 是否存在循环依赖 */
  hasCycles: boolean;
  /** 循环依赖路径（如果有） */
  cyclePaths: string[][];
}
```

### 6.2.3 失败传播与降级

```typescript
export interface FailureHandler {
  /**
   * 处理 Runtime 执行失败。
   *
   * 规则：
   * 1. 检查哪些后续 Runtime 依赖失败的 Runtime
   * 2. 有依赖的 → 跳过（记录 skipped + reason）
   * 3. 无依赖的 → 继续执行
   * 4. Narrator (priority 500) 永远不被跳过
   *    → 如果 inject 数据不可用，使用空值降级
   */
  handleFailure(
    failed: RuntimeManifest,
    error: Error,
    pendingRuntimes: RuntimeManifest[],
    dependencies: Map<string, string[]>,
  ): FailureResolution;
}

export interface FailureResolution {
  /** 应该跳过的 Runtime */
  skip: Array<{ runtime: RuntimeManifest; reason: string }>;
  /** 应该继续执行的 Runtime（可能需要降级） */
  continue: Array<{ runtime: RuntimeManifest; degraded: boolean }>;
}
```

## 6.3 写冲突检测与 Audit Plugin

### 6.3.1 冲突检测器

```typescript
// @covel/state

export interface ConflictDetector {
  /**
   * 检测一个 Turn 内的写冲突。
   *
   * 冲突定义：同一个 Turn 内，不同 Runtime 对同一个
   * (table, field) 产生了不同的写入值。
   */
  detect(pendingWrites: PendingWrite[]): WriteConflict[];
}

/**
 * 检测算法：
 * 1. 按 (table, field) 分组所有 PendingWrite
 * 2. 如果同一个 (table, field) 有 > 1 个不同的 newValue
 *    → 标记为冲突
 * 3. 如果所有 Runtime 写入了相同的值 → 不冲突，合并
 */
```

### 6.3.2 Audit Plugin 机制

Audit Plugin 是一个 `core-plugin`，priority 1000，`trigger.type: conditional`：

```typescript
export interface AuditRuntime {
  /**
   * 执行冲突裁决。
   *
   * 输入：冲突列表 + 变更历史
   * 模型：使用系统配置的裁决模型（通常是较强的模型）
   * 输出：每个冲突字段的最终值和裁决理由
   */
  resolve(
    conflicts: WriteConflict[],
    turnContext: TurnContext,
  ): Promise<AuditDecision[]>;
}

export interface AuditDecision {
  table: string;
  field: string;
  finalValue: unknown;
  /** 裁决理由（LLM 生成） */
  reasoning: string;
  /** 选择了哪个 Runtime 的值（或合并结果） */
  resolution: "pick" | "merge" | "override";
  /** 被选中的 Runtime（如果是 pick） */
  pickedFrom?: string;
}
```

### 6.3.3 Audit PLUGIN.md 模板

```markdown
---
name: audit
pluginType: core-plugin
priority: 1000
trigger:
  type: conditional
  condition: has-write-conflicts
model: balance
output:
  schema: ./audit-output.schema.json
---

你是一个游戏状态裁判 agent。

## 冲突信息

本轮发生了以下写冲突：
<conflicts>{{ inputs.conflicts | json }}</conflicts>

## 各 Runtime 的执行上下文

<runtime-contexts>{{ inputs.runtimeContexts | json }}</runtime-contexts>

## 裁决原则

1. 优先保留对玩家体验影响更大的变更
2. 如果两个变更都合理，尝试合并（如 HP 同时被两个来源扣减，则叠加）
3. 如果无法合并，优先采用优先级数值更小（更高优先级）的 Runtime 的结果
4. 给出清晰的裁决理由

## 输出格式

对每个冲突字段，输出最终值和裁决理由。
```

## 6.4 审批管线

### 6.4.1 审批管线接口

```typescript
// @covel/approval

export interface ApprovalPipeline {
  /**
   * 检查工具调用是否需要审批。
   *
   * 判断顺序：
   * 1. 内置工具 + 官方插件工具 → auto-allow
   * 2. 当前 session 已有 allow-session 记录 → auto-allow
   * 3. 本插件的 local 工具 → auto-allow
   * 4. 第三方插件工具 → 需要审批
   */
  check(request: ApprovalRequest): Promise<ApprovalCheckResult>;

  /**
   * 发起审批请求（阻塞等待）。
   *
   * 发送审批请求到前端，完全阻塞当前 Runtime 执行，
   * 直到玩家做出决策。没有超时。
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;

  /** 记录审批决策 */
  recordDecision(record: ApprovalRecord): Promise<void>;
}

export interface ApprovalCheckResult {
  /** 是否需要阻塞等待用户审批 */
  needsApproval: boolean;
  /** 如果不需要审批，自动决策 */
  autoDecision?: "allow";
  /** 原因 */
  reason: string;
}
```

### 6.4.2 权限配置

```typescript
export interface PermissionConfig {
  rules: PermissionRule[];
}

export interface PermissionRule {
  /** 工具名称模式（支持通配符） */
  pattern: string;
  /** 决策 */
  action: "allow" | "deny" | "ask";
}

/**
 * 默认权限配置：
 *
 * { pattern: "builtin:*",      action: "allow" }
 * { pattern: "local:*",        action: "allow" }
 * { pattern: "third-party:*",  action: "ask"   }
 */
```

### 6.4.3 审批阻塞机制

```typescript
/**
 * 阻塞实现策略：
 *
 * Server-side：
 * 1. 工具调用触发审批 → 创建 PendingApproval
 * 2. 通过 SSE 推送审批请求到前端
 * 3. Runtime 执行 Promise 在 await 中挂起
 * 4. 前端用户做出决策 → POST /api/approval/:id/decide
 * 5. 服务端 resolve Promise → Runtime 继续执行
 *
 * 实现上使用 Promise + EventEmitter：
 */

export class ApprovalGate {
  private pendingApprovals = new Map<
    string,
    {
      resolve: (decision: ApprovalDecision) => void;
      request: ApprovalRequest;
    }
  >();

  /** 发起审批（阻塞） */
  async waitForApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const approvalId = nanoid();
    return new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, { resolve, request });
      this.emitToFrontend(approvalId, request);
    });
  }

  /** 前端提交决策 */
  submitDecision(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (pending) {
      pending.resolve(decision);
      this.pendingApprovals.delete(approvalId);
    }
  }
}
```

### 6.4.4 当前阶段实现策略

按需求文档的"当前实现策略"：

- 代码骨架完整（每次 tool call 都经过 pipeline）
- 内置工具默认 `allow` 直接通过
- **暂不实现前端弹窗交互**，默认全部放行
- Pipeline 代码和类型完备，未来接入第三方工具时开启

```typescript
export class DefaultApprovalPipeline implements ApprovalPipeline {
  async check(request: ApprovalRequest): Promise<ApprovalCheckResult> {
    // 当前阶段：所有工具默认放行
    return {
      needsApproval: false,
      autoDecision: "allow",
      reason: "default-allow-all",
    };
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    // 当前阶段不会走到这里
    return "allow-once";
  }

  async recordDecision(record: ApprovalRecord): Promise<void> {
    await this.store.saveApproval(record);
  }
}
```

## 6.5 Runtime 错误处理与重试

```typescript
export interface RetryPolicy {
  /** 从 manifest 的 trigger.maxRetryCount 读取 */
  maxRetries: number;
  /** 重试间隔（指数退避） */
  baseDelayMs: number;
  /** 最大延迟 */
  maxDelayMs: number;
}

export interface RuntimeErrorHandler {
  /**
   * 处理 Runtime 执行错误。
   *
   * 1. LLM API 错误（网络、限流等）→ 重试
   * 2. 输出 schema 验证失败 → 重新调用 LLM（带错误提示）
   * 3. 工具执行错误 → 将错误作为 tool result 返回 LLM
   * 4. 超时 → 直接失败
   * 5. 审批被拒绝 → 将拒绝结果作为 tool result 返回 LLM
   */
  handle(
    error: RuntimeError,
    retryCount: number,
    policy: RetryPolicy,
  ): ErrorAction;
}

export type ErrorAction =
  | { type: "retry"; delay: number }
  | { type: "fail"; reason: string }
  | { type: "continue-without-tool"; toolResult: unknown };
```

## 6.6 验收标准

- [ ] 同优先级 Runtime 正确并行执行
- [ ] 组内依赖正确检测并调整执行顺序
- [ ] Runtime 失败不影响无依赖的其他 Runtime
- [ ] Narrator 保护机制：失败降级而非跳过
- [ ] 写冲突正确检测（同 Turn 同字段不同值）
- [ ] Audit Plugin 可正确执行裁决并应用最终值
- [ ] 审批管线骨架完整（当前阶段默认全部放行）
- [ ] 审批阻塞机制 Promise + EventEmitter 实现正确
- [ ] 重试策略（指数退避）正确执行
- [ ] 单元测试覆盖率 ≥ 80%

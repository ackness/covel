# Phase 1: 基础架构与类型系统

> 预计工作量：3-5 天
> 前置依赖：无
> 交付物：完整的类型系统、项目骨架、PLUGIN.md 解析器

---

## 1.1 目标

建立整个重构的地基：统一的类型系统、包结构、核心契约接口。所有后续阶段都依赖本阶段的类型定义。

## 1.2 包结构重组

```
packages/
  shared/           # 共享类型与契约（纯类型，零运行时依赖）
  plugin-loader/    # PLUGIN.md 解析、插件发现、渐进式加载
  runtime/          # 执行引擎（调度、Runner、上下文）
  tools/            # 工具系统（tool() 包装、注册表、内置工具）
  context/          # 上下文组装（inject、references、模板变量）
  state/            # 状态管理（动态表、变更历史）
  events/           # 事件总线与消息路由
  store/            # 持久化抽象层（Memory、IDB、PG）
  approval/         # 审批管线
  server/           # Hono API 服务器

plugins/            # 所有游戏插件（重写）
  narrator/
  persona/
  ...

apps/
  web/              # React 前端（保留，后续适配）
  server/           # 入口点（组装所有 packages）
```

## 1.3 核心类型定义（@covel/shared）

### 1.3.1 插件相关类型

```typescript
// === Plugin Manifest（从 PLUGIN.md frontmatter 解析） ===

export type PluginType = "core-plugin" | "plugin";

export type TriggerType =
  | "auto"
  | "manual"
  | "scheduled"
  | "conditional"
  | "event"
  | "error-retry";

export interface TriggerConfig {
  type: TriggerType;
  /** scheduled 模式下的轮次间隔 */
  interval?: number;
  /** conditional 模式下的条件表达式 */
  condition?: string;
  /** event 模式下监听的 topic */
  topic?: string;
  /** 整个 session 内最大触发次数 */
  maxTriggerCount?: number;
  /** 错误重试最大次数 */
  maxRetryCount?: number;
  /** 两次触发之间的最小轮次间隔 */
  cooldownTurns?: number;
}

export interface InputInjectDecl {
  /** 来源：pluginId/runtimeId */
  from: string;
  /** 字段名 */
  field: string;
  /** 包裹的 XML 标签名 */
  as: string;
}

export interface InputToolDecl {
  plugin: string;
  runtime: string;
}

export interface InputConfig {
  inject?: InputInjectDecl[];
  tools?: InputToolDecl[];
}

export interface OutputConfig {
  /** output.schema.json 的相对路径 */
  schema?: string;
  /** 记录名（供其他 Runtime 查询） */
  recordAs?: string;
}

export interface ToolsConfig {
  /** 引用的内置工具 ID 列表 */
  builtin?: string[];
  /** 本地工具的相对路径列表 */
  local?: string[];
}

export interface PluginConfigField {
  type: "string" | "integer" | "number" | "boolean" | "enum";
  default?: unknown;
  min?: number;
  max?: number;
  options?: string[];
  label?: string;
  description?: string;
}

export interface RuntimeManifest {
  name: string;
  description: string;
  priority: number;
  version?: string;
  model?: string;
  trigger?: TriggerConfig;
  tools?: ToolsConfig;
  input?: InputConfig;
  output?: OutputConfig;
  config?: Record<string, PluginConfigField>;
  i18n?: Record<string, string>;
}

export interface PluginManifest {
  /** 插件唯一标识 */
  id: string;
  /** 插件显示名称 */
  name: string;
  description: string;
  pluginType: PluginType;
  version?: string;
  /** 单 Runtime 插件时的 Runtime 配置 */
  runtime?: RuntimeManifest;
  /** 多 Runtime 插件时的 Runtime 列表 */
  runtimes?: RuntimeManifest[];
  config?: Record<string, PluginConfigField>;
}
```

### 1.3.2 执行相关类型

```typescript
// === Turn & Execution ===

export type RuntimeStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export interface RuntimeResult {
  pluginId: string;
  runtimeId: string;
  runId: string;
  turnId: string;
  status: RuntimeStatus;
  output: Record<string, unknown> | null;
  toolCalls: ToolCallRecord[];
  durationMs: number;
  tokenUsage?: { input: number; output: number };
  error?: string;
  timestamp: string;
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  pluginId: string;
  runtimeId: string;
  turnId: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
  approvalStatus: "auto-allowed" | "user-allowed" | "user-denied";
  timestamp: string;
}

export interface TurnInput {
  sessionId: string;
  turnId: string;
  playerMessage: string;
  locale?: string;
}

export interface TurnResult {
  turnId: string;
  sessionId: string;
  runtimeResults: RuntimeResult[];
  conflicts?: WriteConflict[];
  auditResult?: RuntimeResult;
  durationMs: number;
  timestamp: string;
}
```

### 1.3.3 状态相关类型

```typescript
// === State Tables ===

export interface StateChangeEntry {
  value: unknown;
  changedBy: string; // pluginId/runtimeId
  turnId: string;
  reason?: string;
  timestamp: string;
}

export interface StateField {
  table: string;
  field: string;
  currentValue: unknown;
  changeLog: StateChangeEntry[];
}

export interface StateTableSchema {
  name: string;
  fields: Array<{
    name: string;
    type: "string" | "integer" | "number" | "boolean" | "object" | "array";
    default?: unknown;
  }>;
}

export interface WriteConflict {
  table: string;
  field: string;
  originalValue: unknown;
  writes: Array<{
    runtimeId: string;
    pluginId: string;
    priority: number;
    newValue: unknown;
    reason?: string;
  }>;
}
```

### 1.3.4 事件相关类型

```typescript
// === Events & Messages ===

export type MessageType = "message" | "event" | "callback";

export interface CovelMessage {
  type: MessageType;
  topic: string;
  payload: Record<string, unknown>;
  targetRuntime?: string; // pluginId/runtimeId
  sessionId: string;
  turnId?: string;
  timestamp: string;
}
```

### 1.3.5 审批相关类型

```typescript
// === Approval ===

export type ApprovalDecision = "allow-once" | "allow-session" | "deny";

export interface ApprovalRequest {
  toolName: string;
  pluginId: string;
  runtimeId: string;
  input: Record<string, unknown>;
  turnId: string;
  sessionId: string;
}

export interface ApprovalRecord {
  approvalId: string;
  toolName: string;
  decision: ApprovalDecision;
  decidedAt: string;
  turnId: string;
  sessionId: string;
}
```

### 1.3.6 Session 相关类型

```typescript
// === Session ===

export type SessionPhase = "pre-game" | "playing" | "paused" | "ended";

export interface Session {
  id: string;
  worldId?: string;
  phase: SessionPhase;
  turnCount: number;
  activePlugins: string[];
  locale: string;
  createdAt: string;
  updatedAt: string;
}
```

## 1.4 PLUGIN.md 解析器

### 设计要点

- 使用 `gray-matter` 解析 YAML frontmatter + Markdown body
- frontmatter 使用 Zod schema 验证
- Markdown body 保留原始文本，作为 system prompt 注入 LLM
- 支持模板变量 `{{ inputs.xxx }}` 语法（延迟到 Context 阶段填充）
- 支持 references 链接 `[文件名](references/xxx.md)` 解析

```typescript
// @covel/plugin-loader

import { z } from "zod";

/** 解析结果 */
export interface ParsedPluginMd {
  manifest: RuntimeManifest;
  promptTemplate: string; // Markdown body（未填充的模板）
  referenceLinks: string[]; // 从 Markdown 中提取的 references/ 路径
  rawFrontmatter: Record<string, unknown>;
}

/** 解析 PLUGIN.md 文件 */
export function parsePluginMd(
  content: string,
  filePath: string,
): ParsedPluginMd;

/** 验证 frontmatter schema */
export const runtimeManifestSchema: z.ZodSchema<RuntimeManifest>;
```

### 解析流程

```
读取 PLUGIN.md
  → gray-matter 分离 frontmatter + body
  → Zod 验证 frontmatter → RuntimeManifest
  → 正则提取 body 中的 references 链接
  → 返回 ParsedPluginMd
```

## 1.5 References 解析器

支持 frontmatter 中的关键词触发：

```typescript
export interface ParsedReference {
  filePath: string;
  keywords: string[];
  content: string;
}

/** 解析 references 目录下的文件 */
export function parseReference(
  content: string,
  filePath: string,
): ParsedReference;

/** 检查上下文中是否包含触发关键词 */
export function shouldInjectReference(
  ref: ParsedReference,
  context: string,
): boolean;
```

## 1.6 开发环境配置

### TypeScript 配置

- 严格模式（`strict: true`）
- ESM-only（`"type": "module"`）
- NodeNext 模块解析
- target ES2022
- 所有 imports 使用 `.js` 扩展名

### 依赖

本阶段新增/保留的关键依赖：

- `zod` — 运行时 schema 验证
- `gray-matter` — YAML frontmatter 解析
- `nanoid` — ID 生成
- `pino` — 日志

### 验收标准

- [ ] 所有共享类型定义完成，通过 `tsc --noEmit`
- [ ] PLUGIN.md 解析器可正确解析最简/标准/多 Runtime 三种形态
- [ ] References 解析器可正确提取关键词并判断是否注入
- [ ] Zod schema 验证通过，包含友好错误信息
- [ ] 单元测试覆盖率 ≥ 80%

## 1.7 参考实现

- **VoltAgent** 的 Zod-typed tool definitions 模式值得参考：所有配置和输入使用 Zod schema 做运行时验证
- **Mastra** 的声明式 agent 定义方式（TypeScript-first）
- **SillyTavern** 的 extension manifest + progressive loading 模式

# Phase 4: 工具系统与输出系统

> 预计工作量：4-5 天
> 前置依赖：Phase 1（类型系统）、Phase 3（Runtime Runner）
> 交付物：tool() 包装函数、内置工具集、工具注册表、结构化输出验证

---

## 4.1 目标

实现完整的工具系统（定义、注册、命名、执行）和结构化输出系统（schema 验证、重试、结果记录）。

## 4.2 tool() 包装函数

参考 VoltAgent 的 `createTool` 设计，结合需求文档中的 `tool()` 接口：

````typescript
// @covel/tools — 公共 SDK 导出为 covel/sdk

import { z, type ZodSchema } from "zod";

export interface ToolDefinitionInput<
  TParams extends ZodSchema = ZodSchema,
  TOutput = unknown,
> {
  /** 工具描述（注入 LLM 的 function calling description） */
  description: string;
  /** 参数 schema（Zod） */
  parameters: TParams;
  /** 输出 schema（可选，用于类型推断和验证） */
  outputSchema?: ZodSchema<TOutput>;
  /** 执行函数 */
  execute: (
    params: z.infer<TParams>,
    context: ToolExecutionContext,
  ) => Promise<TOutput>;
}

export interface ToolExecutionContext {
  /** 当前 session ID */
  sessionId: string;
  /** 当前 turn ID */
  turnId: string;
  /** 当前 plugin ID */
  pluginId: string;
  /** 当前 runtime ID */
  runtimeId: string;
  /** 日志记录器 */
  logger: Logger;
}

/**
 * 定义一个工具。
 *
 * 框架自动完成：
 * 1. 从 Zod schema 生成 JSON Schema（用于 LLM function calling）
 * 2. 运行时参数验证
 * 3. 注册到工具注册表
 * 4. 生成命名：covel_{plugin}_{runtime}_{fn}
 *
 * @example
 * ```typescript
 * import { tool } from 'covel/sdk';
 * import { z } from 'zod';
 *
 * export default tool({
 *   description: "获取角色当前状态",
 *   parameters: z.object({
 *     characterId: z.string().describe("角色 ID"),
 *   }),
 *   execute: async ({ characterId }, ctx) => {
 *     // 业务逻辑
 *     return { hp: 100, mp: 50 };
 *   },
 * });
 * ```
 */
export function tool<TParams extends ZodSchema, TOutput>(
  definition: ToolDefinitionInput<TParams, TOutput>,
): ToolModule<TParams, TOutput>;

/** tool() 返回的标准化工具模块 */
export interface ToolModule<
  TParams extends ZodSchema = ZodSchema,
  TOutput = unknown,
> {
  readonly _type: "covel-tool";
  readonly description: string;
  readonly parametersSchema: TParams;
  readonly outputSchema?: ZodSchema<TOutput>;
  readonly jsonSchema: Record<string, unknown>; // 从 Zod 转换的 JSON Schema
  execute(
    params: z.infer<TParams>,
    context: ToolExecutionContext,
  ): Promise<TOutput>;
}
````

### Zod → JSON Schema 转换

使用 `zod-to-json-schema` 库将 Zod schema 转换为标准 JSON Schema，适配不同 LLM provider 格式：

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";

function toOpenAITool(tool: ToolModule, fullName: string): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: fullName,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parametersSchema),
    },
  };
}

function toAnthropicTool(tool: ToolModule, fullName: string): AnthropicToolDef {
  return {
    name: fullName,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.parametersSchema),
  };
}
```

## 4.3 工具命名与注册表

### 命名规范

```
covel_{plugin_name}_{runtime_name}_{function_name}

示例：
covel_image_workflow_prompt_optimizer_fetch_style_reference
covel_narrator_main_get_scene_info   (内置工具在 narrator 下)
```

插件开发者只写函数名，框架自动拼接完整名称。

### 工具注册表

```typescript
// @covel/tools

export interface ResolvedTool {
  /** 完整工具名（covel_xxx_xxx_xxx） */
  fullName: string;
  /** 原始函数名 */
  localName: string;
  /** 所属插件 ID */
  pluginId: string;
  /** 所属 Runtime ID */
  runtimeId: string;
  /** 工具模块 */
  module: ToolModule;
  /** 来源 */
  source: "builtin" | "local";
  /** 是否需要审批 */
  requiresApproval: boolean;
}

export interface ToolRegistry {
  /** 注册工具 */
  register(tool: ResolvedTool): void;

  /** 按完整名称查找 */
  getByFullName(fullName: string): ResolvedTool | undefined;

  /** 获取某个 Runtime 可使用的所有工具 */
  getToolsForRuntime(
    pluginId: string,
    runtimeId: string,
    manifest: RuntimeManifest,
  ): ResolvedTool[];

  /** 卸载某个插件的所有工具 */
  unregisterPlugin(pluginId: string): void;
}
```

### 工具加载流程

```
Runtime manifest 声明 tools:
  builtin: ["get-game-context", "get-narrator-output"]
  local: ["./tools/fetch-style-reference.js"]

框架处理流程：
  1. builtin → 从内置工具注册表查找
  2. local → import() 动态加载 JS 文件
     → 读取 default export（ToolModule）
     → 生成完整名称
     → 注册到工具注册表
  3. 合并所有工具 → 转换为 LLM 格式 → 传给 Runtime Runner
```

## 4.4 框架内置工具

所有内置工具使用相同的 `tool()` 接口实现：

```typescript
// @covel/tools/builtin/

// get-game-context.ts
export default tool({
  description: "获取当前游戏上下文摘要，包括 session 信息、当前轮次、活跃插件等",
  parameters: z.object({}),
  execute: async (_, ctx) => {
    const session = await store.getSession(ctx.sessionId);
    return {
      sessionId: session.id,
      turnNumber: session.turnCount,
      phase: session.phase,
      worldId: session.worldId,
      activePlugins: session.activePlugins,
    };
  },
});

// get-narrator-output.ts
export default tool({
  description: "获取 Narrator 的当前或历史输出",
  parameters: z.object({
    turnId: z.string().optional().describe("指定 Turn ID，不填则为当前 Turn"),
    last: z.number().optional().describe("获取最近 N 条历史"),
  }),
  execute: async ({ turnId, last }, ctx) => { ... },
});

// get-character-state.ts
// get-scene-info.ts
// get-runtime-result.ts
// update-state.ts
// query-table.ts
// emit-event.ts
```

### 内置工具清单

| 工具 ID               | 功能              | 读/写 |
| --------------------- | ----------------- | ----- |
| `get-game-context`    | 游戏上下文摘要    | 读    |
| `get-narrator-output` | Narrator 输出     | 读    |
| `get-character-state` | 角色状态表        | 读    |
| `get-scene-info`      | 当前场景信息      | 读    |
| `get-runtime-result`  | 任意 Runtime 结果 | 读    |
| `update-state`        | 更新状态表字段    | 写    |
| `query-table`         | 查询动态表单数据  | 读    |
| `emit-event`          | 发送事件          | 写    |

写操作工具（`update-state`、`emit-event`）走审批管线。

## 4.5 工具调用记录

每次工具调用自动持久化：

```typescript
export interface ToolCallRecorder {
  record(entry: ToolCallRecord): Promise<void>;

  /** 查询某个 Turn 的所有工具调用 */
  getByTurn(turnId: string): Promise<ToolCallRecord[]>;

  /** 查询某个 Runtime 的工具调用 */
  getByRuntime(
    pluginId: string,
    runtimeId: string,
    turnId: string,
  ): Promise<ToolCallRecord[]>;
}
```

## 4.6 结构化输出系统

### 4.6.1 输出 Schema 加载

```typescript
export interface OutputSchemaLoader {
  /**
   * 加载 Runtime 的输出 schema。
   * 1. 如果 manifest.output.schema 指定了路径 → 加载 JSON Schema 文件
   * 2. 如果未指定 → 使用默认 schema（自由 object）
   */
  load(
    manifest: RuntimeManifest,
    pluginDir: string,
  ): Promise<Record<string, unknown>>;
}
```

### 4.6.2 输出验证

```typescript
import Ajv from "ajv";

export interface OutputValidator {
  /**
   * 验证 Runtime 的输出是否符合 schema。
   * 返回验证结果（通过/失败 + 错误信息）。
   */
  validate(output: unknown, schema: Record<string, unknown>): ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}
```

### 4.6.3 Structured Output 策略

根据模型能力选择不同策略：

````typescript
export type StructuredOutputStrategy =
  | "native" // 模型原生支持 response_format（GPT-4o、Claude 3.5+）
  | "prompt"; // 不支持时，在 prompt 中注入 schema 描述

export function selectStrategy(
  modelCapabilities: ModelCapabilities,
): StructuredOutputStrategy;

/**
 * prompt 策略时注入的指令模板：
 *
 * ## Output Format
 * You MUST respond with valid JSON matching this schema:
 * ```json
 * {schema}
 * ```
 * Do not include any text outside the JSON object.
 */
````

### 4.6.4 输出验证失败重试

```typescript
export interface OutputRetryPolicy {
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试时的额外提示 */
  retryPrompt: string;
}

/**
 * 如果 LLM 输出不符合 schema：
 * 1. 尝试 JSON 修复（常见格式问题）
 * 2. 如果修复失败，将错误信息追加到 messages 重新调用 LLM
 * 3. 最多重试 maxRetries 次
 * 4. 全部失败 → RuntimeResult.status = 'failed'
 */
```

## 4.7 Runtime 执行结果统一格式

```typescript
export interface RuntimeResultEnvelope {
  pluginId: string;
  runtimeId: string;
  runId: string;
  turnId: string;
  status: RuntimeStatus;
  /** 结构化输出（验证通过的 JSON） */
  output: Record<string, unknown> | null;
  /** 本次执行的所有工具调用记录 */
  toolCalls: ToolCallRecord[];
  /** 执行耗时 */
  durationMs: number;
  /** Token 消耗 */
  tokenUsage?: { input: number; output: number };
  /** 错误信息 */
  error?: string;
  timestamp: string;
}
```

其他 Runtime 可通过 `get-runtime-result` 工具查询此格式的数据。

## 4.8 covel/sdk 公共包

为插件开发者提供统一的 SDK 入口：

```typescript
// covel/sdk (package.json exports)

export { tool } from "@covel/tools";
export type { ToolExecutionContext, ToolModule } from "@covel/tools";
export { z } from "zod"; // 重导出 Zod 方便使用
```

## 4.9 验收标准

- [ ] `tool()` 函数可正确定义工具，Zod → JSON Schema 转换正确
- [ ] 工具注册表可注册/查找/卸载工具
- [ ] 工具命名自动生成且格式正确
- [ ] 8 个内置工具全部实现并注册
- [ ] 本地工具（JS 文件）可动态加载
- [ ] 每次工具调用都有持久化记录
- [ ] 结构化输出验证（native + prompt 两种策略）正确
- [ ] 输出验证失败时重试机制生效
- [ ] covel/sdk 包可被外部插件导入使用
- [ ] 单元测试覆盖率 ≥ 80%

## 4.10 参考实现

- **VoltAgent** 的 `createTool`：Zod-typed parameters + outputSchema + execute 函数，是 `tool()` 的直接灵感来源
- **Mastra** 的 `structuredOutput`：在 agent.generate() 时传入 Zod schema，模型输出自动验证
- **Vercel AI SDK** 的 tool 定义：`tool({ description, parameters: z.object({...}), execute: async () => {} })`
- **OpenAI Agents SDK** 的工具注册：统一的 tool interface，支持 function calling

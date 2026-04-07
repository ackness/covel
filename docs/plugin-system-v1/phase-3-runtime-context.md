# Phase 3: RuntimeContext + Structured Output

依赖：Phase 1（EventBus + Logger）, Phase 2（ServiceGateway）  
包名：`@covel/runtime-context`  
预计产出：`packages/runtime-context/`

## 目标

为每个 runtime 提供完整、独立的执行环境，并确保所有对外输出最终都能被规范化为符合 schema 的 JSON。

## 1. RuntimeContext

```typescript
interface RuntimeContext {
  runtimeId: string;
  pluginId: string;
  sessionId: string;
  turnId: string;
  locale: string;

  prompt: PromptAssemblyContext;
  settings: Record<string, unknown>;
  logger: ScopedLogger;
  bus: ScopedEventBus;

  records: RecordQueryService;
  tables: TableService;
  tools: ToolGatewayService;
  scripts: ScriptHostService;
  references: ReferenceService;
  approvals: ApprovalService;
}
```

## 2. Prompt 组装

每个 runtime 的 prompt 由框架统一组装：

```text
plugin/PLUGIN.md
+ runtime/instructions.md
+ locale 指令
+ 调度上下文
+ 记录 / 表快照
+ 当前可用 tool definitions
```

### 关键规则

- `PLUGIN.md` 自动注入
- locale 必须显式注入
- tool definitions 由框架解析后再注入
- `references/` 不默认全量注入

## 3. Structured Output 策略

每个 runtime 必须有 `output.schema.json`。

建议的降级顺序：

1. 模型原生支持 structured output：直接使用
2. 模型支持 function calling：把输出包装成 function schema
3. 模型都不支持：prompt 注入 schema + validate + retry

无论采用哪条路径，最终都必须得到通过校验的 JSON payload。

## 4. 失败语义

即使 runtime 失败，也必须生成标准化记录：

- `failed`
- `approval_denied`
- `skipped_condition`
- `skipped_limit`

失败信息同时进入 trace。

## 5. Tool / Script 上下文

tool 和 script 在执行时会收到统一上下文：

```typescript
interface ToolExecutionContext {
  pluginId: string;
  runtimeId: string;
  sessionId: string;
  turnId: string;
  traceId: string;
  locale: string;
  input: unknown;
}
```

## 6. 输出与记录

runtime 自己只产出 payload。

框架负责：

- output schema 校验
- envelope 包装
- 写入 published records
- 写入 full trace
- 在成功提交后更新 live state tables

# Phase 2: ServiceGateway（统一基础设施接口）

依赖：Phase 1（EventBus + Logger）  
包名：`@covel/services`  
预计产出：`packages/services/`

## 目标

为 runtime 执行、tool 执行和 script 执行提供统一底层网关。

V1 的核心原则：

- 插件不直接碰底层数据库实现
- 写操作由框架统一记录
- 插件之间共享的是标准化记录和表快照，不是原始 trace

## 1. ServiceGateway

```typescript
interface ServiceGateway {
  records: RecordQueryService;
  tables: TableService;
  scripts: ScriptHostService;
  references: ReferenceService;
  approvals: ApprovalService;
  tools: ToolGatewayService;
  settings: RuntimeSettingsService;
  trace: TraceService;
}
```

## 2. RecordQueryService

负责标准化记录查询。

```typescript
interface RecordQueryService {
  query(input: RecordQueryInput): Promise<RecordQueryResult>;
}

interface RecordQueryInput {
  sessionId: string;
  pluginId?: string;
  runtimeId?: string;
  status?: string[];
  recordType?: "runtime_result" | "domain_event" | "approval_record";
  limit?: number;
  cursor?: string | null;
}
```

### 说明

- 面向插件暴露的只是标准化记录
- 不暴露原始 LLM trace、原始 tool trace

## 3. TableService

负责 live state tables 的读取、写入和 schema 演进。

```typescript
interface TableService {
  query(input: TableQueryInput): Promise<unknown>;
  write(input: TableWriteInput): Promise<TableWriteResult>;
  patchSchema(input: TableSchemaPatchInput): Promise<TableSchemaPatchResult>;
}
```

### 关键规则

- 读范围必须命中 runtime 声明的 `tableAccess.read`
- 默认只能写 owner 为当前插件的表
- schema 只允许兼容性修改
- 每次写入和 schema 变更都必须进入完整历史

## 4. ScriptHostService

统一执行 `scripts/`。

```typescript
interface ScriptHostService {
  exec(input: ScriptExecInput): Promise<ScriptExecResult>;
}
```

规则：

- 只执行当前 runtime 目录下的脚本
- 输出可为 JSON 或 string
- 结果进入 trace

## 5. ReferenceService

按需加载 `references/`。

```typescript
interface ReferenceService {
  load(input: ReferenceLoadInput): Promise<ReferenceLoadResult>;
}
```

规则：

- 不默认全量注入
- 结果进入 trace

## 6. ApprovalService

统一处理工具 / 脚本 / 受控操作授权。

```typescript
interface ApprovalService {
  check(input: ApprovalCheckInput): Promise<ApprovalDecision>;
  grant(input: ApprovalGrantInput): Promise<void>;
}
```

V1 授权规则：

- 白名单内置插件默认放行
- 非白名单插件默认要求授权
- 授权粒度：`session + plugin + tool`
- 热重载后继续有效

## 7. ToolGatewayService

统一处理 tool registry 和 invocation。

```typescript
interface ToolGatewayService {
  listAvailable(runtimeId: string): Promise<ResolvedToolDefinition[]>;
  invoke(input: ToolInvokeInput): Promise<ToolInvokeResult>;
}
```

职责：

- 解析 local tools
- 解析 imported tools
- 检查导出 / 导入双向声明
- 校验 input / output schema
- 路由到目标插件 tool
- 记录 trace

## 8. RuntimeSettingsService

V1 只有 `runtime-level settings`。

```typescript
interface RuntimeSettingsService {
  getResolved(sessionId: string, pluginId: string, runtimeId: string): Promise<Record<string, unknown>>;
  update(sessionId: string, pluginId: string, runtimeId: string, patch: Record<string, unknown>): Promise<void>;
}
```

规则：

- 修改后只影响后续新触发
- 不影响已经执行中的 runtime

## 9. TraceService

内部完整审计接口。

```typescript
interface TraceService {
  append(entry: TraceEntry): Promise<void>;
}
```

Trace 至少记录：

- LLM 输入输出
- tool 调用
- script 调用
- 审批决策
- 表写入
- schema 变更
- 失败信息

## 10. 运行时提交模型

V1 建议以 **runtime 为原子提交单位**：

1. runtime 在自己的执行上下文里运行
2. tool / script 产生的写操作先进入 runtime 当前执行事务
3. runtime 结束后统一提交到：
   - published records
   - live state tables
   - full trace
4. 若 runtime 失败，则生成 failed record，但不把未完成的写入暴露为新的最新状态

这个模型有两个好处：

- 同优先级并行 runtime 隔离更清晰
- 低优先级 runtime 只读取已经提交的稳定结果

# Phase 7: API 层、前端集成与完善

> 预计工作量：7-10 天
> 前置依赖：Phase 1-6（所有核心系统）
> 交付物：标准 HTTP API、SSE 事件流、UI 组件系统、插件配置 UI、热重载、i18n、测试框架、日志系统

---

## 7.1 目标

将所有核心系统暴露为标准 HTTP API，实现前端集成所需的 UI 组件系统，完善 i18n、测试、日志等横切关注点。

## 7.2 标准 HTTP API

### 7.2.1 路由设计

API-first 原则：所有功能通过 API 完整可用，前端 UI 是可选的可视化层。

```typescript
// @covel/server — Hono 路由

// === Session 管理 ===
POST   /session/start              // 启动新游戏 session（触发 Pre-Game）
GET    /session/:id                // 获取 session 信息
DELETE /session/:id                // 结束 session

// === Turn 执行 ===
POST   /session/:id/turn           // 玩家发起一次操作（触发完整 Turn）
GET    /session/:id/results        // 获取当前 Turn 所有 Runtime 结果
GET    /session/:id/turns          // 获取 Turn 历史

// === 插件管理 ===
GET    /plugins                    // 获取所有已加载插件列表
GET    /plugins/:id                // 获取单个插件详情
GET    /plugins/:id/config         // 获取插件配置 schema + 当前值
PATCH  /plugins/:id/config         // 更新插件配置
POST   /session/:id/plugins/enable  // 在 session 中启用插件
POST   /session/:id/plugins/disable // 在 session 中禁用插件

// === Runtime 调试 ===
POST   /runtime/invoke             // 独立调用单个 Runtime（测试用）

// === 事件 ===
GET    /events/subscribe           // SSE 订阅事件流
POST   /events/emit                // 外部向框架发送事件

// === 审批 ===
GET    /approval/pending           // 获取待审批请求
POST   /approval/:id/decide       // 提交审批决策

// === 状态查询 ===
GET    /session/:id/state          // 获取 session 所有状态表
GET    /session/:id/state/:table   // 获取单个表快照
GET    /session/:id/state/:table/:field/history  // 获取字段变更历史

// === 配置 ===
GET    /config/llm                 // LLM 配置
GET    /health                     // 健康检查
```

### 7.2.2 Session Start 流程

```typescript
// POST /session/start
interface StartSessionRequest {
  worldId?: string;
  locale?: string;
  plugins?: string[]; // 额外启用的插件
}

interface StartSessionResponse {
  sessionId: string;
  phase: "pre-game" | "playing";
  /** Pre-Game Runtime 的执行结果 */
  preGameResults: RuntimeResult[];
  /** 初始化的状态表 */
  initialState: Record<string, Record<string, unknown>>;
}
```

### 7.2.3 Turn 执行流程

```typescript
// POST /session/:id/turn
interface TurnRequest {
  message: string;
  locale?: string;
}

// 响应方式两种：

// 1. 同步响应（简单场景）
interface TurnResponse {
  turnId: string;
  results: RuntimeResult[];
  conflicts?: WriteConflict[];
  auditResult?: RuntimeResult;
}

// 2. SSE 流式响应（推荐，实时进度）
// Content-Type: text/event-stream
// 事件类型见 7.3
```

### 7.2.4 Runtime 独立调用（测试用）

```typescript
// POST /runtime/invoke
interface RuntimeInvokeRequest {
  pluginId: string;
  runtimeId: string;
  /** Mock 输入数据（替代真实上下文） */
  mockInput?: Record<string, unknown>;
  /** Mock 工具返回值 */
  mockToolResults?: Record<string, unknown>;
}
```

## 7.3 SSE 事件流

### 7.3.1 事件类型

```typescript
export type SSEEvent =
  // Turn 生命周期
  | { event: "turn:start"; data: { turnId: string; runtimeCount: number } }
  | { event: "turn:complete"; data: TurnResult }

  // Runtime 执行进度
  | {
      event: "runtime:start";
      data: { pluginId: string; runtimeId: string; priority: number };
    }
  | {
      event: "runtime:progress";
      data: { pluginId: string; runtimeId: string; step: string };
    }
  | { event: "runtime:complete"; data: RuntimeResult }
  | {
      event: "runtime:skipped";
      data: { pluginId: string; runtimeId: string; reason: string };
    }

  // 流式输出（Narrator 的文本可实时推送）
  | {
      event: "runtime:stream";
      data: { pluginId: string; runtimeId: string; chunk: string };
    }

  // 审批请求
  | {
      event: "approval:required";
      data: { approvalId: string; request: ApprovalRequest };
    }
  | {
      event: "approval:resolved";
      data: { approvalId: string; decision: ApprovalDecision };
    }

  // 状态变更
  | {
      event: "state:updated";
      data: { table: string; field: string; newValue: unknown };
    }

  // 事件总线消息
  | { event: "message"; data: CovelMessage }

  // 错误
  | {
      event: "error";
      data: { pluginId?: string; runtimeId?: string; message: string };
    };
```

### 7.3.2 SSE 实现

```typescript
// Hono SSE handler
app.get("/events/subscribe", (c) => {
  return streamSSE(c, async (stream) => {
    const sessionId = c.req.query("sessionId");

    const unsubscribe = eventBus.on("*", async (event) => {
      if (event.sessionId === sessionId) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event.data),
        });
      }
    });

    // 保持连接直到客户端断开
    await new Promise((_, reject) => {
      stream.onAbort(() => {
        unsubscribe();
        reject();
      });
    });
  });
});
```

## 7.4 UI 组件系统（LLM-Driven UI）

### 7.4.1 预定义组件库

```typescript
// @covel/shared — UI 组件类型

export type UIComponentType =
  | "stat-bar"
  | "card"
  | "choice-list"
  | "image"
  | "table"
  | "notification"
  | "dialog"
  | "inventory"
  | "map-marker"
  | "progress";

export interface UIRenderInstruction {
  type: UIComponentType | string; // 支持自定义组件类型
  [key: string]: unknown; // 组件特定的属性
}

// 每个内置组件的 props schema
export const uiComponentSchemas: Record<UIComponentType, z.ZodSchema> = {
  "stat-bar": z.object({
    type: z.literal("stat-bar"),
    label: z.string(),
    value: z.number(),
    max: z.number(),
    color: z.string().optional(),
  }),
  card: z.object({
    type: z.literal("card"),
    title: z.string(),
    body: z.string(),
    icon: z.string().optional(),
  }),
  "choice-list": z.object({
    type: z.literal("choice-list"),
    prompt: z.string(),
    options: z.array(z.string()),
  }),
  // ... 其他组件
};
```

### 7.4.2 自定义组件加载

```typescript
/**
 * 插件可在 ui-components/ 目录下提供自定义组件。
 *
 * 组件格式：ESM 模块，导出 React 组件。
 * 前端通过动态 import() 加载。
 *
 * 安全约束：
 * - 组件运行在前端沙箱中
 * - 只能访问 covel.readonly API
 * - 不能发起网络请求
 * - 不能访问其他插件的内部数据
 */

export interface CustomComponentManifest {
  /** 组件类型名（在 output.ui 中使用） */
  type: string;
  /** 组件文件路径 */
  path: string;
  /** 所属插件 */
  pluginId: string;
}

export interface CovelReadonlyAPI {
  /** 获取当前状态表数据 */
  getState(table: string, field: string): Promise<unknown>;
  /** 获取当前 Turn 信息 */
  getTurnInfo(): Promise<{ turnId: string; turnNumber: number }>;
  /** 获取当前 session 信息 */
  getSessionInfo(): Promise<Session>;
}
```

### 7.4.3 组件注入到 System Prompt

框架在每个 Runtime 的 system prompt 中注入当前可用的 UI 组件列表：

```
## Available UI Components
You can include UI render instructions in your output's "ui" field.
Available component types and their schemas:

- stat-bar: { type: "stat-bar", label: string, value: number, max: number, color?: string }
- card: { type: "card", title: string, body: string, icon?: string }
- choice-list: { type: "choice-list", prompt: string, options: string[] }
...
```

## 7.5 插件配置系统

### 7.5.1 配置 Schema 解析

```typescript
export interface ConfigSchemaResolver {
  /**
   * 从 PLUGIN.md frontmatter 中的 config 字段解析配置 schema。
   * 如果有独立的 config.schema.json，也支持加载。
   */
  resolve(manifest: RuntimeManifest, pluginDir: string): ConfigSchema;
}

export interface ConfigSchema {
  fields: Record<string, PluginConfigField>;
  /** 转换为前端可渲染的 JSON Schema */
  toJsonSchema(): Record<string, unknown>;
}
```

### 7.5.2 配置热生效

```typescript
/**
 * 配置修改流程：
 * 1. PATCH /plugins/:id/config → 更新配置
 * 2. 持久化到 DataStore
 * 3. SessionPluginScope.configOverrides 更新
 * 4. 下一次 Runtime 执行时读取新配置
 * 5. 通过 {{ config.xxx }} 在 PLUGIN.md 中引用
 */
```

## 7.6 i18n 支持

### 7.6.1 PLUGIN.md 多语言

```
my-plugin/
  PLUGIN.md           # 默认语言
  PLUGIN.zh-CN.md     # 中文
  PLUGIN.en-US.md     # 英文
```

加载策略：

1. 精确匹配（`PLUGIN.{locale}.md`）
2. 语言回退（`PLUGIN.{lang}.md`，如 `zh-CN` → `zh`）
3. 默认文件（`PLUGIN.md`）
4. 如果都没有 → 错误

```typescript
export interface LocaleResolver {
  /**
   * 根据 locale 解析应加载的 PLUGIN.md 文件路径。
   */
  resolve(pluginDir: string, runtimeDir: string, locale: string): string;
}
```

### 7.6.2 系统级 i18n

- Locale 进入执行链：`TurnInput.locale` → 传播到所有 Runtime
- 内置工具的提示文本跟随 locale
- 错误消息跟随 locale
- 框架注入的 system prompt 片段（如 UI 组件列表）跟随 locale

## 7.7 测试框架

### 7.7.1 测试分层

```
tests/
  unit/                    # 纯函数、解析器、验证器测试
  integration/             # 多模块协作测试（Mock LLM）
  contract/                # Store 契约测试
  e2e/                     # 完整 Turn 执行测试（Mock LLM）
  model/                   # 真实 LLM 调用测试（可选，CI 中跳过）
```

### 7.7.2 测试工具

```typescript
// @covel/plugin-test-utils

export interface TestHarness {
  /** 创建测试环境（内存 Store + Mock LLM） */
  createTestEnv(options?: TestEnvOptions): TestEnv;
}

export interface TestEnv {
  /** 内存 Store */
  store: DataStore;
  /** Mock LLM provider */
  llm: MockLLMProvider;
  /** 插件注册表 */
  registry: PluginRegistry;
  /** Turn 执行器 */
  executor: TurnExecutor;

  /** 加载测试插件 */
  loadPlugin(dir: string): Promise<void>;

  /** 模拟一个 Turn */
  executeTurn(message: string): Promise<TurnResult>;

  /** 清理 */
  cleanup(): Promise<void>;
}

export interface MockLLMProvider extends LLMProvider {
  /** 预设 LLM 的响应 */
  mockResponse(response: LLMGenerateResult): void;
  /** 预设多轮响应（工具调用循环） */
  mockConversation(responses: LLMGenerateResult[]): void;
  /** 获取调用历史 */
  getCalls(): LLMGenerateParams[];
}
```

### 7.7.3 Contract Tests

所有 Store 后端实现共享同一套 contract test：

```typescript
export function runStoreContractTests(createStore: () => DataStore): void {
  describe("DataStore Contract", () => {
    // Session CRUD
    // RuntimeResult CRUD
    // State CRUD
    // Event CRUD
    // ...
  });
}
```

### 7.7.4 独立 Runtime 测试 API

```typescript
// POST /runtime/invoke
// 为每个 Runtime 提供独立测试入口
// 开发者可以不启动完整游戏来测试单个 Runtime
```

## 7.8 日志系统

### 7.8.1 Runtime 执行日志

每次 Runtime 执行生成完整日志：

```typescript
export interface RuntimeLog {
  /** Runtime 基本信息 */
  pluginId: string;
  runtimeId: string;
  priority: number;
  turnId: string;
  sessionId: string;

  /** 执行状态 */
  status: RuntimeStatus;

  /** 工具调用记录 */
  toolCalls: ToolCallRecord[];

  /** 输入上下文摘要（不存完整 prompt，太大） */
  contextSummary: {
    injectedSources: string[];
    loadedReferences: string[];
    templateVarsUsed: string[];
  };

  /** 输出结果 */
  output: Record<string, unknown> | null;

  /** 性能指标 */
  durationMs: number;
  tokenUsage?: { input: number; output: number };

  /** 跳过原因（如有） */
  skipReason?: string;

  /** 错误信息（如有） */
  error?: string;

  timestamp: string;
}
```

### 7.8.2 双通道设计

保留现有的双通道设计：

- **Runtime 日志**（DB 持久化）：结构化的 Runtime 执行记录
- **Infrastructure 日志**（pino）：服务器启动、插件加载、DB 操作等

## 7.9 热重载实现

```typescript
/**
 * 热重载完整流程：
 *
 * 1. chokidar 监听 plugins/ 目录
 * 2. 文件变更 → 判断影响的插件 ID
 * 3. 如果是 PLUGIN.md 变更：
 *    → 重新解析 frontmatter + body
 *    → 更新 PluginRegistry 中的对应条目
 *    → 如果 manifest 变更（如 priority 改变），通知 scheduler
 * 4. 如果是 tools/ 下文件变更：
 *    → 重新加载对应的 tool module
 *    → 更新 ToolRegistry
 * 5. 如果是 references/ 下文件变更：
 *    → 清除缓存，下次使用时重新加载
 * 6. 当前正在执行的 Turn 不受影响
 * 7. 通过 SSE 通知前端插件已更新
 */
```

## 7.10 验收标准

- [ ] 所有 API 端点可正确响应
- [ ] SSE 事件流正确推送 Turn 执行进度
- [ ] Narrator 文本支持流式推送
- [ ] UI 组件 schema 正确注入 system prompt
- [ ] 自定义组件可从插件目录加载
- [ ] 插件配置 CRUD + 热生效
- [ ] i18n PLUGIN.md 多语言加载正确
- [ ] 测试工具可创建 TestEnv 并执行模拟 Turn
- [ ] Store contract tests 覆盖所有接口方法
- [ ] Runtime 执行日志完整记录
- [ ] 热重载可检测变更并更新注册表
- [ ] 独立 Runtime 调用 API 可用于测试
- [ ] 全面的集成测试覆盖主要流程

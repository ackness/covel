# `@covel/api-client` · 独立包设计

## 目标

构建一个**零 React / 零 DOM 依赖**的类型化 API 门面，把 Covel 服务端的所有 HTTP/SSE 能力封装成可复用的客户端库。

**复用场景**：
- `apps/web-v2/` —— 当前主要消费者
- 未来的 Electron 桌面端（内嵌 server，渲染进程通过 IPC 或 loopback HTTP）
- 未来的 CLI 工具 / 脚本化测试
- `scripts/*` —— 数据迁移、压力测试、E2E 脚本

## 包结构

```
packages/api-client/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 — 对外入口
│   ├── client.ts                — ApiClient 门面类
│   ├── transport/
│   │   ├── transport.ts         — Transport 接口定义
│   │   ├── http-transport.ts    — fetch + EventSource 实现（默认）
│   │   └── README.md            — 扩展指南（IPC / mock 等）
│   ├── resources/
│   │   ├── worlds.ts            — /api/worlds*
│   │   ├── sessions.ts          — /api/sessions*
│   │   ├── messages.ts          — /api/sessions/:id/messages*
│   │   ├── state.ts             — /api/sessions/:id/state*
│   │   ├── characters.ts        — /api/sessions/:id/characters*
│   │   ├── plugin-data.ts       — /api/sessions/:id/plugin-data*
│   │   ├── traces.ts            — /api/traces*
│   │   ├── actions.ts           — /api/actions (SSE)
│   │   ├── events.ts            — /api/events/stream (SSE)
│   │   ├── llm-config.ts        — /api/presets, /api/llm-config
│   │   ├── model-db.ts          — /api/model-db*
│   │   ├── ui-specs.ts          — /api/ui-specs
│   │   └── health.ts            — /api/health
│   ├── types/
│   │   ├── index.ts             — re-export from @covel/shared
│   │   └── errors.ts            — ApiError 层级
│   └── sse/
│       ├── event-stream.ts      — AsyncIterable<Event> 抽象
│       └── parse-sse.ts         — 流解析工具
└── tests/
    ├── client.test.ts
    ├── http-transport.test.ts
    └── sse.test.ts
```

## Transport 抽象

所有网络请求都经过 `Transport` 接口，方便将来替换：

```typescript
export interface RequestInit {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;                  // "/api/sessions/:id" 格式
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;                // 将被 JSON 序列化
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Transport {
  request<T>(init: RequestInit): Promise<T>;
  stream(init: RequestInit): AsyncIterable<SseEvent>;
}

export interface SseEvent {
  type: string;
  data: unknown;                 // 已解析的 JSON
  id?: string;
  retry?: number;
}
```

默认实现：`HttpTransport`

```typescript
export class HttpTransport implements Transport {
  constructor(opts: {
    baseUrl: string;
    fetch?: typeof globalThis.fetch;    // 可注入，Node / Electron 主进程用自定义 fetch
    defaultHeaders?: () => Record<string, string>;  // 每次请求前调用，支持动态注入 provider keys
  }) {}
  // ...
}
```

未来 Electron 场景替换为 `IpcTransport`：

```typescript
export class IpcTransport implements Transport {
  constructor(private bridge: ElectronBridge) {}
  async request<T>(init: RequestInit): Promise<T> {
    return this.bridge.invoke("api:request", init);
  }
  stream(init: RequestInit): AsyncIterable<SseEvent> {
    return this.bridge.stream("api:stream", init);
  }
}
```

`ApiClient` 构造时接受 `transport`，全链路与传输无关。

## ApiClient 门面

```typescript
export class ApiClient {
  readonly worlds: WorldsResource;
  readonly sessions: SessionsResource;
  readonly messages: MessagesResource;
  readonly state: StateResource;
  readonly characters: CharactersResource;
  readonly pluginData: PluginDataResource;
  readonly traces: TracesResource;
  readonly actions: ActionsResource;
  readonly events: EventsResource;
  readonly llmConfig: LlmConfigResource;
  readonly modelDb: ModelDbResource;
  readonly uiSpecs: UiSpecsResource;
  readonly health: HealthResource;

  constructor(opts: ApiClientOptions) {
    const transport = opts.transport ?? new HttpTransport({
      baseUrl: opts.baseUrl ?? "/",
      fetch: opts.fetch,
      defaultHeaders: opts.defaultHeaders,
    });
    this.worlds = new WorldsResource(transport);
    // ...
  }
}
```

使用示例（web-v2 侧）：

```typescript
import { ApiClient } from "@covel/api-client";

const client = new ApiClient({
  baseUrl: "/",
  defaultHeaders: () => ({
    "X-Provider-Keys": encodeProviderKeys(getProviderKeysFromLocalStorage()),
  }),
});

const worlds = await client.worlds.list();
const session = await client.sessions.create({ worldId: "cloudmere" });

for await (const evt of client.actions.run({
  sessionId: session.id,
  input: { type: "start_session" },
})) {
  console.log(evt.type, evt.data);
}
```

## 类型派生策略

**所有类型从 `@covel/shared` 的 Zod schema `z.infer` 出来，零手写。**

举例：`WorldsResource.list()` 的返回类型

```typescript
// packages/shared/src/schemas/world.ts
export const worldSchema = z.object({
  id: z.string(),
  name: z.union([z.string(), z.record(z.string())]),
  // ...
});
export type World = z.infer<typeof worldSchema>;

// packages/api-client/src/resources/worlds.ts
import type { World } from "@covel/shared";

export class WorldsResource {
  constructor(private transport: Transport) {}

  async list(): Promise<World[]> {
    return this.transport.request<World[]>({
      method: "GET",
      path: "/api/worlds",
    });
  }
}
```

服务端路由已经用 Zod 验证（`apps/server/src/routes/api/*`），把这些 schema 升级到 `@covel/shared` 公开导出即可全链路同步。

## SSE 抽象

两个 SSE 通道：
- `/api/actions` —— 每次回合执行流式输出
- `/api/events/stream` —— 跨回合持久订阅（如 `plugin-data.changed`）

统一暴露为 `AsyncIterable<SseEvent>`，让消费侧用 `for await` 自然处理：

```typescript
async function runTurn(client: ApiClient, sessionId: string) {
  const stream = client.actions.run({
    sessionId,
    input: { type: "player_action", text: "look around" },
  });

  for await (const evt of stream) {
    switch (evt.type) {
      case "narrative.delta":
        appendToUi(evt.data.content);
        break;
      case "turn.end":
        return;
    }
  }
}
```

内部由 `parse-sse.ts` 处理 `ReadableStream` → 事件流的转换；Electron 的 `IpcTransport` 将 IPC 消息直接塞进同一个 `AsyncIterable` 通道。

## 错误处理

```typescript
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class NetworkError extends ApiError {}
export class NotFoundError extends ApiError {}
export class UnauthorizedError extends ApiError {}
export class ValidationError extends ApiError {}
```

服务端返回 `{ error: string, code?: string, details?: unknown }` 时 transport 层自动抛对应子类，调用方可以 `instanceof` 精细处理。

## 与 web-v2 现状的衔接

当前 `apps/web-v2/src/services/api.ts` 约 120 行零散 fetch 封装。迁移步骤：

1. 新增 `packages/api-client/`，实现 resources
2. 在 `apps/web-v2/package.json` 加依赖 `"@covel/api-client": "workspace:*"`
3. `services/api.ts` 改成：
   ```typescript
   import { ApiClient } from "@covel/api-client";
   export const apiClient = new ApiClient({ baseUrl: "/" });
   ```
4. 旧的导出函数（如 `listWorlds()`, `createSession()`）改为对 `apiClient.*` 的薄包装，或者直接让 call site 用 `apiClient.xxx()`
5. `session-store.ts` 内的所有 fetch 调用替换为 `apiClient.xxx()`
6. 验证 E2E 通过后，删除旧的 fetch 工具函数

## 测试策略

- **单元测试**：用 `undici MockAgent` 或 `msw/node` 模拟 HTTP，验证每个 resource 的请求/响应契约
- **SSE 测试**：构造固定的 `ReadableStream`，验证 `parse-sse.ts` 正确分帧
- **契约测试**：起一个真实的 server instance（`@covel/server` 暴露的 `bootstrapApi()`），对 `ApiClient` 做 in-process 调用，确保两边 schema 完全对齐
- **类型测试**：用 `expect-type` 或 `tsd` 确保 resource 返回类型和 `@covel/shared` 的 Zod 推导一致

## 非目标

- **不处理缓存**：请求缓存、stale-while-revalidate 等策略由上层（如 web-v2 的 zustand store、未来的 TanStack Query 集成）负责
- **不处理认证流**：只接受外部注入的 header，不管理 token 生命周期
- **不处理重试**：单次请求失败就抛错，重试由调用方决定（避免错误的乐观重试）
- **不绑定 React**：任何 hook / Provider 都在 `apps/web-v2/src/hooks/` 里实现，包内只有纯 TS

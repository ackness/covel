# API 参考

Covel HTTP API 参考文档。通过这些端点，你可以在没有前端 UI 的情况下，仅通过 HTTP 请求完成一局完整的 AI RPG 游戏。

## 概览

- **基础 URL**: `http://localhost:3001/api/`
- **协议**: HTTP JSON API (Content-Type: `application/json`)
- **服务器框架**: [Hono](https://hono.dev/)

### 存储后端

服务器端支持三种存储后端，通过环境变量 `STORE_BACKEND` 配置：

| 后端 | 值 | 用途 |
|------|-----|------|
| SQLite | `sqlite` (默认) | 本机开发 / 单机部署，数据落到 `./data/covel.db` |
| Memory | `memory` | 测试或一次性 demo，数据存于内存，重启丢失 |
| PostgreSQL | `pg` | 生产环境，需配置 `DATABASE_URL`；**多实例部署自动启用 `pg_advisory_lock` 分布式会话锁，跨 Node 进程对同一 session 互斥** |

> **注意**: IndexedDB (IDB) 是**前端专用**的存储后端，仅在浏览器中使用，服务器端不可用。

---

## 快速开始

下面演示一个完整的纯 API 游戏流程：从启动服务器到完成多轮对话。

### 1. 启动服务器

```bash
# 安装依赖
pnpm install

# 启动开发服务器 (Memory 后端, 端口 3001)
pnpm dev:server
```

### 2. 健康检查

```bash
curl http://localhost:3001/api/health
```

### 3. 浏览可用世界

```bash
curl http://localhost:3001/api/worlds
```

### 4. 查看可用插件

```bash
curl http://localhost:3001/api/plugins
```

### 5. 创建游戏会话

```bash
curl -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "worldId": "cloudmere",
    "locale": "zh-CN",
    "plugins": ["pregame", "narrator", "codex"]
  }'
```

记下返回的 `id`（格式为 `{worldId}-{uuid8}`，如 `cloudmere-a1b2c3d4`），后续请求都需要它。

### 6. 执行第一个 Turn（玩家发言）

```bash
curl -X POST http://localhost:3001/api/sessions/<sessionId>/turn \
  -H "Content-Type: application/json" \
  -d '{
    "message": "我环顾四周，观察这个陌生的世界"
  }'
```

### 7. 查看游戏状态

```bash
# 查看状态表
curl http://localhost:3001/api/sessions/<sessionId>/state

# 查看角色列表
curl http://localhost:3001/api/sessions/<sessionId>/characters

# 查看消息历史
curl http://localhost:3001/api/sessions/<sessionId>/messages
```

### 8. 继续对话

```bash
curl -X POST http://localhost:3001/api/sessions/<sessionId>/turn \
  -H "Content-Type: application/json" \
  -d '{
    "message": "走向远处的城镇"
  }'
```

### 9. 提交玩家交互（如果 Turn 返回了 pendingInputs）

```bash
curl -X POST http://localhost:3001/api/sessions/<sessionId>/submit-inputs \
  -H "Content-Type: application/json" \
  -d '{
    "turnId": "<turnId>",
    "submissions": [
      {
        "interactionId": "<interactionId>",
        "type": "choice",
        "values": { "selectedId": "option_1", "selectedLabel": "接受任务" }
      }
    ]
  }'
```

### 10. 结束会话

```bash
curl -X DELETE http://localhost:3001/api/sessions/<sessionId>
```

---

## 端点列表

### 健康检查

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/health` | 健康检查 |

### 世界管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/worlds` | 列出所有世界 |
| GET | `/api/worlds/:id` | 获取世界详情 |
| POST | `/api/worlds` | 创建/更新世界 |
| PATCH | `/api/worlds/:id` | 部分更新世界（支持顶层 `dimensions`，并与现有 `metadata` 合并） |
| GET | `/api/worlds/:id/dimensions/export` | 导出世界维度（YAML/JSON） |
| POST | `/api/worlds/:id/dimensions/import` | 导入世界维度 |
| POST | `/api/worlds/:id/sync-dimensions` | 将世界维度同步到活跃 session 的 `plugin_data` 与 lorebook 常量词条，并清理旧 key |

### 会话管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions` | 列出所有会话（可选 `?worldId=` 过滤） |
| POST | `/api/sessions` | 创建新会话 |
| GET | `/api/sessions/:id` | 获取会话信息 |
| PATCH | `/api/sessions/:id` | 更新会话字段（`status` / `runtimeModelOverrides`） |
| DELETE | `/api/sessions/:id` | 删除会话 |

### 会话快照

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/snapshot` | 获取完整会话快照（用于客户端恢复/重连） |

### Turn 执行

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/sessions/:id/turn` | 执行玩家回合 |

### 玩家交互

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/sessions/:id/submit-inputs` | 提交玩家交互响应(legacy alias,转发到 plugin-rpc `submit-form`) |
| POST | `/api/sessions/:id/plugin-rpc` | **PR-3** 统一插件 RPC 通道(action 级 / runtime 级) |
| GET  | `/api/sessions/:id/approvals` | **PR-7** 列出该 session 的待批准 RPC 请求 |
| POST | `/api/approvals/:approvalId/decision` | **PR-7** 提交玩家批准决定(allow/deny + once/session) |

### 会话插件管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/plugins` | 列出会话的活跃/可用插件 |
| POST | `/api/sessions/:id/plugins/enable` | 启用插件（body: `{ pluginId }`） |
| POST | `/api/sessions/:id/plugins/disable` | 禁用插件（body: `{ pluginId }`，core-plugin 返回 403） |

### 全局插件

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/plugins` | 列出所有已加载插件 |
| GET | `/api/plugins/:id` | 获取插件详情 |

### 状态查询

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/state` | 获取所有状态表 |

### 消息历史

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/messages` | 获取会话消息列表 |
| POST | `/api/sessions/:id/messages/sync` | 同步消息（LocalDataService 用） |

### 统一翻译层（Runtime Outputs / Interaction Records，PR-1）

为跨 runtime 消费和观测接入而设计的规范记录。每次 runtime 执行产生一条 `RuntimeOutput`，每次外部输入（玩家消息、插件 UI、RPC 调用）产生一条 `InteractionRecord`。两张表与 `trace_events` 并存 —— 翻译层面向"被组件消费"，trace 层面向"调试时钻取细节"。

> **接入状态（2026-04-27）**：服务端写入和查询 API 已实现并有测试覆盖；当前内置 Web UI 暂未直接消费这些 HTTP 查询端点，debug 页面主要使用 `/api/traces/*` 与 `/api/sessions/:id/snapshot`。这些端点保留为 observability / API client 能力，不应因 UI 暂未接入而删除。

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/runtime-outputs` | 列出该 session 的 runtime 输出记录，支持 `?runtimeId=` / `?pluginId=` / `?since=` / `?limit=` 过滤，按 timestamp 降序 |
| GET | `/api/sessions/:id/runtime-outputs/:outputId` | 获取单条 runtime 输出记录 |
| GET | `/api/sessions/:id/runtime-outputs/:outputId/full-prompt` | 从 `turn_messages` + `rawPromptDelta` 重建该次 LLM 调用的完整 prompt 历史（best-effort） |
| GET | `/api/sessions/:id/interaction-records` | 列出该 session 的外部输入记录，支持 `?type=` / `?source=` / `?targetPluginId=` / `?limit=` 过滤 |

**`RuntimeOutput` 结构**：
```ts
{
  id: string,
  sessionId: string,
  turnId: string,
  runtimeResultId?: string,  // 关联到 runtime_results 表
  pluginId: string,
  runtimeId: string,         // "{plugin}" 或 "{plugin}/{runtime}"
  timestamp: string,
  results: [{ text: string, structured?: unknown }],
  metaData: {
    turn: number,
    preGameDone?: boolean,                  // Pre-Game runtime 声明自身初始化已完成
    rawPromptDelta?: [{ role, content }],   // 相对上次调用的 prompt 增量
    outputResponses?: string[],             // 流式输出合并后的裸文本
    toolCallList?: [{ tool, input, output, status, durationMs }],
    modelSlot?: string,
    tokenUsage?: { input, output },
  }
}
```

**`InteractionRecord` 结构**：
```ts
{
  id: string,
  sessionId: string,
  turnId?: string,
  timestamp: string,
  source: 'player' | 'plugin-ui' | 'external-api',
  channel: 'web' | 'cli' | 'api' | 'external',
  type: 'message' | 'click' | 'form-submit' | 'rpc-call' | 'skill-invoke',
  targetPluginId?: string,
  targetRuntimeId?: string,
  payload: unknown,
  metaData?: { selectionSnapshot?, userAgent? }
}
```

**注意**：
- 翻译层写入是 best-effort。失败只打 warn，不阻塞 turn pipeline
- `rawPromptDelta` 在 PR-1 首迭代中不会被 turn-executor 自动填充。接入 LLM 调用链的 delta 采集在后续迭代完成
- full-prompt 重建端点目前用 turn_messages + delta 做近似还原，对 compaction 后的 session 可能不完全精确 —— 调试用途足够，审计场景需要走 trace_events


### 插件数据（Plugin Data）

> **接入状态（2026-04-27）**：内置 Web UI 目前使用 GET/list 读取 plugin-data（右侧面板、message UI specs、plugin data store）。PUT/DELETE 是管理/API 写入口，当前内置 Web UI 暂未直接调用；插件 runtime 推荐通过 plugin-data tools、plugin RPC 或 proposal 写入。PUT/DELETE 保持兼容，但若未来收窄攻击面，应先标记 deprecated 或加 admin/debug gate，而不是静默删除。

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/plugin-data/:pluginId/:namespace` | 列出某 namespace 下的数据 |
| GET | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 获取单条数据 |
| PUT | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 写入/更新数据 |
| DELETE | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 删除数据 |

### Working Memory（工作记忆）

> 需要环境变量 `COVEL_WORKING_MEMORY_V1=1`，否则返回 404。
>
> **接入状态（2026-04-27）**：Working Memory 的 store / proposal / prompt injection 是运行时功能；下列 HTTP CRUD 是管理/调试接口，当前内置 Web UI 暂未直接消费。若未来收敛写路径，应保持 URL/响应兼容，优先替换内部实现而不是直接删除。

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/working-memory` | 列出该 session 的所有工作记忆条目 |
| PUT | `/api/sessions/:id/working-memory/:scope/:key` | 写入/更新工作记忆（scope: player \| story \| shared） |
| DELETE | `/api/sessions/:id/working-memory/:scope/:key` | 删除工作记忆条目 |
| GET | `/api/sessions/:id/memory-blocks` | 只读返回 Letta 风格的 memory blocks（story scope，需 `COVEL_MEMORY_V1=1`）。2026-04-27 从 `/:id/memory` 重命名以避免与 `memory` 插件 id 冲突。 |

### Lorebook（S3-T6）

Session 级 lorebook 词条的只读查看 + 启用/删除管理。Entries 由插件通过 proposal commit 管道写入 store 层的 `lorebook_entries` 表，这些端点提供玩家 UI 与程序化读取视图，**不走提案系统**（单项 toggle/删除为 MVP 级别的直接写入）。

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/lorebook` | 列出该 session 的所有 lorebook 词条（按 `insertionOrder` 升序） |
| PATCH | `/api/sessions/:id/lorebook/:entryId` | 切换单条词条的 `enabled` 标志，body: `{ enabled: boolean }` |
| DELETE | `/api/sessions/:id/lorebook/:entryId` | 删除单条词条 |

响应：
- `GET` → `{ entries: LorebookEntryRecord[] }`（见 `packages/store/src/types.ts`）
- `PATCH` → `{ success: true, entryId, enabled }`
- `DELETE` → `{ success: true }`

404 场景：session 不存在、entryId 不存在。无 feature-flag 开关，始终启用。消费方：当前无内置 UI（右侧面板"世界"Tab 已切换为 WORLD.md 渲染，见 `docs/reference/ui-panels.md`）；插件可通过 `ui.right` JSON spec 自行消费这些端点。

### Suspend / Resume（S4-T4）

> 需要环境变量 `COVEL_SUSPEND_V1=1`。关闭时 `POST /resume` 与 `DELETE /suspensions/:suspensionId` 返回 `503`，`GET /suspensions` 返回空列表。

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/sessions/:id/resume` | 用提交的 data 重新启动指定 suspensionId 对应的 runtime |
| GET | `/api/sessions/:id/suspensions` | 列出当前 session 所有未解决的挂起项 |
| DELETE | `/api/sessions/:id/suspensions/:suspensionId` | 放弃一个挂起项（删除记录） |

### Snapshot / Fork（S4-T2）

> 需要环境变量 `COVEL_SNAPSHOTS_V1=1`。关闭时所有路径返回 `503`。
>
> **接入状态（2026-04-27）**：服务端手动快照、列表和 fork 能力已实现并有测试覆盖；当前内置 Web UI 只直接使用 `GET /api/sessions/:id/snapshot` 做恢复/重连，暂未提供手动快照列表或 fork 操作界面。

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/sessions/:id/snapshot` | 创建一份手动快照（kind=`manual`） |
| GET | `/api/sessions/:id/snapshots` | 列出当前 session 所有物化快照（auto / manual / fork） |
| POST | `/api/sessions/:id/fork` | 从指定 snapshotId 物化一个新 session，拷贝状态与截至 cursor 的消息 |

### 角色数据

> **接入状态（2026-04-27）**：当前内置 Web UI 主要通过 `GET /api/sessions/:id/snapshot` 获取角色快照；本节 REST 端点保留为轻量读取/管理 API。插件 runtime 推荐使用 `create-character` / `update-character` / `list-characters` / `get-character` 工具维护角色。`POST /characters` 是兼容管理入口，后续若收敛角色写路径，应保持 URL/响应兼容并优先替换内部实现。

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/characters` | 获取会话角色列表 |
| POST | `/api/sessions/:id/characters` | 创建/更新角色 |

### Actions（SSE 桥接）

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/actions` | SSE 动作桥接（发送消息/执行命令 → Turn 执行 → SSE 事件流） |

### 事件系统

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/events/stream?sessionId=xxx` | SSE 实时事件流（支持 topic 过滤和重放） |
| POST | `/api/events/emit` | 注入外部事件 |

### AI 生成

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/ai/ping` | 测试 LLM 提供商连通性 |
| POST | `/api/ai/generate-world` | AI 生成世界包 |

### 模型数据库（Model DB）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/model-db` | 获取模型数据库信息 |
| GET | `/api/model-db/search?q=xxx` | 搜索模型 |
| GET | `/api/model-db/lookup?model=xxx` | 查找模型能力 |
| POST | `/api/model-db/refresh` | 刷新模型数据库 |

### Trace 调试

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/traces/:sessionId` | 获取会话所有 trace 事件 |
| GET | `/api/traces/:sessionId/turns` | 按 Turn 分组的 trace 事件 |

### 媒体管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/media/:id?token=<signed>` | 内容寻址媒体下载（HMAC token + 会话引用校验） |
| POST | `/api/media/cleanup` | 破坏性维护端点：默认禁用 (`COVEL_MEDIA_CLEANUP_ENABLED`)，商业层 503，`dryRun:false` 需 `X-Confirm-Cleanup: yes` |

### 配置信息

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/presets` | 列出配置的模型预设 |
| GET | `/api/packages` | 列出已加载插件包（含 runtime/tool/`userSettings` 信息） |
| GET | `/api/commands` | 列出注册的命令 |
| GET | `/api/block-schemas` | 列出插件 block schema |
| GET | `/api/ui-specs?sessionId=<id>` | 列出插件 UI 声明（按 slot 分组）；带 `sessionId` 时按会话激活集过滤，不带则返回全部插件 |
| GET | `/api/llm-config` | 返回 slot 配置与能力信息 |
| GET | `/api/provider-keys` | 返回服务器配置的 API 密钥（仅 T1） |
| GET | `/api/config/info` | 返回当前部署信息（`isDesktop`、`covelHome`、`dataRoot` 等） |
| GET | `/api/config/keys` | 仅桌面：列出已配置的 provider（不返回值） |
| PUT | `/api/config/keys` | 仅桌面：写入 `<covelHome>/keys.env`；body `{ provider: value }` |
| GET | `/api/config/settings` | 仅桌面：读取 `<covelHome>/settings.json`（unified SettingsStore） |
| PUT | `/api/config/settings` | 仅桌面：原子写 `settings.json`；body `{ entries: Record<string, unknown> }` |
| PUT | `/api/config/data-root` | 仅桌面：改写 `config.toml` 的 `data_root` 行，需要重启服务器 |
| POST | `/api/config/open-folder` | 仅桌面：打开 config/data/logs 目录或 `llm.toml` / `keys.env` |

#### GET /api/ui-specs

返回插件的 UI 声明，按 slot 分组。前端在 boot 时调用，用于动态构建右侧面板 Tab 和消息区 block 渲染器。

**查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string（可选） | 指定后只返回该会话激活集中的插件；省略时返回全局所有已加载插件（向后兼容） |

**响应格式**：

```json
{
  "right": [
    {
      "pluginId": "codex",
      "specs": [{
        "id": "codex",
        "group": "codex",
        "label": { "zh": "知识图鉴", "en": "Codex" },
        "icon": "book-open",
        "dataSource": { "namespace": "entries" },
        "view": { "component": "Stack", "children": [...] }
      }]
    }
  ],
  "message": [...],
  "left": [...]
}
```

每个 slot 包含一个数组，元素为 `{ pluginId, specs[] }`。`specs` 中每项是一个 json-render spec（从插件 `ui/*.json` 文件加载）。

### Runtime 调用

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/runtime/invoke` | 独立调用单个 Runtime（计划中） |

---

## 详细文档

### 健康检查

#### `GET /api/health`

检查服务器是否正常运行。

**响应:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "storeBackend": "memory",
  "bootId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2025-01-15T10:00:00.000Z"
}
```

| 字段 | 说明 |
|------|------|
| `storeBackend` | 当前存储后端（`memory` / `pg`），前端据此选择 `LocalDataService` 或 `RemoteDataService` |
| `bootId` | 服务器启动 ID（UUID），每次重启变化，可用于检测服务器重启 |

---

### 世界管理

#### `GET /api/worlds`

列出所有已加载的世界。世界数据从 `worlds/` 目录读取并缓存在 Store 中。

**响应:**

```json
{
  "items": [
    {
      "id": "cloudmere",
      "name": "云溟界",
      "description": "一个漂浮于云层之上的奇幻世界...",
      "locale": "zh-CN",
      "metadata": {},
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

#### `GET /api/worlds/:id`

获取单个世界的详细信息。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 世界 ID（如 `cloudmere`） |

**响应 200:**

```json
{
  "id": "cloudmere",
  "name": "云溟界",
  "description": "一个漂浮于云层之上的奇幻世界...",
  "locale": "zh-CN",
  "metadata": {},
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

**响应 404:**

```json
{
  "error": "World not found: unknown-world"
}
```

#### `POST /api/worlds`

创建或更新一个世界记录（upsert 语义）。

**请求体:**

```json
{
  "id": "my-world",
  "name": "自定义世界",
  "description": "我的自定义世界描述",
  "locale": "zh-CN",
  "metadata": {}
}
```

**响应:**

```json
{
  "id": "my-world",
  "name": "自定义世界",
  "description": "我的自定义世界描述",
  "locale": "zh-CN",
  "metadata": {},
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

#### `GET /api/worlds/:id/dimensions/export`

导出世界维度数据。支持 YAML 和 JSON 格式。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 世界 ID |
| `format` | 查询 | `yaml`（默认）或 `json` |

**响应:** 以 `Content-Disposition: attachment` 返回维度数据文件。

#### `POST /api/worlds/:id/dimensions/import`

导入维度数据到世界（全量替换 dimensions）。导入后自动通知使用该世界的活跃 session。

**请求体:**

```json
{
  "dimensions": {
    "geography": { "overview": "...", "regions": [...] },
    "factions": [...]
  }
}
```

**响应:** 更新后的 WorldRecord。

**响应 422:** 维度数据校验失败。

#### `PATCH /api/worlds/:id`

部分更新世界。支持更新基础字段，也支持直接提交顶层 `dimensions`。

行为：

- 顶层 `dimensions` 会写入 `metadata.dimensions`
- `metadata` 采用 merge 语义，未提及的兄弟字段会保留
- `dimensions` 与 `metadata.dimensions` 都会经过世界维度校验

**请求体示例:**

```json
{
  "description": "更新后的描述",
  "dimensions": {
    "geography": { "overview": "新的地理结构" },
    "factions": { "groups": ["Guild"] }
  }
}
```

#### `POST /api/worlds/:id/sync-dimensions`

将世界最新维度数据同步到指定 session 的 `plugin_data` 与 lorebook 常量词条中。

行为：

- 覆盖同名维度 key
- 清理目标 session 中已经失效的旧维度 key
- 保持 `loadSessionConfig()` / `SessionContextSnapshot` 下一轮读取到最新世界词条

**请求体:**

```json
{ "sessionId": "neonridge-abcd1234" }
```

**响应:**

```json
{ "success": true, "syncedKeys": ["geography", "factions", ...], "entryCount": 9 }
```

---

### 会话管理

#### `GET /api/sessions`

列出所有游戏会话。支持 `?worldId=` 查询参数过滤。

**响应:**

```json
{
  "items": [
    {
      "id": "cloudmere-a1b2c3d4",
      "worldId": "cloudmere",
      "status": "active",
      "turnCount": 0,
      "preGameCompleted": [],
      "locale": "zh-CN",
      "activePlugins": ["pregame", "narrator"],
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

#### `POST /api/sessions`

创建一个新的游戏会话。

**请求体:**

```json
{
  "worldId": "cloudmere",
  "locale": "zh-CN",
  "plugins": ["pregame", "narrator", "codex"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `worldId` | string | 否 | 关联的世界 ID（校验: `/^[a-z0-9_-]{1,64}$/i`） |
| `locale` | string | 否 | 语言区域，默认 `zh-CN` |
| `plugins` | string[] | 否 | 要激活的插件 ID 列表 |
| `id` | string | 否 | 客户端自定义会话 ID（如不提供则自动生成 `{worldId}-{uuid8}`） |

**响应:**

```json
{
  "id": "cloudmere-a1b2c3d4",
  "worldId": "cloudmere",
  "locale": "zh-CN",
  "status": "active",
  "turnCount": 0,
  "preGameCompleted": [],
  "activePlugins": ["pregame", "narrator", "codex"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

**响应字段**:

- `status`(`'active' \| 'paused' \| 'ended'`) — 会话生命周期状态（turn-band 重构后替代原先的 `phase` 字段）
- `turnCount`(number) — 主循环轮数计数（从 0 开始，每次成功 turn +1）
- `preGameCompleted`(string[]) — 已完成 Pre-Game 初始化的 runtime id 集合，框架据此跳过后续轮次的 Pre-Game 调度

> **Session ID 格式**: 自动生成的 ID 格式为 `{worldId}-{uuid8}`（如 `cloudmere-a1b2c3d4`），使用 `crypto.randomUUID()` 后缀防止枚举。如未提供 worldId 则前缀为 `session`。

#### `GET /api/sessions/:id`

获取会话的完整信息。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**响应 200:**

```json
{
  "id": "cloudmere-a1b2c3d4",
  "worldId": "cloudmere",
  "status": "active",
  "turnCount": 3,
  "preGameCompleted": ["pregame", "world-init/schema-gen", "char-creator/player-init"],
  "locale": "zh-CN",
  "activePlugins": ["pregame", "narrator"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:05:00.000Z"
}
```

**响应 404:**

```json
{
  "error": "Session not found: <id>"
}
```

#### `PATCH /api/sessions/:id`

更新会话字段。当前支持 `status` 与 `runtimeModelOverrides`。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**请求体:**

```json
{
  "status": "paused",
  "runtimeModelOverrides": {
    "narrator": "balance",
    "codex/unlocker": "fast"
  }
}
```

**字段说明:**

- `status`(可选,`'active' \| 'paused' \| 'ended'`) — 会话生命周期状态。turn-band 重构后取代原先的 `phase` 字段——`phase` 已从 SessionRecord 中移除，运行进度改由 `turnCount` + `preGameCompleted` 集合描述。非合法枚举值返回 400。
- `runtimeModelOverrides`(可选,object) — PR-6 引入。Per-runtime 模型 slot 覆盖,key 为 runtime ID(`pluginId` 或 `pluginId/runtimeName`,必须匹配 `/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/`),value 为 `llm.toml` 中定义的 slot 名(如 `default` / `fast` / `balance`)。框架在每次 turn 执行前快照该字段,resolver 优先查找 session override → 然后 fallback 到 `manifest.model` → 最后 `default`。空对象 `{}` 清除所有覆盖。插件列表与 Session Prep 会暴露 runtime 的声明 slot；若声明 slot 未配置，UI 会提示补充 `[covel.<slot>]`，不会静默改绑到不相关的文本 slot。**Provider 与 API key 仍走前端 localStorage + `X-Provider-Keys` header,不入库,以保护隐私。**

**校验规则(runtimeModelOverrides):**
- 必须是对象(`null` / 数组 / 非对象类型 → 400)
- 最多 64 条目
- 空字符串 key / 非字符串 value / 不匹配 pattern 的 key 会被静默剥离
- 没传该字段 → 不动现有覆盖

**响应 200:** 返回合并后的会话对象（含 `status` / `turnCount` / `preGameCompleted` / `runtimeModelOverrides`）。

#### `DELETE /api/sessions/:id`

删除一个游戏会话。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**响应 200:**

```json
{
  "deleted": true
}
```

**响应 404:**

```json
{
  "error": "Session not found: <id>"
}
```

---

### Turn 执行

Turn 是游戏的核心交互单元。每次玩家发言触发一个 Turn，服务器调度所有活跃的 Runtime 按优先级执行，收集 LLM 输出并返回。

#### `POST /api/sessions/:id/turn`

执行一个玩家回合。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**请求体:**

```json
{
  "message": "我拔出剑，准备迎战",
  "locale": "zh-CN",
  "model": "deepseek-chat"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 玩家的文字输入 |
| `locale` | string | 否 | 覆盖会话语言 |
| `model` | string | 否 | 覆盖 LLM 模型（API 级别） |

**响应:**

```json
{
  "turnId": "a1b2c3d4-...",
  "sessionId": "cloudmere-a1b2c3d4",
  "runtimeResults": [
    {
      "pluginId": "narrator",
      "runtimeId": "narrator-main",
      "output": "你缓缓拔出腰间的长剑，剑刃在微弱的光芒中闪烁...",
      "toolCalls": [],
      "durationMs": 2340
    }
  ],
  "durationMs": 2500
}
```

**响应 404:**

```json
{
  "error": "Session \"<id>\" not found"
}
```

**使用说明:**

- Turn 执行是同步的，响应时间取决于 LLM 调用耗时
- 每个活跃 Runtime 按优先级依次执行（同优先级并行）
- `runtimeResults` 包含每个 Runtime 的输出，可能包含叙事文本、工具调用结果等
- Turn 执行后 `session.turnCount` 自动 +1
- 服务端会对每个 runtimeResult 运行 `processRuntimeResult` 提交管道（与 `/api/actions` 一致）：normalize → state.commit → 触发后续 SessionEvent
- 如果某个 Runtime 的输出包含 `pendingInputs`，需要通过 `/submit-inputs` 提交玩家响应

---

### 玩家交互

当 Turn 执行后产生 `pendingInputs`（如表单、选择题、确认框），玩家需要通过此端点提交响应。框架会将玩家输入转化为自然语言叙事，追加到对话历史中。

#### `POST /api/sessions/:id/submit-inputs`

提交一个或多个玩家交互响应。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**请求体（批量提交）:**

```json
{
  "turnId": "a1b2c3d4-...",
  "submissions": [
    {
      "interactionId": "char-creation-form",
      "type": "form",
      "values": {
        "name": "艾尔文",
        "class": "战士",
        "background": "孤儿出身的流浪剑客"
      }
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `turnId` | string | 是 | 产生该交互的 Turn ID |
| `submissions` | Submission[] | 是* | 提交数组 |

\*也支持遗留的单表单格式 `{ formId, values }`。

**Submission 对象:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `interactionId` | string | 交互 ID，来自 Turn 输出的 `pendingInputs` |
| `type` | `"form"` \| `"choice"` \| `"confirmation"` | 交互类型 |
| `values` | object | 玩家输入的值 |

**三种交互类型的 values 格式：**

**表单 (form):** 每个字段名对应一个值

```json
{
  "interactionId": "create-character",
  "type": "form",
  "values": { "name": "艾尔文", "class": "法师" }
}
```

**选择 (choice):** 提供 `selectedId` 和可选的 `selectedLabel`

```json
{
  "interactionId": "path-choice",
  "type": "choice",
  "values": { "selectedId": "forest_path", "selectedLabel": "穿越黑暗森林" }
}
```

**确认 (confirmation):** 提供 `confirmed` 布尔值

```json
{
  "interactionId": "accept-quest",
  "type": "confirmation",
  "values": { "confirmed": true }
}
```

**响应（批量）:**

```json
{
  "results": [
    {
      "interactionId": "char-creation-form",
      "filledNarrative": "旅人自称艾尔文，是一名孤儿出身的流浪剑客，以战士之姿行走江湖。",
      "accepted": true
    }
  ],
  "accepted": true
}
```

**响应（遗留单表单格式）:**

```json
{
  "submissionId": "...",
  "formId": "char-creation-form",
  "filledNarrative": "旅人自称艾尔文...",
  "accepted": true
}
```

**错误响应:**

```json
{ "error": "turnId is required" }                           // 400
{ "error": "submissions[] or formId+values are required" }  // 400
{ "error": "Session \"<id>\" not found" }                   // 404
```

**使用说明:**

- `filledNarrative` 是将玩家输入填入模板后的**纯自然语言**文本，不含 JSON 结构
- 该文本作为玩家消息追加到对话历史，供叙事者在下一轮 Turn 中参考（**不再生成合成的 assistant-role 消息**）
- 模板由插件提供，使用 `{{fieldName}}` 占位符语法
- 如果找不到模板，会生成一条简单的回退叙事（如 `[玩家输入] name: 艾尔文, class: 战士`）

> **PR-3 注意**: 此端点现在是 `POST /api/sessions/:id/plugin-rpc` 的薄封装,内部转发到框架默认的 `submit-form` action。新代码建议直接走 plugin-rpc。submit-inputs 路由会保留至少一个废弃周期。

---

### 插件 RPC 通道(PR-3)

#### `POST /api/sessions/:id/plugin-rpc`

统一的"结构化插件指令"通道。同时支持:

1. **Action 级**: `{ pluginId, action, payload }` — 调用插件在 PLUGIN.md `rpc` 字段中声明的 RPC handler,或框架默认 handler(如 `submit-form`)。返回单次 JSON。
2. **Runtime 级**: `{ pluginId, runtimeId, payload }` — 手动触发一次 runtime 执行。通过完整 Turn pipeline(prompt 组装、工具循环、proposal 提交)跑一次目标 runtime,事件触发的下游 runtime 会按 priority 自动 chain。执行子模式由 `manifest.execution` 决定:
   - `'sync'`(默认): 同步等待 runtime 完成,commit proposals 后返回汇总 JSON。
   - `'background'`: 立即返回 202 + `jobId`,后台通过 `setImmediate` 继续执行。进度/结果通过 `plugin_data` 表 `_jobs` 保留命名空间写回,前端经 `plugin-data.changed` SSE 感知变化。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**请求体:**

```json
{
  "pluginId": "framework",
  "action": "submit-form",
  "payload": {
    "turnId": "a1b2c3d4-...",
    "submissions": [
      { "interactionId": "char-form", "type": "form", "values": { "name": "艾尔文" } }
    ]
  }
}
```

或 action 级:

```json
{
  "pluginId": "codex",
  "action": "regenerate",
  "payload": { "cardId": "shrine-of-stars" }
}
```

或 runtime 级:

```json
{
  "pluginId": "dashscope-image-gen",
  "runtimeId": "dashscope-image-gen/prompt-generator",
  "payload": { "style": "cinematic" }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `pluginId` | string | 插件 ID(框架默认 handler 用 `framework` 占位即可) |
| `action` | string(可选) | RPC action 名,kebab-case。与 `runtimeId` 互斥 |
| `runtimeId` | string(可选) | runtime 全名(如 `my-plugin/my-runtime`)。与 `action` 互斥 |
| `payload` | unknown | handler 的输入数据 / agent runtime 的 manualPayload / function runtime 的 `ctx.manualPayload` |
| `expectsBackgroundFollower` | boolean(可选) | runtime 级 sync 入口若只是生成 prompt 并预计触发后台 follower，可设为 `true`。框架会立即写入 `_jobs` 占位并返回 202，随后在后台执行入口 runtime 与 follower，避免 UI 等 prompt LLM 完成后才出现任务。 |

**解析顺序(action 级):**

1. 插件声明的 action(`manifest.rpc[action]`,通过 `pluginId` 命名空间隔离)
2. 框架默认 action(全局,如 `submit-form` / `cancel`)

**框架默认 action:**

| Action | 说明 |
|--------|------|
| `submit-form` | 等同于 submit-inputs:持久化玩家输入、找模板消息、按 `{{字段}}` 填充自然语言 |

**响应 200 — action 级:**

```json
{
  "status": "ok",
  "result": { /* 取决于 handler */ }
}
```

**响应 200 — runtime 级,sync 模式:**

```json
{
  "status": "ok",
  "turnId": "7f3e-...",
  "runtimeResults": [
    {
      "runtimeId": "dashscope-image-gen/prompt-generator",
      "pluginId": "dashscope-image-gen",
      "status": "ok",
      "durationMs": 3421,
      "output": { /* runtime final output (parsed envelope) */ }
    }
  ],
  "durationMs": 3480
}
```

**图像/媒体生成输出:**

Function runtime 的完成态可返回 `assetGenerations[]`。每一项会被提交为 `asset.generate` proposal,并以 MediaRef 形式进入 trace / SSE / 视图层。

```json
{
  "assetGenerations": [
    {
      "ref": {
        "id": "media_01HX...",
        "mime": "image/png",
        "sha256": "..."
      },
      "modality": "image",
      "meta": {
        "prompt": "A misty harbor stairway",
        "provider": "openai",
        "model": "gpt-image-1"
      }
    }
  ],
  "pluginData": [
    {
      "namespace": "images",
      "key": "img_01HX...",
      "value": {
        "status": "done",
        "ref": { "id": "media_01HX...", "mime": "image/png", "sha256": "..." }
      }
    }
  ]
}
```

Provider-specific wire responses such as OpenAI `b64_json`, SDK `base64`, or expiring remote image URLs are transient handler inputs. The handler must call `ctx.media.put()` for bytes/base64 or `ctx.media.ingestUrl()` for remote URLs before returning, then expose the generated media through `assetGenerations[].ref` and ref-only business records.

For plugins with `capabilities: ["image-generation"]`, a successful completed runtime must return at least one valid `assetGenerations[]` entry. `pluginData` records in the `images` namespace must store `ref` records; completed outputs with old `url`, `base64`, or `dataUrl` image fields are reported as runtime errors.

**响应 202 — runtime 级,background 模式:**

```json
{
  "status": "accepted",
  "jobId": "a3c9-...",
  "pending": true,
  "turnId": "7f3e-...",
  "runtimeId": "dashscope-image-gen/image-generator"
}
```

当请求体包含 `expectsBackgroundFollower: true` 时，sync prompt-builder 也会使用同样的 202 形态立即返回；此时 `_jobs/{jobId}` 先以 `phase: "prompt"` / `message: "Generating image prompt..."` 写入，prompt 完成并排入后续 background follower 后会更新为 `status: "done"` 且包含 `deferredJobs`。

**`_jobs` 命名空间协议(background 模式):**

框架在 `plugin_data` 表中为每个后台任务保留以下 row,插件 **禁止**直接写该命名空间,但可订阅 SSE 读取:

```
sessionId     : <session>
pluginId      : <触发插件>
namespace     : "_jobs"
key           : <jobId>
value         : {
  status: "pending" | "done" | "failed",
  runtimeId: string,
  turnId: string,
  startedAt: ISO8601,
  completedAt?: ISO8601,
  durationMs?: number,
  runtimeResults?: RuntimeResultSummary[],   // status=done
  deferredJobs?: { jobId: string; runtimeId: string }[], // prompt-builder follower 队列
  phase?: "prompt" | string,
  message?: string,
  progress?: number,
  error?: string,                             // status=failed
  abortReason?: string
}
```

每次写入都会通过 store-proxy 发出 `plugin-data.changed` SSE 事件(见 [protocol.md](./protocol.md)),前端据此刷新 loading / final UI。

**错误响应:**

| 状态码 | 触发条件 |
|-------|---------|
| 400 | `pluginId` 缺失 / `action` 与 `runtimeId` 同时设置或同时缺失 / `RpcValidationError` / `plugin-mismatch`(runtimeId 不属于 pluginId) |
| 404 | 会话不存在 / `unknown-action`(action 未注册) / `runtime-not-active`(runtimeId 未加载到该 session) |
| 429 | `queue-full`(community trust 的待批准队列满) |
| 500 | handler 抛出未处理异常 / handler 模块加载失败 / `runtime-execution-failed` / `background-enqueue-failed` |

> 注意: background 模式下 runtime 内部异常 **不会**映射为 5xx HTTP 状态 —— 202 已经发出,失败信息写入 `_jobs/{jobId}.value.error`,前端通过 SSE 感知。

**插件 PLUGIN.md 中声明 RPC action:**

```yaml
---
name: my-plugin
description: ...
rpc:
  regenerate:
    handler: ./rpc/regenerate.js
    input: ./rpc/regenerate.schema.json   # 可选
    streaming: false                       # 默认 false
    description: 重新生成上一次叙事
  cancel:
    handler: ./rpc/cancel.js
    trustLevel: builtin                    # 强制 builtin 信任
---
```

> Action 名不能以 `framework-` 开头(保留给框架默认 handler)。所有 action 名必须是 kebab-case。

> Handler 是 `default export` 函数,签名 `(payload, context) => Promise<unknown>`。`context` 至少包含 `{ sessionId, pluginId, action, store }`。模块在首次调用时按需 `import()`。

---

### RPC Approval 流程(PR-7)

第三方插件(`community` 信任级别)的 RPC action 在执行前需要玩家显式批准,防止未审计的代码自动操作 session。

#### 流程

```
┌─────────┐    POST plugin-rpc                   ┌────────┐
│ Client  │ ───────────────────────────────────► │ Server │
└─────────┘    {pluginId, action, payload}       └────────┘
                                                       │
                                                       ▼
                                          gate.evaluate()
                                                       │
                       ┌───────────────────────────────┤
                       │                               │
              builtin/official                  community
              + 不在 cache                        + 不在 cache
                       │                               │
                       ▼                               ▼
              直接执行 → 200 ok          创建 pending → 202 approval-required
                                                       │
                                            ┌──────────┴──────────┐
                                            │ Client 弹对话框      │
                                            │ POST decision        │
                                            └──────────┬──────────┘
                                                       │
                                            allow once / allow session / deny
                                                       │
                                            重新发起 plugin-rpc
                                                       │
                                                  允许 → 200 ok
```

#### `POST /api/sessions/:id/plugin-rpc` 的额外响应状态

| 状态码 | 含义 |
|-------|------|
| 202 | `community` 信任级别需要 approval。响应体见下 |

**202 响应体:**

```json
{
  "status": "approval-required",
  "approvalId": "9d8c-...",
  "pending": {
    "approvalId": "9d8c-...",
    "sessionId": "sess-...",
    "pluginId": "third-party-plugin",
    "action": "do-thing",
    "payload": { /* 原始 payload */ },
    "trustLevel": "community",
    "requestedAt": "2026-04-15T20:00:00.000Z",
    "description": "Run the thing"
  }
}
```

#### `GET /api/sessions/:id/approvals`

列出该 session 当前所有未决批准。前端在刷新后用此重建对话框队列。

**响应 200:**

```json
{
  "pending": [
    { "approvalId": "9d8c-...", "pluginId": "...", "action": "...", ... }
  ]
}
```

#### `POST /api/approvals/:approvalId/decision`

提交玩家决定。

**请求体:**

```json
{
  "decision": "allow",
  "scope": "once"
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `decision` | `"allow"` \| `"deny"` | 是 | 玩家选择 |
| `scope` | `"once"` \| `"session"` | 仅 allow 时 | `once`(默认):允许这一次后过期,需重新批准;`session`:缓存到本 session 结束 |

**响应 200:**

```json
{
  "ok": true,
  "decision": "allow",
  "scope": "once",
  "pending": { /* 原始 pending 数据,已从队列移除 */ }
}
```

**错误响应:**

| 状态码 | 触发条件 |
|-------|---------|
| 400 | `decision` 字段缺失 / 非 `allow` 或 `deny` / `scope` 非法 |
| 404 | `approvalId` 不存在或已被消费 |

#### 信任等级与 approval 行为

| 信任等级 | 来源 | Approval 行为 |
|---------|------|--------------|
| `builtin` | 框架自带 / 框架默认 handler | 永远直接执行 |
| `official` | 维护团队白名单 | 永远直接执行 |
| `community` | 第三方,默认级别 | 每次都需要玩家批准,除非 session-cache 命中 |

> One-time grant 的 TTL 为 60 秒。如果玩家批准后 60 秒内没有发起对应的 dispatch,grant 会过期,需要重新走 dialog 流程。

> Approval 状态是**进程内 + 内存**,服务器重启后所有 pending / cache 全部清空。如果跨重启的持久化变得必要,可以把 gate 的状态写入 `plugin_data`(见 `packages/approval/src/rpc-approval.ts` 内联说明)。

---

### 插件管理

#### `GET /api/plugins`

列出所有已加载的插件。`name` 与 `description` 是 `I18nText`（可能是字符串或 `{ "<locale>": "..." }` 字典）。`capabilities` 为该插件所有 runtime 声明的 capability 并集；`outputKind` 取首个 runtime 的输出类别（`story` / `plugin` / `system`）；`source` 是框架根据加载路径派定的信任层级（`builtin` / `official` / `community`）。

UI 与第三方调用方应优先按 `capabilities` / `outputKind` / `source` 派发，**不要**根据 `id` 字符串硬编码（违反框架/插件隔离规则）。

**响应:**

```json
{
  "plugins": [
    {
      "id": "narrator",
      "name": { "zh-CN": "核心叙事者", "en-US": "Narrator" },
      "description": "主要叙事生成插件",
      "pluginType": "core-plugin",
      "runtimeCount": 1,
      "status": "active",
      "source": "builtin",
      "capabilities": ["narrative"],
      "outputKind": "story"
    },
    {
      "id": "dashscope-image-gen",
      "name": "DashScope Image",
      "description": "DashScope 文生图（wan2.x）",
      "pluginType": "plugin",
      "runtimeCount": 2,
      "status": "active",
      "source": "community",
      "capabilities": ["image-generation", "image-prompt", "manual-invoke"],
      "outputKind": "plugin"
    }
  ]
}
```

#### `GET /api/plugins/:id`

获取单个插件的详细信息。返回字段与列表项一致。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 插件 ID（如 `narrator`） |

**响应 200:**

```json
{
  "id": "narrator",
  "name": { "zh-CN": "核心叙事者", "en-US": "Narrator" },
  "description": "主要叙事生成插件",
  "pluginType": "core-plugin",
  "runtimeCount": 1,
  "status": "active",
  "source": "builtin",
  "capabilities": ["narrative"],
  "outputKind": "story"
}
```

**响应 404:**

```json
{
  "error": "Plugin \"narrator\" not found"
}
```

---

### 会话插件管理

#### `GET /api/sessions/:id/plugins`

列出会话的活跃插件和所有可用插件。

**响应:**

```json
{
  "active": ["pregame", "narrator"],
  "available": [
    {
      "id": "narrator",
      "name": "核心叙事者",
      "description": "主要叙事生成插件",
      "pluginType": "runtime",
      "active": true,
      "capabilities": ["narrative"]
    }
  ]
}
```

#### `POST /api/sessions/:id/plugins/enable`

启用一个插件。

**请求体:**

```json
{ "pluginId": "codex" }
```

**响应:**

```json
{ "ok": true, "active": ["pregame", "narrator", "codex"] }
```

#### `POST /api/sessions/:id/plugins/disable`

禁用一个插件。如果目标插件 `pluginType === "core-plugin"`，返回 **403** 拒绝禁用（核心插件由框架保护）。

**请求体:**

```json
{ "pluginId": "codex" }
```

**响应 200:**

```json
{ "ok": true, "active": ["pregame", "narrator"] }
```

**响应 403:**

```json
{ "error": "Cannot disable core plugin \"narrator\"" }
```

---

### 状态查询

状态系统以结构化表格形式存储游戏世界的各类事实（如角色属性、世界状态、任务进度）。每个表由插件通过 StateManager 注册。

#### `GET /api/sessions/:id/state`

获取会话的所有状态表及其数据。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**响应 200:**

```json
{
  "tables": {
    "character_stats": {
      "schema": {
        "name": "character_stats",
        "fields": [
          { "name": "hp", "type": "number", "default": 100 },
          { "name": "mp", "type": "number", "default": 50 }
        ]
      },
      "data": {
        "hp": 85,
        "mp": 42
      }
    },
    "world_flags": {
      "schema": {
        "name": "world_flags",
        "fields": [
          { "name": "gate_opened", "type": "boolean", "default": false }
        ]
      },
      "data": {
        "gate_opened": true
      }
    }
  }
}
```

**响应 404:**

```json
{
  "error": "Session not found: <id>"
}
```

---

### 消息历史

#### `GET /api/sessions/:id/messages`

获取会话的所有消息列表。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**响应:**

```json
{
  "items": [
    {
      "id": "msg-001",
      "sessionId": "cloudmere-a1b2c3d4",
      "role": "user",
      "content": "我环顾四周",
      "createdAt": "2025-01-15T10:00:00.000Z"
    },
    {
      "id": "msg-002",
      "sessionId": "cloudmere-a1b2c3d4",
      "role": "assistant",
      "content": "你发现自己站在一片广阔的草原上...",
      "createdAt": "2025-01-15T10:00:05.000Z"
    }
  ]
}
```

---

### 插件数据（Plugin Data）

插件的 session 级持久化 KV 存储。数据按 `(sessionId, pluginId, namespace, key)` 隔离。

> **接入状态（2026-04-27）**：内置 Web UI 目前使用 GET/list 读取 plugin-data（右侧面板、message UI specs、plugin data store）。PUT/DELETE 是管理/API 写入口，当前内置 Web UI 暂未直接调用；插件 runtime 推荐通过 plugin-data tools、plugin RPC 或 proposal 写入。PUT/DELETE 保持兼容，但若未来收窄攻击面，应先标记 deprecated 或加 admin/debug gate，而不是静默删除。

#### `GET /api/sessions/:id/plugin-data/:pluginId/:namespace`

列出某插件某 namespace 下的所有数据条目。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |
| `pluginId` | 路径 | 插件 ID（如 `world-init`） |
| `namespace` | 路径 | 数据命名空间（如 `schema`, `entries`） |

**响应:**

```json
{
  "items": [
    { "namespace": "schema", "key": "attributes", "value": { ... }, "updatedAt": "..." },
    { "namespace": "schema", "key": "skills", "value": { ... }, "updatedAt": "..." }
  ]
}
```

#### `GET /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`

获取单条插件数据。

**响应:**

```json
{ "namespace": "schema", "key": "attributes", "value": { ... }, "updatedAt": "..." }
```

#### `PUT /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`

写入或更新单条插件数据。Value 最大 64KB。

**请求体:**

```json
{ "value": { "dimensions": ["strength", "agility", "wisdom"] } }
```

**响应:**

```json
{ "success": true, "namespace": "schema", "key": "attributes" }
```

#### `DELETE /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`

删除单条插件数据。

**响应:**

```json
{ "success": true }
```

---

### Working Memory（工作记忆）

> 需要环境变量 `COVEL_WORKING_MEMORY_V1=1`，否则所有端点返回 `404 Feature flag not enabled`。
>
> **接入状态（2026-04-27）**：Working Memory 的 store / proposal / prompt injection 是运行时功能；下列 HTTP CRUD 是管理/调试接口，当前内置 Web UI 暂未直接消费。若未来收敛写路径，应保持 URL/响应兼容，优先替换内部实现而不是直接删除。

#### `GET /api/sessions/:id/working-memory`

列出该 session 的所有工作记忆条目，按 scope（player → story → shared）和 key 排序。

**响应:**

```json
{
  "entries": [
    {
      "id": "wm_abc123",
      "sessionId": "world-uuid8",
      "key": "mood",
      "scope": "player",
      "value": "cautious",
      "schemaRef": null,
      "updatedAt": "2026-04-12T00:00:00.000Z"
    }
  ]
}
```

#### `PUT /api/sessions/:id/working-memory/:scope/:key`

写入或更新工作记忆条目（upsert）。scope 必须是 `player`、`story` 或 `shared` 之一。

**请求体:**

```json
{ "value": <any JSON>, "schemaRef": "optional-schema-id" }
```

**响应:**

```json
{ "success": true }
```

#### `DELETE /api/sessions/:id/working-memory/:scope/:key`

删除工作记忆条目。

**响应:**

```json
{ "success": true }
```

---

### Suspend / Resume（S4-T4）

> 需要环境变量 `COVEL_SUSPEND_V1=1`。flag 关闭时所有写路径返回 `503 Service Unavailable`（表示端点存在但功能未启用），列表路径返回空数组。

#### `POST /api/sessions/:id/resume`

用玩家提交的数据重新启动一个被 `suspend` 工具暂停的 runtime。
请求**必须**带 `X-Provider-Keys` header（API key 不在服务端持久化，每次 resume 都要重新提供）。

**请求体:**

```json
{
  "suspensionId": "susp_abc123",
  "data": { /* shape 必须匹配 suspension.resumeSchema */ }
}
```

服务器会用 `suspension.resumeSchema` 对 `data` 做最小 JSON Schema 校验（type / required / 顶层 properties type）；不匹配返回 `400`。

**响应:**

```json
{ "result": <ResumeResult> }
```

**错误码:**

| 状态 | 触发条件 |
|------|---------|
| `400` | 缺少 `X-Provider-Keys`、JSON body 错误、`suspensionId` 缺失或 schema 校验失败 |
| `404` | session、suspension 不存在，或 suspension 已 resolved，或 runtime manifest 找不到 |
| `500` | `resumeSuspendedRuntime()` 抛出错误 |
| `503` | `COVEL_SUSPEND_V1` 未启用 |

#### `GET /api/sessions/:id/suspensions`

列出指定 session 当前所有挂起项，按 `createdAt asc` 排序。flag 关闭时直接返回 `{ "suspensions": [] }`。

**响应:**

```json
{
  "suspensions": [
    {
      "id": "susp_abc123",
      "sessionId": "world-uuid8",
      "turnId": "turn-...",
      "runtimeId": "core-foo/bar",
      "pluginId": "core-foo",
      "reason": "需要玩家选择路线",
      "resumeSchema": { "type": "object", "required": ["choice"], "properties": { "choice": { "type": "string" } } },
      "pendingContinuation": { /* runtime-internal serialized state */ },
      "createdAt": "2026-04-12T00:00:00.000Z",
      "resolvedAt": null
    }
  ]
}
```

#### `DELETE /api/sessions/:id/suspensions/:suspensionId`

放弃一个挂起项 —— 直接从 `suspensions` 表删除。用于玩家放弃当前选择 / 管理界面清理。

**响应:**

```json
{ "deleted": true, "suspensionId": "susp_abc123" }
```

---

### Snapshot / Fork（S4-T2）

> 需要环境变量 `COVEL_SNAPSHOTS_V1=1`。关闭时所有路径返回 `503`（`{ "error": "...", "code": "feature_disabled" }`）。
>
> **接入状态（2026-04-27）**：服务端手动快照、列表和 fork 能力已实现并有测试覆盖；当前内置 Web UI 只直接使用 `GET /api/sessions/:id/snapshot` 做恢复/重连，暂未提供手动快照列表或 fork 操作界面。

物化快照是存档 / 读档 / 时间线分叉的核心 —— 每个快照把一个回合结束时的完整 session 状态序列化为 `payload`，保存在 `state_snapshots` 表。`kind` 取三种值：`auto`（flag 开启时每回合结束自动写入）、`manual`（`POST /snapshot` 显式创建）、`fork`（`POST /fork` 写到子 session 上记录来源）。

#### `POST /api/sessions/:id/snapshot`

从当前 session 状态物化一份 `kind="manual"` 的快照。payload 包含 characters、stateEntries、pluginData、workingMemory、lorebookEntries、suspensions（未解决的挂起项）以及 messagesCursor（最后一条 `turn_message.id`）。

**响应:**

```json
{
  "snapshot": {
    "id": "<uuid>",
    "sessionId": "cloudmere-a1b2c3d4",
    "turnId": "turn-42",
    "kind": "manual",
    "payload": {
      "schemaVersion": 1,
      "turnId": "turn-42",
      "characters": [ /* ... */ ],
      "stateEntries": [ /* ... */ ],
      "pluginData": [ /* ... */ ],
      "workingMemory": [ /* ... */ ],
      "lorebookEntries": [],
      "suspensions": [ /* 未解决的 SuspensionRecord[] */ ],
      "messagesCursor": "tm_abc"
    },
    "createdAt": "2026-04-13T00:00:00.000Z"
  }
}
```

返回 `201 Created`；session 不存在时返回 `404`。

#### `GET /api/sessions/:id/snapshots`

列出指定 session 的所有快照（`auto` / `manual` / `fork`），按 `createdAt` 升序。

```json
{ "snapshots": [ /* SnapshotRecord[] */ ] }
```

session 不存在时返回 `404`。

#### `POST /api/sessions/:id/fork`

基于指定 snapshot 物化一个新的 session。请求体：

```json
{ "fromSnapshotId": "<snapshot-uuid>" }
```

服务端会：
1. 创建新 sessionId（`{worldId}-{uuid8}`）；
2. 复用父 session 的 locale / activePlugins / status / turnCount / preGameCompleted；
3. **拷贝** characters / state entries / plugin data / working memory / state schemas / unresolved suspensions 到新 session；
4. 从 `turn_messages` 中按顺序拷贝消息直到 `payload.messagesCursor`（含），超过 cursor 的消息不拷贝。cursor 在父 session 中已丢失（compact / 删除等）时返回 `409 { code: 'cursor_missing' }`；
5. 写入一个 `kind="fork"` 的快照到子 session，`parentId` 指向源 snapshot，供 provenance 追踪；
6. 在 eventBus 上广播 `session.forked`（SSE topic=`session`）。

**响应:**

```json
{
  "sessionId": "cloudmere-<new-uuid8>",
  "parentSessionId": "cloudmere-a1b2c3d4",
  "fromSnapshotId": "<parent-snapshot-id>",
  "forkSnapshotId": "<child-fork-snapshot-id>"
}
```

返回 `201 Created`；快照不属于该 session、快照不存在、或父 session 不存在均返回 `404`；`fromSnapshotId` 缺失返回 `400`；`payload.messagesCursor` 指向的消息已不在父 session 中返回 `409 { code: 'cursor_missing' }`；内部写入失败返回 `500`。

整个 fork 在 `beginTx` / `commitTx` 下写入，中途任何失败都会 rollback，不会留下半成品子 session。

---

### 角色数据

> **接入状态（2026-04-27）**：当前内置 Web UI 主要通过 `GET /api/sessions/:id/snapshot` 获取角色快照；本节 REST 端点保留为轻量读取/管理 API。插件 runtime 推荐使用 `create-character` / `update-character` / `list-characters` / `get-character` 工具维护角色。`POST /characters` 是兼容管理入口，后续若收敛角色写路径，应保持 URL/响应兼容并优先替换内部实现。

#### `GET /api/sessions/:id/characters`

获取会话中的所有角色。角色在游戏过程中动态创建和演化。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**响应:**

```json
{
  "items": [
    {
      "id": "char-001",
      "sessionId": "cloudmere-a1b2c3d4",
      "name": "艾尔文",
      "type": "player",
      "description": "一名孤儿出身的流浪剑客",
      "fields": { "class": "战士", "level": 3 },
      "version": 2,
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:10:00.000Z"
    }
  ]
}
```

#### `POST /api/sessions/:id/characters`

创建或更新一个角色（upsert 语义）。该兼容管理端点内部通过 `character.upsert` proposal 提交，因此后续可继续接入 commit pipeline 的 hook / trace 策略，同时保持原 URL 和响应形状。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**请求体:**

```json
{
  "id": "char-001",
  "name": "艾尔文",
  "type": "player",
  "description": "一名孤儿出身的流浪剑客",
  "fields": { "class": "战士", "level": 3 },
  "version": 2
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 角色 ID |
| `name` | string | 是 | 角色名称 |
| `type` | string | 是 | 角色类型（如 `player`, `npc`） |
| `description` | string | 否 | 角色描述 |
| `fields` | object | 否 | 自定义属性（JSON） |
| `version` | number | 是 | 版本号 |

**响应:**

```json
{
  "id": "char-001",
  "sessionId": "cloudmere-a1b2c3d4",
  "name": "艾尔文",
  "type": "player",
  "description": "一名孤儿出身的流浪剑客",
  "fields": { "class": "战士", "level": 3 },
  "version": 2,
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:10:00.000Z"
}
```

---

### 事件系统

事件系统基于 EventBus，支持 SSE (Server-Sent Events) 实时推送和外部事件注入。

#### `GET /api/events/stream?sessionId=xxx`

订阅指定会话的实时事件流（SSE 长连接）。支持 topic 过滤和事件重放。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 会话 ID |
| `topics` | string | 否 | 逗号分隔的 topic 过滤（如 `runtime,state`） |
| `lastEventId` | string | 否 | 从此 ID 之后重放事件（用于断线重连） |

**示例:**

```bash
curl -N "http://localhost:3001/api/events/stream?sessionId=<sessionId>"
```

**SSE 事件格式:**

连接成功后收到的第一条消息：

```
event: connected
data: {"sessionId":"cloudmere-a1b2c3d4","timestamp":"2025-01-15T10:00:00.000Z"}
```

后续事件：

```
event: turn.completed
data: {"turnId":"a1b2c3d4-...","durationMs":2500}
id: evt-001

event: state.updated
data: {"table":"character_stats","field":"hp","value":85}
id: evt-002
```

**使用说明:**

- 使用 `curl -N`（禁用缓冲）来正确显示 SSE 流
- 连接保持活跃直到客户端断开
- 服务器每 30 秒发送心跳维持连接
- 只接收 `sessionId` 匹配的事件

**错误响应:**

```json
{
  "error": "sessionId query parameter required"
}
```

#### `POST /api/events/emit`

从外部注入事件到 EventBus 中。可用于触发特定 Runtime 或模拟游戏事件。

**请求体:**

```json
{
  "topic": "combat.start",
  "payload": { "enemyId": "goblin-01", "terrain": "forest" },
  "sessionId": "cloudmere-a1b2c3d4",
  "targetRuntime": "combat"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | 是 | 事件主题 |
| `payload` | object | 否 | 事件负载数据 |
| `sessionId` | string | 是 | 目标会话 ID |
| `targetRuntime` | string | 否 | 指定接收事件的 Runtime |

**响应:**

```json
{
  "id": "evt-a1b2c3d4",
  "emitted": true
}
```

**错误响应:**

```json
{
  "error": "topic and sessionId are required"
}
```

---

### Actions（SSE 桥接）

#### `POST /api/actions`

前端主要使用此端点进行游戏交互。将动作请求（发送消息、执行命令等）翻译为 Turn 执行，并通过 SSE 流式返回结果。

**请求体:**

```json
{
  "requestId": "req-001",
  "type": "send_message",
  "sessionId": "cloudmere-a1b2c3d4",
  "locale": "zh-CN",
  "payload": {
    "message": "我拔出剑，准备迎战"
  }
}
```

**响应:** SSE 事件流，使用 `ProtocolEventType` 类型。详见下方「SSE 协议」章节。

---

### AI 生成

#### `POST /api/ai/ping`

测试 LLM 提供商连通性。

**请求体:**

```json
{ "presetId": "default" }
```

**响应:**

```json
{
  "ok": true,
  "latencyMs": 0,
  "text": "Preset default (deepseek/deepseek-chat) configured"
}
```

#### `POST /api/ai/generate-world`

AI 生成世界包。LLM 自主决定世界的所有细节（id、name、tags、dimensions、lore）。

**请求体:**

```json
{
  "concept": "一个被永恒暴风雪笼罩的冰封大陆",
  "locale": "zh-CN",
  "model": "deepseek-chat"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `concept` | string | 是 | 世界概念描述（最多 2000 字符） |
| `locale` | string | 否 | 语言区域，默认 `zh-CN` |
| `model` | string | 否 | 覆盖 LLM 模型 |

**响应 200:** 生成的世界包数据。

**响应 422:** `{ "error": "World generation failed", "details": [...] }`

---

### Trace 调试

#### `GET /api/traces/:sessionId`

获取会话的所有 trace 事件。

**响应:**

```json
{
  "sessionId": "cloudmere-a1b2c3d4",
  "count": 42,
  "events": [
    {
      "type": "runtime.started",
      "requestId": "req-001",
      "traceId": "trace-001",
      "sessionId": "cloudmere-a1b2c3d4",
      "turnId": "turn-001",
      "flowId": "flow-001",
      "seq": 0,
      "timestamp": "2025-01-15T10:00:00.000Z",
      "payload": {}
    }
  ]
}
```

#### `GET /api/traces/:sessionId/turns`

按 Turn 分组的 trace 事件。

**响应:**

```json
{
  "sessionId": "cloudmere-a1b2c3d4",
  "turnCount": 3,
  "turns": [
    {
      "turnId": "turn-001",
      "flowId": "flow-001",
      "traceId": "trace-001",
      "startedAt": "2025-01-15T10:00:00.000Z",
      "completedAt": "2025-01-15T10:00:05.000Z",
      "eventCount": 12,
      "events": [...]
    }
  ]
}
```

---

### Runtime 调用

#### `POST /api/runtime/invoke` -- 计划中

独立调用单个 Runtime，用于测试和调试。

**当前状态:** 返回 `501 Not Implemented`。

```json
{
  "error": "Not implemented"
}
```

---

### 媒体管理

#### `GET /api/media/:id?token=<signed>`

短时鉴权下载内容寻址媒体。`token` 通过 `GET /api/sessions/:id/media-token?id=<mediaId>` 颁发。详细鉴权语义见路由实现 doc-comment。

#### `POST /api/media/cleanup`

破坏性维护端点：扫描 `messages` / `plugin_data` / `runtime_outputs` / `trace_events` / `snapshots` / `turn_results` / `runtime_results` 收集仍被引用的 mediaId，再调用 `MediaStore.cleanup()` 删除未引用的资产。

**默认禁用。** 必须显式启用：

| 条件 | 行为 |
|------|------|
| `COVEL_MEDIA_CLEANUP_ENABLED` 未设为 truthy（`true` / `1`） | 403 `{ "error": "cleanup endpoint disabled", "code": "forbidden" }` |
| `DEPLOYMENT_TIER=commercial` | 503 `{ "error": "cleanup endpoint not available in this deployment tier", "code": "unavailable" }` — 在管理员鉴权中间件就绪前永远不在商业部署可用 |
| `dryRun:false` 且无 `X-Confirm-Cleanup: yes` 请求头 | 400 `{ "error": "confirmation header missing: …", "code": "invalid_request" }` |
| 同一时刻第二次并发请求 | 429 `{ "error": "Operation already in progress" }` (singleFlight) |
| 任一会话的扫描行数超过 `scanLimit`（默认 1000） | 400 `{ "error": "scan limit exceeded for session …", "code": "limit_exceeded" }` |

**请求体:**

```json
{
  "dryRun": true,
  "maxBytes": 0,
  "maxAgeMs": 0,
  "keepRecentBytes": 0,
  "scanLimit": 1000
}
```

- `dryRun` (boolean, default `true`) — `true` 仅返回拟删除清单；`false` 真正删除，需配合 `X-Confirm-Cleanup: yes`。
- `maxBytes` / `maxAgeMs` / `keepRecentBytes` (non-negative number, optional) — 透传 `MediaLifecyclePolicy`。
- `scanLimit` (positive integer, optional, default 1000) — 单个 session 累计扫描行数上限。超过即拒绝，宁可让运维显式抬高也不静默截断。

**成功响应（200）:**

```json
{
  "policy": { "dryRun": true, "maxBytes": 0 },
  "result": {
    "scanned": 12,
    "protected": 7,
    "retained": 7,
    "deleted": 5,
    "totalBytes": 1048576,
    "bytesDeleted": 524288,
    "bytesRetained": 524288,
    "protectedIds": ["..."],
    "deletedIds": ["..."]
  }
}
```

**示例:**

```bash
# Dry-run only — 安全
COVEL_MEDIA_CLEANUP_ENABLED=true \
  curl -X POST http://localhost:3001/api/media/cleanup \
       -H "content-type: application/json" \
       -d '{"dryRun": true}'

# 真正删除 — 必须带确认头
COVEL_MEDIA_CLEANUP_ENABLED=true \
  curl -X POST http://localhost:3001/api/media/cleanup \
       -H "content-type: application/json" \
       -H "X-Confirm-Cleanup: yes" \
       -d '{"dryRun": false, "maxBytes": 0}'
```

> 大型部署（>100 sessions）会自动按 50 个一批迭代并通过 `console.info` 输出 `[cleanup] scanned X/Y sessions` 进度。

---

## SSE 协议

Covel 使用 `ProtocolEventType` 定义 server → client 的实时事件。Actions 端点 (`POST /api/actions`) 和事件流 (`GET /api/events/stream`) 均使用此协议。

### 事件类型

| 类型 | 分类 | 说明 |
|------|------|------|
| `narrative.delta` | 叙事 | 叙事文本增量（逐 token 流式） |
| `narrative.completed` | 叙事 | 叙事文本完成 |
| `interaction.requested` | 交互 | 请求玩家输入（表单/选择/确认） |
| `interaction.completed` | 交互 | 玩家交互完成 |
| `state.changed` | 状态 | 游戏状态变更 |
| `state.snapshot` | 状态 | 状态快照 |
| `execution.started` | 执行生命周期 | Turn 执行开始 |
| `runtime.started` | 执行生命周期 | 单个 Runtime 开始执行 |
| `runtime.completed` | 执行生命周期 | 单个 Runtime 执行完成 |
| `runtime.failed` | 执行生命周期 | Runtime 执行失败 |
| `execution.completed` | 执行生命周期 | Turn 执行完成 |
| `record.updated` | 会话生命周期 | 记录更新（角色、任务等） |
| `event.emitted` | 会话生命周期 | 事件发射 |
| `error.occurred` | 系统 | 错误发生 |
| `connection.restored` | 系统 | 连接恢复 |

### 事件格式

```typescript
interface ProtocolEvent {
  id: string;
  type: ProtocolEventType;
  sessionId: string;
  turnId?: string;
  source?: { pluginId: string; runtimeId: string };
  payload: Record<string, unknown>;
  timestamp: string;
}
```

> 完整协议定义参见 `packages/shared/src/types/protocol.ts`。

---

## 存储模式说明

Covel 支持三种部署层级 (Deployment Tier)，每种层级使用不同的存储策略：

### T1: 自部署 (Self-Deploy)

- **服务器存储**: Memory（默认）或 SQLite
- **前端存储**: 浏览器 IndexedDB
- **数据流**: 前端在每次操作前通过 `syncToServer()` 将 IndexedDB 数据推送到服务器的 MemoryStore，让无状态服务器能处理 Turn
- **API 密钥**: 用户自行管理，存储在浏览器 localStorage
- **认证**: 无

```bash
# 启动方式
pnpm dev:server                    # Memory 后端
STORE_BACKEND=sqlite pnpm dev:server  # SQLite 后端
```

### T2: 演示托管 (Demo Host)

- **服务器存储**: Memory 或 SQLite
- **前端存储**: 浏览器 IndexedDB
- **API 密钥**: 用户自行管理，HTTPS 传输必需
- **认证**: 无

### T3: 商业部署 (Commercial)

- **服务器存储**: PostgreSQL（需配置 `DATABASE_URL`）
- **前端存储**: 无本地缓存，所有 CRUD 委托给服务器 API
- **API 密钥**: 平台 + 用户双层管理
- **认证**: 必需

```bash
# 启动方式
STORE_BACKEND=pg DATABASE_URL=postgresql://covel:pass@localhost:5432/covel pnpm dev:server
```

### 存储后端对比

| 能力 | Memory | SQLite | PostgreSQL |
|------|--------|--------|------------|
| 持久化 | 否 (重启丢失) | 是 (本地文件) | 是 (远程数据库) |
| 并发 | 单进程 | 单进程 | 多进程（`pg_advisory_lock` 实现 session 级跨进程串行化） |
| 适用场景 | 测试 / 一次性 demo | 单机部署（默认） | 生产环境 |
| 配置 | `STORE_BACKEND=memory` | 默认（`STORE_BACKEND=sqlite`，可显式指定） | `STORE_BACKEND=pg` + `DATABASE_URL` |

> **多进程部署 session 锁**：当 `STORE_BACKEND=pg` 时，服务器启动日志会输出 `session lock: pg-advisory`。每次 `/api/actions` / `/api/sessions/:id/turn` / `/api/sessions/:id/resume` 都会在专用 PG 连接上拿到 `pg_advisory_lock(hash(sessionId))`，确保同一 session 在任意时刻只有一个 Node 进程执行 turn。Memory / SQLite 后端使用进程内 `Map` 锁，足以覆盖单进程场景。

### 关键环境变量

完整 registry 见 [`docs/guide/env-registry.md`](../guide/env-registry.md)。

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `STORE_BACKEND` | 存储后端类型 | `sqlite` |
| `SQLITE_PATH` | SQLite 数据库路径 | `./data/covel.db` |
| `DATABASE_URL` | PostgreSQL 连接字符串 | - |
| `SERVER_PORT` | 服务器端口 | `3001` |
| `DEPLOYMENT_TIER` | 部署层级 | - |
| `CORS_ORIGIN` | CORS 允许的源 | - |
| `ENABLE_DEBUG_PAGE` | 启用调试页面 | - |
| `RATE_LIMIT_RPM` | 速率限制 (请求/分钟) | - |

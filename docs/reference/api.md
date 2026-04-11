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
| Memory | `memory` (默认) | 开发/测试，数据存于内存，重启丢失 |
| SQLite | `sqlite` | 单机部署，数据持久化到本地文件 |
| PostgreSQL | `pg` | 生产环境，需配置 `DATABASE_URL` |

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
    "plugins": ["core-pregame", "core-narrator", "core-codex"]
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
| PATCH | `/api/worlds/:id` | 部分更新世界（lore, tags, metadata 等） |
| GET | `/api/worlds/:id/dimensions/export` | 导出世界维度（YAML/JSON） |
| POST | `/api/worlds/:id/dimensions/import` | 导入世界维度 |
| POST | `/api/worlds/:id/sync-dimensions` | 将世界维度同步到活跃 session 的 plugin_data |

### 会话管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions` | 列出所有会话（可选 `?worldId=` 过滤） |
| POST | `/api/sessions` | 创建新会话 |
| GET | `/api/sessions/:id` | 获取会话信息 |
| PATCH | `/api/sessions/:id` | 更新会话字段（如 phase） |
| DELETE | `/api/sessions/:id` | 删除会话 |

### 会话快照

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/snapshot` | 获取完整会话快照（用于客户端恢复/重连） |

### Turn 执行

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/sessions/:id/turn` | 执行玩家回合 |
| GET | `/api/sessions/:id/results` | 获取最近一次 Turn 结果 |
| GET | `/api/sessions/:id/turns` | 获取 Turn 历史 |

### 玩家交互

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/sessions/:id/submit-inputs` | 提交玩家交互响应 |

### 会话插件管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/plugins` | 列出会话的活跃/可用插件 |
| POST | `/api/sessions/:id/plugins/enable` | 启用插件（body: `{ pluginId }`） |
| POST | `/api/sessions/:id/plugins/disable` | 禁用插件（body: `{ pluginId }`） |

### 全局插件

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/plugins` | 列出所有已加载插件 |
| GET | `/api/plugins/:id` | 获取插件详情 |

### 状态查询

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/state` | 获取所有状态表 |
| GET | `/api/sessions/:id/state/:table` | 获取指定状态表快照 |
| GET | `/api/sessions/:id/state/:table/:field/history` | 获取字段变更历史 |

### 消息历史

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/messages` | 获取会话消息列表 |
| POST | `/api/sessions/:id/messages/sync` | 同步消息（LocalDataService 用） |

### 插件数据（Plugin Data）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/sessions/:id/plugin-data/:pluginId/:namespace` | 列出某 namespace 下的数据 |
| GET | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 获取单条数据 |
| PUT | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 写入/更新数据 |
| DELETE | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 删除数据 |

### 角色数据

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

### 配置信息

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/presets` | 列出配置的模型预设 |
| GET | `/api/packages` | 列出已加载插件包（含 runtime/tool 信息） |
| GET | `/api/commands` | 列出注册的命令 |
| GET | `/api/block-schemas` | 列出插件 block schema |
| GET | `/api/ui-specs` | 列出插件 UI 声明（按 slot 分组：right/message/left） |
| GET | `/api/llm-config` | 返回 slot 配置与能力信息 |
| GET | `/api/provider-keys` | 返回服务器配置的 API 密钥（仅 T1） |

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

#### `POST /api/worlds/:id/sync-dimensions`

将世界最新维度数据同步到指定 session 的 plugin_data 中（覆盖旧数据）。

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
      "phase": "pre-game",
      "turnCount": 0,
      "locale": "zh-CN",
      "activePlugins": ["core-pregame", "core-narrator"],
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
  "plugins": ["core-pregame", "core-narrator", "core-codex"]
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
  "phase": "pre-game",
  "turnCount": 0,
  "activePlugins": ["core-pregame", "core-narrator", "core-codex"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

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
  "phase": "pre-game",
  "turnCount": 3,
  "locale": "zh-CN",
  "activePlugins": ["core-pregame", "core-narrator"],
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

更新会话字段（当前支持 `phase`）。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**请求体:**

```json
{
  "phase": "playing"
}
```

**响应 200:** 返回合并后的会话对象。

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
      "pluginId": "core-narrator",
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
- 如果某个 Runtime 的输出包含 `pendingInputs`，需要通过 `/submit-inputs` 提交玩家响应

#### `GET /api/sessions/:id/results`

获取最近一次 Turn 的执行结果。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**响应:**

```json
{
  "turnId": "a1b2c3d4-...",
  "sessionId": "cloudmere-a1b2c3d4",
  "runtimeResults": [...],
  "durationMs": 2500,
  "timestamp": "2025-01-15T10:05:00.000Z"
}
```

如果没有 Turn 记录，返回：

```json
{
  "results": []
}
```

#### `GET /api/sessions/:id/turns`

获取 Turn 历史记录。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**查询参数:**

| 参数 | 类型 | 说明 |
|------|------|------|
| `limit` | number | 返回最近 N 条记录（从末尾截取） |

**示例:**

```bash
# 获取最近 5 条 Turn
curl "http://localhost:3001/api/sessions/<sessionId>/turns?limit=5"
```

**响应:**

```json
{
  "turns": [
    {
      "turnId": "a1b2c3d4-...",
      "sessionId": "cloudmere-a1b2c3d4",
      "runtimeResults": [...],
      "durationMs": 2500,
      "timestamp": "2025-01-15T10:05:00.000Z"
    }
  ]
}
```

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
- 该文本会自动追加到对话历史中，供叙事者在下一轮 Turn 中参考
- 模板由插件提供，使用 `{{fieldName}}` 占位符语法
- 如果找不到模板，会生成一条简单的回退叙事（如 `[玩家输入] name: 艾尔文, class: 战士`）

---

### 插件管理

#### `GET /api/plugins`

列出所有已加载的插件。

**响应:**

```json
{
  "plugins": [
    {
      "id": "core-narrator",
      "name": "核心叙事者",
      "description": "主要叙事生成插件",
      "pluginType": "runtime",
      "runtimeCount": 1,
      "status": "loaded"
    },
    {
      "id": "core-combat",
      "name": "战斗系统",
      "description": "结构化回合制战斗",
      "pluginType": "runtime",
      "runtimeCount": 1,
      "status": "loaded"
    }
  ]
}
```

#### `GET /api/plugins/:id`

获取单个插件的详细信息。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 插件 ID（如 `core-narrator`） |

**响应 200:**

```json
{
  "id": "core-narrator",
  "name": "核心叙事者",
  "description": "主要叙事生成插件",
  "pluginType": "runtime",
  "runtimeCount": 1,
  "status": "loaded"
}
```

**响应 404:**

```json
{
  "error": "Plugin \"core-narrator\" not found"
}
```

---

### 会话插件管理

#### `GET /api/sessions/:id/plugins`

列出会话的活跃插件和所有可用插件。

**响应:**

```json
{
  "active": ["core-pregame", "core-narrator"],
  "available": [
    {
      "id": "core-narrator",
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
{ "pluginId": "core-codex" }
```

**响应:**

```json
{ "ok": true, "active": ["core-pregame", "core-narrator", "core-codex"] }
```

#### `POST /api/sessions/:id/plugins/disable`

禁用一个插件。

**请求体:**

```json
{ "pluginId": "core-codex" }
```

**响应:**

```json
{ "ok": true, "active": ["core-pregame", "core-narrator"] }
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

#### `GET /api/sessions/:id/state/:table`

获取指定状态表的快照。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |
| `table` | 路径 | 状态表名（如 `character_stats`） |

**响应 200:**

```json
{
  "table": "character_stats",
  "data": {
    "hp": 85,
    "mp": 42
  }
}
```

**响应 404:**

```json
{ "error": "Session not found: <id>" }     // 会话不存在
{ "error": "Table not found: <table>" }     // 表不存在
```

#### `GET /api/sessions/:id/state/:table/:field/history`

获取某个字段的变更历史记录。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |
| `table` | 路径 | 状态表名 |
| `field` | 路径 | 字段名 |

**响应 200:**

```json
{
  "table": "character_stats",
  "field": "hp",
  "history": [
    { "value": 100, "turnId": "t1", "timestamp": "2025-01-15T10:00:00.000Z" },
    { "value": 85, "turnId": "t2", "timestamp": "2025-01-15T10:05:00.000Z" }
  ]
}
```

**错误响应:**

```json
{ "error": "Session not found: <id>" }   // 404
{ "error": "Table not found: <table>" }  // 404
{ "error": "Field not found: <field>" }  // 404
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

#### `GET /api/sessions/:id/turn-messages`

获取会话的 Turn 级别消息列表。Turn 消息包含更细粒度的信息，如来源类型、Runtime 名称、排序等。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |

**响应:**

```json
{
  "items": [
    {
      "id": "tm-001",
      "sessionId": "cloudmere-a1b2c3d4",
      "turnId": "a1b2c3d4-...",
      "sourceType": "runtime",
      "role": "assistant",
      "name": "core-narrator",
      "content": "你发现自己站在一片广阔的草原上...",
      "order": 500,
      "createdAt": "2025-01-15T10:00:05.000Z"
    }
  ]
}
```

---

### 插件数据（Plugin Data）

插件的 session 级持久化 KV 存储。数据按 `(sessionId, pluginId, namespace, key)` 隔离。

#### `GET /api/sessions/:id/plugin-data/:pluginId/:namespace`

列出某插件某 namespace 下的所有数据条目。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | 路径 | 会话 ID |
| `pluginId` | 路径 | 插件 ID（如 `core-world-init`） |
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

### 角色数据

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

创建或更新一个角色（upsert 语义）。

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
  "targetRuntime": "core-combat"
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
| `phase.changed` | 会话生命周期 | 会话阶段变更 |
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
| 并发 | 单进程 | 单进程 | 多进程 |
| 适用场景 | 开发/测试 | 单机部署 | 生产环境 |
| 配置 | 默认 | `STORE_BACKEND=sqlite` | `STORE_BACKEND=pg` + `DATABASE_URL` |

### 关键环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `STORE_BACKEND` | 存储后端类型 | `memory` |
| `DATABASE_URL` | PostgreSQL 连接字符串 | - |
| `SERVER_PORT` | 服务器端口 | `3001` |
| `DEPLOYMENT_TIER` | 部署层级 | - |
| `CORS_ORIGIN` | CORS 允许的源 | - |
| `ENABLE_DEBUG_PAGE` | 启用调试页面 | - |
| `RATE_LIMIT_RPM` | 速率限制 (请求/分钟) | - |

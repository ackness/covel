# API 参考

Covel HTTP API 参考文档。通过这些端点，你可以在没有前端 UI 的情况下，仅通过 HTTP 请求完成一局完整的 AI RPG 游戏。

## 概览

- **基础 URL**: `http://localhost:3001/api/`
- **协议**: HTTP JSON API (Content-Type: `application/json`)
- **服务器框架**: [Hono](https://hono.dev/)

### 存储后端

服务器端常用三种存储后端，通过环境变量 `STORE_BACKEND` 配置：

| 后端       | 值              | 用途                                                                                                                     |
| ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| SQLite     | `sqlite` (默认) | 本机开发 / 单机部署，数据落到 `./data/covel.db`                                                                          |
| Memory     | `memory`        | 测试或一次性 demo，数据存于内存，重启丢失                                                                                |
| PostgreSQL | `pg`            | 生产环境，需配置 `DATABASE_URL`；**多实例部署自动启用 `pg_advisory_lock` 分布式会话锁，跨 Node 进程对同一 session 互斥** |

> **注意**: `@covel/store` 工厂也支持 `idb`，用于浏览器能力调用；常规服务器部署使用 `memory` / `sqlite` / `pg`。

### 错误响应约定（v0.0.5 统一）

所有 JSON 错误响应统一收敛为以下信封（`apps/server/src/api-error.ts`）：

```jsonc
{
  "error": "string", // 必有：人类可读的错误消息
  "code": "string", // 可选：稳定的机器可读错误码
  "details": {}, // 可选：结构化诊断（如 Zod 校验错误数组）
}
```

- `error` 字段始终存在。需要前端按错误码分流的端点（如 `plugin-rpc`、`media`）会同时给出 `code`。
- **会话锁竞争统一为 503**：任何路由等待该 session 的执行锁超时（PG 部署下默认 30s）都返回
  `503 { "error": "Session is busy, please retry", "code": "session_busy" }`，由全局
  `app.onError` 集中产生，不是各端点自行处理。这是可重试的竞争，不是服务端故障——一个后台
  媒体生成合法持锁数分钟期间，玩家的动作就会命中它，因此**不应**记为 5xx 故障。原始错误消息
  含 sessionId 与内部模块名，只进日志，不过线。
- **会话 404 统一**：所有以 `:id` 为路由参数的会话作用域端点，当会话不存在时统一返回
  `404 { "error": "Session not found: <id>", "code": "session_not_found" }`
  （由 `routes/api/session/session-guard.ts#resolveSessionParam` 集中产生）。
  这是 v0.0.5 的有意破坏性改动：此前各端点的 404 响应体形态不一（`{error:"Session not found"}` /
  `{error:"Session not found: <id>"}` / `{status:"error",error}` 等），现统一为上表形态。
  以 query 参数 `sessionId` 取会话的端点（`/api/events/subscribe`）与以 body `sessionId` 取会话的端点
  （`/api/actions`、`/api/worlds/:id/sync-data` 等）保持各自既有 404 文案不变。
- `plugin-rpc` 通道保留其专属信封 `{ status: "error", error, code }`（见下文 plugin-rpc 小节），不并入通用信封。

### 鉴权：Session owner token（audit S-02）

`POST /api/sessions` 创建会话时会铸造一个不可猜测的 **owner token**，仅在创建响应中返回一次（响应字段 `ownerToken`）；服务端只保存其 SHA-256 哈希（`session.metadata.ownerTokenHash`），任何读取端点都不会再泄露原始 token。

**分层强制（tiered enforcement）**：

| `DEPLOYMENT_TIER`     | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self`（默认）/ 桌面  | **不强制**。单机本地游玩零 token 可用；网络边界由默认回环监听保障（`COVEL_BIND_HOST=127.0.0.1`，见 env-registry）。带 token 也不校验。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `demo` / `commercial` | **硬性强制**。所有会话作用域端点（session CRUD、messages、traces、actions、plugin-rpc、steer/abort、SSE subscribe、snapshots、state 等经 `resolveSessionParam` 的路由，以及会话 id 走 query/body/间接引用的端点：approvals 列表/撤销/决策、`POST /api/media?sessionId=`、`/api/worlds/:id/world-data/preflight`、`sync-data`、`sync-dimensions`、`GET /api/ui-specs?sessionId=`）缺失或错误 token 一律返回 `401 { code: "session_owner_required" }`（未知会话返回 404）。无哈希的历史会话 fail-closed。`GET /api/sessions` 列表在这两个层级仅对持有运维 token 的调用方返回内容，其余返回空列表；`POST /api/sessions` **创建会话需运维 token**（缺失返回 `401 { code: "operator_token_required" }`）——这是单运维方门禁，完整的用户身份/租户隔离/配额属产品级工作，尚未实现。 |

**Token 提交方式**（三选一）：

1. `Authorization: Bearer <ownerToken>`
2. `X-Session-Token: <ownerToken>`
3. `?session_token=<ownerToken>` query 参数（供无法设置 header 的 EventSource / SSE 客户端使用）

**运维 master token**：设置了 `COVEL_DESKTOP_REST_TOKEN` 时，以该值作为 Bearer token 可通过任意会话的 owner 校验（管理工具 / e2e harness 用），并且是 hosted 层级创建会话、世界写入/维度导入、AI 世界生成、模型探测/刷新、provider key 可用性查询（`GET /api/provider-keys`）以及 community server-code 激活的凭证。community ESM 会在服务端进程内注册全局能力，因此 hosted 层级同时要求 owner token 与 operator token；这是当前单运维方信任模型，不提供多租户代码沙箱。`DEPLOYMENT_TIER=demo|commercial` 启动时若未配置该 token，`validateSecurityPosture` 会直接拒绝启动。

纯 Web 客户端可在 **Settings → Operator Access（运维访问）** 输入或清除该 token。凭据只保存在当前浏览器的 `localStorage`，仅在上述 operator-gated 同源请求中作为 `Authorization: Bearer <token>` 发送；保存或清除后客户端会重新加载，以新凭据重取会话与世界数据。`self` 层级继续允许无 token 使用，并忽略该可选凭据。

**community server-code grant 是 session 授权、进程级生效**：

审批本身按 `(sessionId, pluginId, action)` 记录，但它授权的动作是把插件的 server code `import()` 进 Node 进程。ESM 模块只加载一次，entry factory 也只跑一次（按 pluginId 记忆），所以第一个批准该插件的会话就把它注册的 tool / RPC handler / media wire 装进了**进程级**注册表——之后其他会话不必再批准即可看到这些注册项存在。

因此实际的边界分两层：

| 层面                                                | 作用域                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **代码加载 / 能力注册**                             | 进程级、一次性、不可撤销。任一会话批准即完成。                                                                                       |
| **调用（RPC dispatch / runtime 加载 / hook 执行）** | 每次仍按发起会话查 grant。未批准的会话拿不到 `covel:plugin-server-code`、`runtime:<name>` 校验，hook 也会被跳过（返回 `continue`）。 |

**revoke 边界**：`DELETE /api/sessions/:id/approvals`（以及禁用插件）按 `(session, plugin)` 前缀清除 session-cached 与一次性 grant，并取消待决审批。它**不会**卸载已导入的模块，也不会注销已注册的 tool / RPC handler / wire——JS 没有可靠的模块卸载。撤销之后该会话的后续 dispatch、runtime 加载和 hook 执行会重新被拒，但已经在进程内的代码要到重启才消失。进程重启则清空全部易失 grant（见 Snapshot / Fork 一节）。

单运维方模型下这是可接受的：批准 community 代码等同于信任它在本进程内运行。多租户隔离需要真正的代码沙箱，尚未实现。

> CORS（`CORS_ORIGIN`）只是浏览器策略，**不构成鉴权**；真正的授权边界是 owner token + 部署层级 + 回环监听。

---

## 快速开始

下面演示一个完整的纯 API 游戏流程：从启动服务器到完成多轮对话。

### 1. 启动服务器

```bash
# 安装依赖
pnpm install

# 启动开发服务器 (SQLite 默认后端, 端口 3001)
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
    "worldId": "mistport",
    "locale": "zh-CN",
    "plugins": ["pregame", "narrator", "codex"]
  }'
```

记下返回的 `id`（格式为 `{worldId}-{uuid8}`，如 `mistport-a1b2c3d4`），后续请求都需要它。

### 6. 开局（激活插件并跑 setup）

回合执行的唯一入口是 [`POST /api/actions`](#post-apiactions)——**没有** session 级的 `/turn` 端点。响应是 data-only SSE 流。

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-001",
    "type": "start_session",
    "sessionId": "<sessionId>",
    "locale": "zh-CN"
  }'
```

### 7. 执行第一个 Turn（玩家发言）

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-002",
    "type": "send_message",
    "sessionId": "<sessionId>",
    "locale": "zh-CN",
    "payload": { "content": "我环顾四周，观察这个陌生的世界" }
  }'
```

### 8. 查看游戏状态

```bash
# 查看状态表
curl http://localhost:3001/api/sessions/<sessionId>/state

# 查看角色列表
curl http://localhost:3001/api/sessions/<sessionId>/characters

# 查看消息历史
curl http://localhost:3001/api/sessions/<sessionId>/messages
```

### 9. 继续对话

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-003",
    "type": "send_message",
    "sessionId": "<sessionId>",
    "locale": "zh-CN",
    "payload": { "content": "走向远处的城镇" }
  }'
```

### 10. 提交玩家交互（如果 Turn 返回了 pendingInputs）

```bash
curl -X POST http://localhost:3001/api/sessions/<sessionId>/plugin-rpc \
  -H "Content-Type: application/json" \
  -d '{
    "pluginId": "framework",
    "action": "submit-form",
    "payload": {
      "turnId": "<turnId>",
      "submissions": [
        {
          "interactionId": "<interactionId>",
          "type": "choice",
          "values": { "selectedId": "option_1", "selectedLabel": "接受任务" }
        }
      ]
    }
  }'
```

### 11. 结束会话

```bash
curl -X DELETE http://localhost:3001/api/sessions/<sessionId>
```

---

## 端点列表

### 健康检查

| 方法 | 路径          | 描述     |
| ---- | ------------- | -------- |
| GET  | `/api/health` | 健康检查 |

### 世界管理

| 方法   | 路径                                   | 描述                                                                              |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------- |
| GET    | `/api/worlds`                          | 列出所有世界                                                                      |
| GET    | `/api/worlds/:id`                      | 获取世界详情                                                                      |
| POST   | `/api/worlds`                          | 创建/更新世界                                                                     |
| PATCH  | `/api/worlds/:id`                      | 部分更新世界（支持顶层 `dimensions`，并与现有 `metadata` 合并）                   |
| DELETE | `/api/worlds/:id`                      | 删除世界（内置 `source:"file"` 世界禁止删除，返回 403；hosted 需 operator token） |
| GET    | `/api/worlds/:id/dimensions/export`    | 导出世界维度（YAML/JSON）                                                         |
| POST   | `/api/worlds/:id/dimensions/import`    | 导入世界维度                                                                      |
| POST   | `/api/worlds/:id/sync-dimensions`      | 将世界维度同步到活跃 session 的 `plugin_data` 与 lorebook 常量词条，并清理旧 key  |
| POST   | `/api/worlds/:id/world-data/preflight` | 只读构建 worldData import plan，返回 diagnostics、planned count 和目标摘要        |
| POST   | `/api/worlds/:id/sync-data`            | 基于 provenance ledger 同步 importer 管理的 worldData row，支持 dry-run 与 force  |

### 会话管理

| 方法   | 路径                | 描述                                               |
| ------ | ------------------- | -------------------------------------------------- |
| GET    | `/api/sessions`     | 列出所有会话（可选 `?worldId=` 过滤）              |
| POST   | `/api/sessions`     | 创建新会话                                         |
| GET    | `/api/sessions/:id` | 获取会话信息                                       |
| PATCH  | `/api/sessions/:id` | 更新会话字段（`status` / `runtimeModelOverrides`） |
| DELETE | `/api/sessions/:id` | 删除会话                                           |

### 会话快照

| 方法 | 路径                         | 描述                                                                                                                           |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| GET  | `/api/sessions/:id/snapshot` | 获取会话快照（客户端恢复/重连）                                                                                                |
| GET  | `/api/sessions/:id/turns`    | 持久化 turn_results 执行工件列表（含 `commitStatus`/`origin`；`?limit=n` 上限 500）。为 e2e-plugin-verify harness 恢复的薄路由 |

> 快照的 `messages` 与 `executionSteps` 只含**最近窗口**（默认最新 80 条消息 / 600 条 trace 事件），不再全量加载（长会话每次重连都全量读是原性能热点）。快照带 `messagesCursor`（`{createdAt,id} | null`）；前端聊天界面向上滚动时用它调 `GET /api/sessions/:id/messages/page` 增量补更旧消息。窗口外旧 Turn 的执行时间线优雅降级（不渲染）。
>
> 快照内嵌的 session 对象里，`turnCount` / `preGameCompleted` 同 `GET`/`POST /api/sessions` 一样，是由调度时钟（`phase` / `completedPlayerTurns` / `setupRuntimes`）在读取时派生的兼容字段，不是内核直接写入的持久列——响应形状不变，见「会话管理」章节 `POST /api/sessions` 的响应字段说明。

### Turn 执行

回合执行的唯一入口是 [`POST /api/actions`](#post-apiactions)（SSE 桥接），没有 session 级的回合端点。

### 回合中控制（W4）

| 方法 | 路径                      | 描述                                                                                                                                |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/sessions/:id/steer` | 向进行中的回合插话。body `{ message: string }`。消息并入 story runtime 的下一次 LLM 调用并持久化到消息历史。无进行中回合返回 `409`  |
| POST | `/api/sessions/:id/abort` | 中止进行中的回合：立刻切断在途 LLM 流（绕过部分内容 salvage，不落任何半截提案），停止调度后续 runtime。无进行中回合返回 `409`。幂等 |

- abort 后当次 action SSE 的 `execution.completed` 载荷带 `abortReason: "aborted-by-player"`；已在 abort 前正常完成的 runtime 结果照常提交。
- steer 仅对 `outputKind: story` 的 runtime 生效（plugin runtime 执行结构化任务，不接受插话）。插话在最终响应流式期间到达时，story runtime 收尾前会追加一步 LLM 调用消化它（受 maxSteps 约束）；持久化失败则撤回队列项并返回 `500`。
- 注册表为进程内实现——多 pod（PG）部署下 steer/abort 只能到达同 pod 上的回合。
- 可控窗口与 session lock 对齐：注册发生在取得 session lock 之后、`executeTurn` 前，释放在 `executeTurn` 返回时——同 session 的并发 action 在锁上排队，steer/abort 永远命中真实在途的回合，不会指向排队中的下一回合；提案 commit / 后台 follower 调度等收尾阶段不再对外呈现为可控（此时 steer/abort 返回 `409`）。

### Setup runtime 控制（重试 / 跳过）

setup runtime 反复失败、耗尽重试预算（`maxTriggerCount`）后进入 `blocked`，会把会话钉在 setup 频段——该插件的其余 runtime 因隐式会话门被 `skipped: setup-incomplete`。以下两个端点是玩家把它解封的唯一手段（沿用 `resolveSessionParam` 的 owner-token 鉴权）：

| 方法 | 路径                                       | 描述                                                                                                                                                                            |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/sessions/:id/setup/:runtimeId/retry` | 把 `blocked` 的 setup runtime 复位为 `pending`：`generation+1`、`attempts=0`，下次执行重新跑一遍。返回 `{ ok, runtimeId, state }`                                               |
| POST | `/api/sessions/:id/setup/:runtimeId/waive` | 把 `blocked` 的 setup runtime 标记为 `done{resolution:"waived"}` 并附降级 `warning`，令其所属插件的会话门满足。body 必须为 `{ confirm: true }`。返回 `{ ok, runtimeId, state }` |

- `:runtimeId` 是完整 runtime id（`<pluginId>/<runtimeName>`，需 URL 编码）。
- 幂等：`retry` 对已 `pending` 的目标、`waive` 对已 `waived` 的目标均为无副作用的 `200`。
- 非 `blocked` 状态（如 `done{completed}` / `pending`）调用返回 `409`，并在 `error` 里说明只有 blocked 才能重试/跳过；`waive` 缺 `{ confirm: true }` 返回 `400 { code: "confirm_required" }`；未知会话返回 `404`。
- 两个端点都会在写入 `setupRuntimes` 的同时按新镜像重新派生 `preGameCompleted`（waived 进入该集合、retried 退出），使旧内核读取保持一致；`phase` 的翻转仍由下一回合的 finalize 事务负责。

### 玩家交互

| 方法   | 路径                                  | 描述                                                                                                        |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST   | `/api/sessions/:id/plugin-rpc`        | 统一插件 RPC 通道(action 级 / runtime 级，含 `submit-form`)                                                 |
| GET    | `/api/sessions/:id/approvals`         | **PR-7** 列出该 session 的待批准 RPC 请求                                                                   |
| DELETE | `/api/sessions/:id/approvals`         | **PR-7** 撤销该 session 的已缓存授权（`?pluginId=` 限定单插件），返回 `{ ok, cleared }`；下次调用重新弹审批 |
| POST   | `/api/approvals/:approvalId/decision` | **PR-7** 提交玩家批准决定(allow/deny + once/session)                                                        |

### 会话插件管理

| 方法 | 路径                                | 描述                                                   |
| ---- | ----------------------------------- | ------------------------------------------------------ |
| GET  | `/api/sessions/:id/plugins`         | 列出会话的活跃/可用插件                                |
| POST | `/api/sessions/:id/plugins/enable`  | 启用插件（body: `{ pluginId }`）                       |
| POST | `/api/sessions/:id/plugins/disable` | 禁用插件（body: `{ pluginId }`，core-plugin 返回 403） |

### 全局插件

| 方法   | 路径                          | 描述                                                                                                                                                                                                                                                    |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/framework/capabilities` | 框架级能力索引：manifest 枚举、工具、proposal、world-data URI                                                                                                                                                                                           |
| GET    | `/api/plugins`                | 列出所有已加载插件                                                                                                                                                                                                                                      |
| GET    | `/api/plugins/:id`            | 获取插件详情                                                                                                                                                                                                                                            |
| DELETE | `/api/plugins/:id`            | 卸载第三方插件（删除 `~/.covel/plugins/<id>`）。桌面端要求 bearer token；无 token 的生产部署要求 `COVEL_INSTALL_API_ENABLED=1`。错误码：鉴权失败 `401/403`、id 格式非法 `400`、内置 ID `409`、未安装 `404`；成功返回 `{ ok, id, restartRequired:true }` |
| GET    | `/api/plugins/:id/contract`   | 获取插件完整开发契约（含 `dataSchemas` / plugin-data namespace 契约）                                                                                                                                                                                   |
| GET    | `/api/plugin-flows`           | 框架编排的 pre-game 流程预览数据（插件列表 + 分段步骤），供准备页可视化                                                                                                                                                                                 |

### 拖拽导入（Install）

`.zip` 包拖拽导入插件/世界。鉴权同 `DELETE /api/plugins/:id`：桌面端要求 bearer token；无 token 的生产部署要求 `COVEL_INSTALL_API_ENABLED=1`。

| 方法 | 路径                  | 描述                                                                                                                                               |
| ---- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/install/plugin` | multipart 字段 `file`：接受根级 `PLUGIN.md`+`package.json` 或多 runtime 布局的 `.zip`，解压到用户插件目录，返回 `{ ok, id, restartRequired:true }` |
| POST | `/api/install/world`  | multipart 字段 `file`：接受根级 `world.yaml`+`WORLD.md` 的 `.zip`，解压到用户世界目录，返回 `{ ok, id, restartRequired:false }`                    |

> **canonical 插件身份（2026-07-20 审计 C-01）**：插件的唯一身份是 manifest 根 `name`（= 运行期 `pluginId`）。`package.json` basename 仅在剥离精确 `plugin-` 前缀后参与一致性校验（`@covel/plugin-foo` ↔ `name: foo`），不一致返回 400。reserved-builtin 检查、安装目录、返回的 `id` 全部使用 canonical ID——`@covel/plugin-narrator` + `name: narrator` 会命中 reserved 返回 409（旧实现只查未剥离的 npm basename，可被 scoped 包绕过冒充 builtin 身份）。启动 discovery 同样硬性校验目录名 == manifest 根 name，不一致的插件注册为 `status: "error"`、不加载任何 runtime/tool/hook/wire。

### 状态查询

| 方法 | 路径                               | 描述                                        |
| ---- | ---------------------------------- | ------------------------------------------- |
| GET  | `/api/sessions/:id/state`          | 获取所有状态表                              |
| GET  | `/api/sessions/:id/state-patches`  | 获取状态变更补丁列表                        |
| GET  | `/api/sessions/:id/state-snapshot` | 获取完整状态快照                            |
| PUT  | `/api/sessions/:id/state-snapshot` | **v0.0.5 未实现** —— 返回 `501`，见下方说明 |

> **`PUT /api/sessions/:id/state-snapshot`（v0.0.5 未实现）**：恢复状态快照需要 StateManager
> 重建状态表，当前状态模型未暴露该能力。路由有意保留（而非删除）以保持契约可见、不丢失排期，
> 当会话存在时返回
> `501 { "error": "State snapshot restoration not implemented. State will be rebuilt from turn execution.", "code": "not_implemented" }`
> ——返回 501 而非 200，以避免静默丢弃 POST 进来的状态。状态改为通过回合执行或
> `POST /api/sessions/:id/snapshots/:sid/fork`（从快照分叉）重建。

### 消息历史

| 方法 | 路径                              | 描述                                                        |
| ---- | --------------------------------- | ----------------------------------------------------------- |
| GET  | `/api/sessions/:id/messages`      | 获取会话完整消息列表（兜底 / 同步用；长会话优先用 `/page`） |
| GET  | `/api/sessions/:id/messages/page` | keyset 游标分页消息（最新窗口 + 向上加载更旧）              |
| POST | `/api/sessions/:id/messages/sync` | 同步消息（LocalDataService 用）                             |

### 统一翻译层（Runtime Outputs / Interaction Records，PR-1）

为跨 runtime 消费和观测接入而设计的规范记录。每次 runtime 执行产生一条 `RuntimeOutput`，每次外部输入（玩家消息、插件 UI、RPC 调用）产生一条 `InteractionRecord`。两张表与 `trace_events` 并存 —— 翻译层面向"被组件消费"，trace 层面向"调试时钻取细节"。

> **接入状态（2026-04-27）**：服务端写入和查询 API 已实现并有测试覆盖；当前内置 Web UI 暂未直接消费这些 HTTP 查询端点，debug 页面主要使用 `/api/traces/*` 与 `/api/sessions/:id/snapshot`。这些端点保留为 observability / API client 能力，不应因 UI 暂未接入而删除。

| 方法 | 路径                                                      | 描述                                                                                                                  |
| ---- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET  | `/api/sessions/:id/runtime-outputs`                       | 列出该 session 的 runtime 输出记录，支持 `?runtimeId=` / `?pluginId=` / `?since=` / `?limit=` 过滤，按 timestamp 降序 |
| GET  | `/api/sessions/:id/runtime-outputs/:outputId`             | 获取单条 runtime 输出记录                                                                                             |
| GET  | `/api/sessions/:id/runtime-outputs/:outputId/full-prompt` | 从 `turn_messages` 重建该次调用时的消息历史（best-effort，不含 system prompt 与注入段）                               |
| GET  | `/api/sessions/:id/interaction-records`                   | 列出该 session 的外部输入记录，支持 `?type=` / `?source=` / `?targetPluginId=` / `?limit=` 过滤                       |

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
- full-prompt 重建端点只回放 turn_messages,不含 system prompt 与注入段落,对 compaction 后的 session 也不完全精确 —— 粗略调试够用,精确重建与审计场景走 trace_events

### 插件数据（Plugin Data）

> **接入状态（2026-04-27）**：内置 Web UI 目前使用 GET/list 读取 plugin-data（右侧面板、message UI specs、plugin data store）。PUT/DELETE 是管理/API 写入口，当前内置 Web UI 暂未直接调用；插件 runtime 推荐通过 plugin-data tools、plugin RPC 或 proposal 写入。PUT/DELETE 保持兼容，但若未来收窄攻击面，应先标记 deprecated 或加 admin/debug gate，而不是静默删除。

| 方法   | 路径                                                      | 描述                      |
| ------ | --------------------------------------------------------- | ------------------------- |
| GET    | `/api/sessions/:id/plugin-data/:pluginId/:namespace`      | 列出某 namespace 下的数据 |
| GET    | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 获取单条数据              |
| PUT    | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 写入/更新数据             |
| DELETE | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 删除数据                  |

### Working Memory（工作记忆）

> **接入状态（2026-04-27）**：Working Memory 的 store / proposal / prompt injection 是运行时功能；下列 HTTP CRUD 是管理/调试接口，当前内置 Web UI 暂未直接消费。若未来收敛写路径，应保持 URL/响应兼容，优先替换内部实现而不是直接删除。

| 方法   | 路径                                           | 描述                                                                                                                   |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/sessions/:id/working-memory`             | 列出该 session 的所有工作记忆条目                                                                                      |
| PUT    | `/api/sessions/:id/working-memory/:scope/:key` | 写入/更新工作记忆（scope: player \| story \| shared）                                                                  |
| DELETE | `/api/sessions/:id/working-memory/:scope/:key` | 删除工作记忆条目                                                                                                       |
| GET    | `/api/sessions/:id/memory-blocks`              | 只读返回 Letta 风格的 memory blocks（story scope）。2026-04-27 从 `/:id/memory` 重命名以避免与 `memory` 插件 id 冲突。 |

### Lorebook（S3-T6）

Session 级 lorebook 词条的只读查看 + 启用/删除管理。Entries 由插件通过 proposal commit 管道写入 store 层的 `lorebook_entries` 表，这些端点提供玩家 UI 与程序化读取视图，**不走提案系统**（单项 toggle/删除为 MVP 级别的直接写入）。

| 方法   | 路径                                  | 描述                                                            |
| ------ | ------------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/sessions/:id/lorebook`          | 列出该 session 的所有 lorebook 词条（按 `insertionOrder` 升序） |
| PATCH  | `/api/sessions/:id/lorebook/:entryId` | 切换单条词条的 `enabled` 标志，body: `{ enabled: boolean }`     |
| DELETE | `/api/sessions/:id/lorebook/:entryId` | 删除单条词条                                                    |

响应：

- `GET` → `{ entries: LorebookEntryRecord[] }`（见 `packages/store/src/types.ts`）
- `PATCH` → `{ success: true, entryId, enabled }`
- `DELETE` → `{ success: true }`

404 场景：session 不存在、entryId 不存在。无 feature-flag 开关，始终启用。消费方：当前无内置 UI（右侧面板"世界"Tab 已切换为 WORLD.md 渲染，见 `docs/reference/ui-panels.md`）；插件可通过 `ui.right` JSON spec 自行消费这些端点。

### Suspend / Resume（S4-T4）

| 方法   | 路径                                          | 描述                                                   |
| ------ | --------------------------------------------- | ------------------------------------------------------ |
| POST   | `/api/sessions/:id/resume`                    | 用提交的 data 重新启动指定 suspensionId 对应的 runtime |
| GET    | `/api/sessions/:id/suspensions`               | 列出当前 session 所有未解决的挂起项                    |
| DELETE | `/api/sessions/:id/suspensions/:suspensionId` | 放弃一个挂起项（删除记录）                             |

### Snapshot / Fork（S4-T2）

> **接入状态（2026-04-27）**：服务端手动快照、列表和 fork 能力已实现并有测试覆盖；当前内置 Web UI 只直接使用 `GET /api/sessions/:id/snapshot` 做恢复/重连，暂未提供手动快照列表或 fork 操作界面。

| 方法 | 路径                                      | 描述                                                                                                  |
| ---- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| POST | `/api/sessions/:id/snapshot`              | 创建一份手动快照（kind=`manual`）                                                                     |
| GET  | `/api/sessions/:id/snapshots`             | 分页列出快照元数据（auto / manual / fork，不含 payload）                                              |
| GET  | `/api/sessions/:id/snapshots/:snapshotId` | 按 id 获取单个快照（含完整 payload）                                                                  |
| POST | `/api/sessions/:id/fork`                  | 从指定 snapshotId 物化一个新 session，拷贝状态与截至 cursor 的消息；响应一次性返回 child `ownerToken` |

Fork 不继承 community server-code grant；child 中对应插件保持未激活，需由 operator 在新 session 内重新 enable/approve。进程重启后同样不恢复易失 grant，`GET /api/sessions/:id/plugins` 会清理缺少当前 grant 的历史 active community 项。

### 角色数据

> **接入状态（2026-04-27）**：当前内置 Web UI 主要通过 `GET /api/sessions/:id/snapshot` 获取角色快照；本节 REST 端点保留为轻量读取/管理 API。插件 runtime 推荐使用 `create-character` / `update-character` / `list-characters` / `get-character` 工具维护角色。`POST /characters` 是兼容管理入口，后续若收敛角色写路径，应保持 URL/响应兼容并优先替换内部实现。

| 方法 | 路径                           | 描述             |
| ---- | ------------------------------ | ---------------- |
| GET  | `/api/sessions/:id/characters` | 获取会话角色列表 |
| POST | `/api/sessions/:id/characters` | 创建/更新角色    |

### Actions（SSE 桥接）

| 方法 | 路径           | 描述                                                       |
| ---- | -------------- | ---------------------------------------------------------- |
| POST | `/api/actions` | SSE 动作桥接（发送消息/执行命令 → Turn 执行 → SSE 事件流） |

### 事件系统

| 方法 | 路径                               | 描述                                    |
| ---- | ---------------------------------- | --------------------------------------- |
| GET  | `/api/events/stream?sessionId=xxx` | SSE 实时事件流（支持 topic 过滤和重放） |
| POST | `/api/events/emit`                 | 注入外部事件                            |

### AI 生成

| 方法 | 路径                     | 描述                                    |
| ---- | ------------------------ | --------------------------------------- |
| POST | `/api/ai/ping`           | 测试 LLM 提供商连通性                   |
| POST | `/api/ai/generate-world` | AI 生成世界包；hosted 需 operator token |

### 模型数据库（Model DB）

| 方法 | 路径                             | 描述                                     |
| ---- | -------------------------------- | ---------------------------------------- |
| GET  | `/api/model-db`                  | 获取模型数据库信息                       |
| GET  | `/api/model-db/search?q=xxx`     | 搜索模型                                 |
| GET  | `/api/model-db/lookup?model=xxx` | 查找模型能力                             |
| POST | `/api/model-db/refresh`          | 刷新模型数据库；hosted 需 operator token |

### Trace 调试

| 方法 | 路径                                | 描述                                           |
| ---- | ----------------------------------- | ---------------------------------------------- |
| GET  | `/api/traces/:sessionId`            | 获取会话所有 trace 事件（全量）                |
| GET  | `/api/traces/:sessionId/turns`      | 按 Turn 分组的 trace 事件（全量）              |
| GET  | `/api/traces/:sessionId/turns/page` | 最近事件窗口分组为 Turn + 游标（向上加载更旧） |

### 媒体管理

| 方法 | 路径                                | 描述                                                                                                                                                                                                                              |
| ---- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/api/media/:id?token=<signed>`     | 内容寻址媒体下载（HMAC token + 会话引用校验）                                                                                                                                                                                     |
| GET  | `/api/sessions/:id/media-token?id=` | 为指定 mediaId 颁发短时签名 token，供上面的下载端点使用                                                                                                                                                                           |
| POST | `/api/media?sessionId=<id>`         | 玩家图片上传：原始字节 body（`Content-Type` = 文件 MIME，仅 `image/*`，≤20MB），内容寻址入库 + 记会话 owner/ref，返回 `{ id, mime, size }`。**`image/svg+xml` 一律 400 拒绝**——SVG 是可执行内容类型，内联渲染时会在应用源执行脚本 |
| POST | `/api/media/cleanup`                | 破坏性维护端点：默认禁用 (`COVEL_MEDIA_CLEANUP_ENABLED`)，商业层 503，`dryRun:false` 需 `X-Confirm-Cleanup: yes`                                                                                                                  |

### 配置信息

| 方法 | 路径                           | 描述                                                                                                                                                                |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/api/presets`                 | 列出配置的模型预设                                                                                                                                                  |
| GET  | `/api/packages`                | 列出已加载插件包（含 runtime/tool/`userSettings`/`tags`/`relations` 信息）                                                                                          |
| GET  | `/api/ui-specs?sessionId=<id>` | 列出插件 UI 声明（按 slot 分组）；带 `sessionId` 时按会话激活集过滤，不带则返回全部插件                                                                             |
| GET  | `/api/llm-config`              | 返回 slot 配置与能力信息；llm.toml 解析失败回退默认时附带 `error` 字段                                                                                              |
| POST | `/api/llm-config/reload`       | 重读 llm.toml 并原地应用到运行中的 gateway（无需重启）；返回 `{ ok, slots, error? }`                                                                                |
| GET  | `/api/provider-keys`           | 桌面 bearer client 返回原始 provider key；其他请求返回 masked availability。`demo` / `commercial` 层**需运维 token**（已配置的 provider 清单与 key 掩码属运维信息） |
| GET  | `/api/config/info`             | 返回当前部署信息（`isDesktop`、`covelHome`、`dataRoot` 等）                                                                                                         |
| GET  | `/api/config/keys`             | 仅桌面：列出已配置的 provider（不返回值）                                                                                                                           |
| PUT  | `/api/config/keys`             | 仅桌面：写入 `<covelHome>/keys.env`；body `{ provider: value }`                                                                                                     |
| GET  | `/api/config/settings`         | 仅桌面：读取 `<covelHome>/settings.json`（unified SettingsStore）                                                                                                   |
| PUT  | `/api/config/settings`         | 仅桌面：原子写 `settings.json`；body `{ entries: Record<string, unknown> }`                                                                                         |
| PUT  | `/api/config/data-root`        | 仅桌面：改写 `config.toml` 的 `data_root` 行，需要重启服务器                                                                                                        |
| POST | `/api/config/open-folder`      | 仅桌面：打开 config/data/logs 目录或 `llm.toml` / `keys.env`                                                                                                        |

#### GET /api/ui-specs

返回插件的 UI 声明，按 slot 分组。前端在 boot 时调用，用于动态构建右侧面板 Tab 和消息区 block 渲染器。

**查询参数：**

| 参数        | 类型           | 说明                                                                       |
| ----------- | -------------- | -------------------------------------------------------------------------- |
| `sessionId` | string（可选） | 指定后只返回该会话激活集中的插件；省略时返回全局所有已加载插件（向后兼容） |

**响应格式**：

```json
{
  "right": [
    {
      "pluginId": "codex",
      "specs": [{
        "specVersion": 1,
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
  "left": [...],
  "diagnostics": []
}
```

每个 slot 包含一个数组，元素为 `{ pluginId, specs[] }`。`specs` 中每项是一个 json-render spec（从插件 `ui/*.json` 文件加载）。

**校验与 `specVersion`**：聚合时对每个 spec 执行 Zod 校验（结构包络 + `specVersion`）。`specVersion` 可省略（按 v1 处理），声明高于服务端支持版本（当前 `CURRENT_UI_SPEC_VERSION = 1`）会被拒绝。校验失败的 spec **不污染整个响应**——只从对应 slot 中剔除，并在顶层 `diagnostics[]` 中按 `{ pluginId, runtimeId, slot, specIndex, specId?, issues[{ path, message, code }] }` 给出具体诊断（哪个插件、哪个字段、什么问题）。带 `sessionId` 时 `diagnostics` 仅包含该会话激活集中的插件。

**缓存**：插件发现 + UI spec 加载/校验结果按插件目录布局缓存，失效信号为 `PLUGIN.md` 与 `ui/*` 文件的 mtime/size 内容签名（仅 `stat`，不读文件）。会话级 `plugin_data` 物化（delete + rewrite）只在签名变化或该会话首次访问时触发，避免每请求扫盘与 DB 重写。spec 文件变更后下次请求会正确重新物化。

### Runtime 调用

| 方法 | 路径                  | 描述                           |
| ---- | --------------------- | ------------------------------ |
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
  "bootId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2025-01-15T10:00:00.000Z",
  "storage": {
    "data": {
      "backend": "sqlite",
      "durable": true,
      "frontendMode": "remote"
    },
    "media": {
      "backend": "sqlite",
      "configuredBackend": "mirror",
      "enabled": true,
      "durable": true
    },
    "vector": {
      "backend": "embedded",
      "capable": true,
      "driver": "sqlite-vec",
      "modelCount": 0,
      "tableCount": 0
    },
    "migrations": [
      {
        "id": "browser:idb:unified-storage",
        "domain": "browser",
        "backend": "idb",
        "version": 11,
        "status": "managed-by-backend",
        "description": "Browser-local data, media, app-KV, and render cache share the covel-browser IndexedDB schema."
      }
    ]
  },
  "vector": {
    "capable": true,
    "driver": "sqlite-vec",
    "modelCount": 0,
    "tableCount": 0
  }
}
```

| 字段                                      | 说明                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bootId`                                  | 服务器启动 ID（UUID），每次重启变化，可用于检测服务器重启                                              |
| `storage.data.backend`                    | 当前服务端 DataStore 后端（`memory` / `sqlite` / `pg`）。默认 `sqlite`。                               |
| `storage.data.frontendMode`               | 前端数据模式：`local` 使用浏览器 IndexedDB；`remote` 使用服务端 API，由服务端 `STORE_BACKEND` 持久化。 |
| `storage.media`                           | 当前 MediaStore 的配置值、实际后端、启用状态和持久化状态。                                             |
| `storage.migrations`                      | 已注册迁移域、版本和状态；SQL 迁移由服务端迁移流程执行，IDB 迁移由浏览器数据库升级回调执行。           |
| `vector.capable`                          | 当前后端是否支持向量检索（受 store 类型 + 编译时 vector 扩展可用性影响）                               |
| `vector.driver`                           | `sqlite-vec` / `pgvector` / `in-memory` / `external` / `none`                                          |
| `vector.modelCount` / `vector.tableCount` | 已注册的 embedding 模型数量及对应物理表数量（每个模型一张表）                                          |

---

### 世界管理

#### `GET /api/worlds`

列出所有已加载的世界。世界数据从 `worlds/` 目录读取并缓存在 Store 中。

**响应:**

```json
{
  "items": [
    {
      "id": "mistport",
      "name": "云溟界",
      "description": "一个漂浮于云层之上的奇幻世界...",
      "locale": "zh-CN",
      "metadata": {
        "source": "file",
        "requiredPlugins": ["pregame", "world-init", "char-creator"],
        "recommendedPlugins": ["narrator", "guide"],
        "excludedPlugins": ["chat-mode-narrator"],
        "pluginPolicy": {
          "preset": "traditional-story",
          "preferTags": ["mode:traditional-story"],
          "avoidTags": ["mode:dialogue"]
        },
        "worldDataPath": "data/world.data.yaml",
        "worldData": {
          "schemaVersion": 1,
          "sources": [
            {
              "id": "dimensions",
              "target": "world:metadata.dimensions",
              "digest": "sha256:...",
              "order": 0,
              "origin": "world",
              "diagnostics": { "info": 0, "warning": 0, "error": 0 }
            }
          ]
        }
      },
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

#### `GET /api/worlds/:id`

获取单个世界的详细信息。

**参数:**

| 参数 | 位置 | 说明                     |
| ---- | ---- | ------------------------ |
| `id` | 路径 | 世界 ID（如 `mistport`） |

**响应 200:**

```json
{
  "id": "mistport",
  "name": "云溟界",
  "description": "一个漂浮于云层之上的奇幻世界...",
  "locale": "zh-CN",
  "metadata": {
    "source": "file",
    "dimensions": {},
    "requiredPlugins": ["pregame", "world-init", "char-creator"],
    "recommendedPlugins": ["narrator", "guide"],
    "excludedPlugins": ["chat-mode-narrator"],
    "pluginPolicy": {
      "preset": "traditional-story",
      "preferTags": ["mode:traditional-story"],
      "avoidTags": ["mode:dialogue"]
    },
    "worldDataPath": "data/world.data.yaml",
    "worldData": {
      "schemaVersion": 1,
      "sources": [
        {
          "id": "dimensions",
          "target": "world:metadata.dimensions",
          "digest": "sha256:...",
          "order": 0,
          "origin": "world",
          "diagnostics": { "info": 0, "warning": 0, "error": 0 }
        }
      ]
    }
  },
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

| 参数     | 位置 | 说明                    |
| -------- | ---- | ----------------------- |
| `id`     | 路径 | 世界 ID                 |
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
- 保持 `SessionContextSnapshot.world.entries` 下一轮读取到最新世界词条

**请求体:**

```json
{ "sessionId": "mistport-abcd1234" }
```

**响应:**

```json
{ "success": true, "syncedKeys": ["geography", "factions", ...], "entryCount": 9 }
```

#### `POST /api/worlds/:id/world-data/preflight`

只读预检 worldData 导入计划。请求可以传 `sessionId` 使用现有 session 的插件列表，也可以传 `plugins` 预检创建 session 前的插件选择。

**请求体:**

```json
{ "plugins": ["character-blueprint", "char-creator", "living-world-rules"] }
```

或：

```json
{ "sessionId": "haruka-academy-abcd1234" }
```

**响应:**

```json
{
  "imported": true,
  "planned": 12,
  "diagnostics": [],
  "targets": [
    {
      "kind": "plugin-data",
      "target": "plugin:character-blueprint/blueprints",
      "sourceId": "cast",
      "pluginId": "character-blueprint",
      "namespace": "blueprints",
      "key": "kamishiro-mio"
    }
  ]
}
```

#### `POST /api/worlds/:id/sync-data`

同步已有 session 中由 worldData importer 管理的数据。默认 dry-run；传 `dryRun:false` 才写入。同步只处理 `world_data_import_ledger.managed=true` 的 row，并用 `valueHash` 检测玩家或插件是否修改过目标数据。

**请求体:**

```json
{ "sessionId": "haruka-academy-abcd1234" }
```

执行写入：

```json
{ "sessionId": "haruka-academy-abcd1234", "dryRun": false }
```

强制覆盖冲突：

```json
{ "sessionId": "haruka-academy-abcd1234", "dryRun": false, "force": true }
```

**响应:**

```json
{
  "imported": true,
  "dryRun": true,
  "diagnostics": [],
  "planned": 12,
  "upserted": 2,
  "deleted": 1,
  "unchanged": 9,
  "conflicts": [
    {
      "target": "plugin:character-blueprint/blueprints",
      "key": "kamishiro-mio",
      "sourceId": "cast",
      "reason": "modified"
    }
  ]
}
```

---

### 会话管理

#### `GET /api/sessions`

列出所有游戏会话。支持 `?worldId=` 查询参数过滤。

> **隐私门禁**：当服务器以 `STORE_BACKEND=memory` 运行（前端处于 local/IndexedDB 模式，服务器端 session 只是回合执行的临时同步副本）且 `NODE_ENV=production` 且未设置 `ENABLE_DEBUG_PAGE` 时，本端点固定返回 `{ "items": [] }` —— 公网共享部署下防止玩家互相枚举 session。local 模式前端从不调用此端点（列表读浏览器 IDB），故对产品功能无影响。

**响应:**

```json
{
  "items": [
    {
      "id": "mistport-a1b2c3d4",
      "worldId": "mistport",
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
  "worldId": "mistport",
  "locale": "zh-CN",
  "plugins": ["pregame", "narrator", "codex"]
}
```

| 字段      | 类型     | 必填 | 说明                                                          |
| --------- | -------- | ---- | ------------------------------------------------------------- |
| `worldId` | string   | 否   | 关联的世界 ID（校验: `/^[a-z0-9_-]{1,64}$/i`）                |
| `locale`  | string   | 否   | 语言区域，默认 `zh-CN`                                        |
| `plugins` | string[] | 否   | 要激活的插件 ID 列表                                          |
| `id`      | string   | 否   | 客户端自定义会话 ID（如不提供则自动生成 `{worldId}-{uuid8}`） |

世界包字段会影响准备页和 session 初始化：

- `metadata.requiredPlugins`：准备页锁定启用。
- `metadata.recommendedPlugins`：准备页默认启用。
- `metadata.excludedPlugins`：准备页默认关闭。
- `metadata.pluginPolicy`：准备页组合包策略。可包含 `preset`、`preferTags`、`avoidTags`、`requireCapabilities`、`requiredPlugins`、`recommendedPlugins`、`excludedPlugins`、`packs`；写在 `metadata` 顶层的同名三组字段也会参与合并。
- `metadata.characterBlueprints`：创建 session 时自动导入到 `character-blueprint` 插件数据，并实例化为 NPC character。

**响应:**

```json
{
  "id": "mistport-a1b2c3d4",
  "worldId": "mistport",
  "locale": "zh-CN",
  "status": "active",
  "turnCount": 0,
  "preGameCompleted": [],
  "activePlugins": ["pregame", "narrator", "codex"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z",
  "metadata": { "ownerTokenHash": "<sha256-hex>" },
  "ownerToken": "e7b2c4d1-…"
}
```

**响应字段**:

- `ownerToken`(string) — 会话 owner token，**仅此一次返回**（服务端只存哈希）。`DEPLOYMENT_TIER=demo|commercial` 下所有会话作用域端点都要求携带它（见「鉴权」章节）；`self` 层级可忽略
- `status`(`'active' \| 'paused' \| 'ended'`) — 会话生命周期状态
- `turnCount`(number) — 主循环轮数计数（从 0 开始）。调度重构后**由时钟派生**：`phase="setup"` 时为 0，`phase="playing"` 时为 `max(1, completedPlayerTurns)`
- `preGameCompleted`(string[]) — 已完成 Pre-Game 初始化的 runtime id 集合（现由 `setupRuntimes` 中 `state="done"` 的条目派生并排序）
- `phase`(可选,`'setup' \| 'playing'`) — 调度重构新增的 setup/主循环频段真相字段（会话激活集含 setup runtime 时初始为 `setup`，否则 `playing`；全部 setup runtime 完成后翻转为 `playing`）。旧会话缺省，首次回合时惰性回填。前端暂未消费
- `completedPlayerTurns`(可选,number) — 已提交的主循环玩家逻辑回合数（setup 交互不计入）。由 finalize 事务内的 logical-turn ledger 幂等推进
- `setupRuntimes`(可选,`Record<runtimeId, SetupRuntimeState>`) — 每个 setup runtime 的解析状态镜像。`SetupRuntimeState` 为三态联合：`pending{ generation, attempts, lastError? }`（尚未完成，`attempts` 为当代次终态非 suspended 的 attempt-ledger 计数）· `done{ resolution:"completed"|"waived", generation, attempts, completedAt, warning? }`（已完成，`waived` 为玩家跳过的降级完成）· `blocked{ generation, attempts, reason, blockedAt }`（耗尽 `maxTriggerCount` 预算仍未完成，把会话钉在 setup 频段，需经 `retry`/`waive` 端点解封）。各态均带 `pluginVersion`；插件版本变化会使旧 `done` 失效并以 `generation+1` 重跑

> 三个新字段为**可选追加**，不破坏默认响应形状；`turnCount` / `preGameCompleted` 继续存在，仅改由上述三字段的公式派生。

> **Session ID 格式**: 自动生成的 ID 格式为 `{worldId}-{uuid8}`（如 `mistport-a1b2c3d4`），使用 `crypto.randomUUID()` 后缀防止枚举。如未提供 worldId 则前缀为 `session`。

#### `GET /api/sessions/:id`

获取会话的完整信息。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**响应 200:**

```json
{
  "id": "mistport-a1b2c3d4",
  "worldId": "mistport",
  "status": "active",
  "turnCount": 3,
  "preGameCompleted": [
    "pregame",
    "world-init/schema-gen",
    "char-creator/player-init"
  ],
  "locale": "zh-CN",
  "activePlugins": ["pregame", "narrator"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:05:00.000Z"
}
```

**响应 404:**

```json
{
  "error": "Session not found: <id>",
  "code": "session_not_found"
}
```

#### `PATCH /api/sessions/:id`

更新会话字段。当前支持 `status` 与 `runtimeModelOverrides`。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
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

- `status`(可选,`'active' \| 'paused' \| 'ended'`) — 会话生命周期状态。非合法枚举值返回 400。（注：运行频段真相由 `phase` / `completedPlayerTurns` / `setupRuntimes` 三字段承载，`turnCount` / `preGameCompleted` 由其派生——见 `POST /api/sessions` 响应字段说明；PATCH 不直接改写这些字段，它们只在 finalize 事务与惰性回填处写入。）
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

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
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
  "error": "Session not found: <id>",
  "code": "session_not_found"
}
```

---

### Turn 执行

Turn 是游戏的核心交互单元。每次玩家发言触发一个 Turn，服务器按 stage（`setup` / `pre-turn` / `narrative` / `post-turn` / `audit`，stage 间严格屏障，stage 内按 DAG 依赖并行）调度所有活跃的 Runtime，收集 LLM 输出并返回。

唯一入口是 [`POST /api/actions`](#post-apiactions)——请求体、SSE 帧格式与开场接力语义见该章节。

**回合语义：**

- 每个活跃 Runtime 按 stage 依次执行，stage 内独立 runtime 并行（依赖 `needs` / `after` / `inputs` 排序）
- `session.turnCount`（由 `phase` / `completedPlayerTurns` 读时派生的 legacy 字段）表示主循环进度：setup 阶段的执行会保存 `turn_results`，但不会计入主循环轮数；`phase` 翻到 `playing` 后最低读出 `1`
- 服务端对每个 runtimeResult 运行 `processRuntimeResult` 提交管道：normalize → state.commit → 触发后续 SessionEvent
- 如果某个 Runtime 的输出包含 `pendingInputs`，需要通过 `plugin-rpc` 的 `framework.submit-form` action 提交玩家响应

---

### 玩家交互

当 Turn 执行后产生 `pendingInputs`（如表单、选择题、确认框），玩家需要通过 `framework.submit-form` 提交响应。框架会将玩家输入转化为自然语言叙事，追加到对话历史中。若该响应完成最后一个 Pre-Game runtime，随后发起的 `/api/actions` `send_message` 会在同一个请求里完成 Pre-Game 并立即补跑已触发的主循环 runtime，因此同一个 `turnId` 可能同时包含 setup completion 和第一段正式叙事。

#### `POST /api/sessions/:id/plugin-rpc` (`framework.submit-form`)

提交一个或多个玩家交互响应。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**请求体:**

```json
{
  "pluginId": "framework",
  "action": "submit-form",
  "payload": {
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
}
```

| 字段                  | 类型         | 必填 | 说明                   |
| --------------------- | ------------ | ---- | ---------------------- |
| `pluginId`            | string       | 是   | 固定为 `"framework"`   |
| `action`              | string       | 是   | 固定为 `"submit-form"` |
| `payload.turnId`      | string       | 是   | 产生该交互的 Turn ID   |
| `payload.submissions` | Submission[] | 是   | 提交数组               |

**Submission 对象:**

| 字段            | 类型                                       | 说明                                      |
| --------------- | ------------------------------------------ | ----------------------------------------- |
| `interactionId` | string                                     | 交互 ID，来自 Turn 输出的 `pendingInputs` |
| `type`          | `"form"` \| `"choice"` \| `"confirmation"` | 交互类型                                  |
| `values`        | object                                     | 玩家输入的值                              |

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

**响应:**

```json
{
  "status": "ok",
  "result": {
    "results": [
      {
        "interactionId": "char-creation-form",
        "filledNarrative": "旅人自称艾尔文，是一名孤儿出身的流浪剑客，以战士之姿行走江湖。",
        "accepted": true
      }
    ],
    "accepted": true
  }
}
```

**错误响应:**

```json
{ "error": "turnId is required" }                           // 400
{ "error": "submissions[] is required" }                    // 400
{ "error": "Session not found: <id>", "code": "session_not_found" }  // 404
```

**使用说明:**

- `filledNarrative` 是将玩家输入填入模板后的**纯自然语言**文本，不含 JSON 结构
- 该文本作为玩家消息追加到对话历史，供叙事者在下一轮 Turn 中参考（**不再生成合成的 assistant-role 消息**）
- 模板由插件提供，使用 `{{fieldName}}` 占位符语法
- 如果找不到模板，会生成一条简单的回退叙事（如 `[玩家输入] name: 艾尔文, class: 战士`）
- **本地化**：`confirmation` 的 `{{confirmed}}` 取值（确认/取消）与回退叙事前缀（`[玩家输入]`/`[玩家选择]`/`[玩家确认]`/`[玩家取消]`）按**会话 locale** 解析——框架据 `session.locale` 把这些文案注入 handler（resolution order：请求 → 会话 → world → app 默认 `zh-CN`）。`en-US` 会产出 `Confirm`/`Cancel` 与 `[Player input]`/`[Player choice]`/`[Player confirmed]`/`[Player cancelled]`；未知 locale 回落 `zh-CN`（与历史输出逐字一致）。

---

### 插件 RPC 通道(PR-3)

#### `POST /api/sessions/:id/plugin-rpc`

统一的"结构化插件指令"通道。同时支持:

1. **Action 级**: `{ pluginId, action, payload }` — 调用插件在 PLUGIN.md `rpc` 字段中声明的 RPC handler,或框架默认 handler(如 `submit-form`)。返回单次 JSON。
2. **Runtime 级**: `{ pluginId, runtimeId, payload }` — 手动触发一次 runtime 执行。通过完整 Turn pipeline(prompt 组装、工具循环、proposal 提交)跑一次目标 runtime,事件触发的下游 runtime 会在回合内自动 chain(同一事件的多个订阅者按 `name` 定序)。执行子模式由 `manifest.execution` 决定:
   - `'sync'`(默认): 同步等待 runtime 完成,commit proposals 后返回汇总 JSON。
   - `'background'`: 立即返回 202 + `jobId`,后台通过 `setImmediate` 继续执行。进度/结果通过 `plugin_data` 表 `_jobs` 保留命名空间写回,前端经 `plugin-data.changed` SSE 感知变化。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**请求体:**

```json
{
  "pluginId": "framework",
  "action": "submit-form",
  "payload": {
    "turnId": "a1b2c3d4-...",
    "submissions": [
      {
        "interactionId": "char-form",
        "type": "form",
        "values": { "name": "艾尔文" }
      }
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

| 字段                        | 类型          | 说明                                                                                                                                                                                                  |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginId`                  | string        | 插件 ID(框架默认 handler 用 `framework` 占位即可)                                                                                                                                                     |
| `action`                    | string(可选)  | RPC action 名,kebab-case。与 `runtimeId` 互斥                                                                                                                                                         |
| `runtimeId`                 | string(可选)  | runtime 全名(如 `my-plugin/my-runtime`)。与 `action` 互斥                                                                                                                                             |
| `payload`                   | unknown       | handler 的输入数据 / agent runtime 的 manualPayload / function runtime 的 `ctx.manualPayload`                                                                                                         |
| `expectsBackgroundFollower` | boolean(可选) | runtime 级 sync 入口若只是生成 prompt 并预计触发后台 follower，可设为 `true`。框架会立即写入 `_jobs` 占位并返回 202，随后在后台执行入口 runtime 与 follower，避免 UI 等 prompt LLM 完成后才出现任务。 |

**解析顺序(action 级):**

1. 插件声明的 action(`manifest.rpc[action]`,通过 `pluginId` 命名空间隔离)
2. 框架默认 action(全局)——当前只注册了 `submit-form` 一个(`bootstrap/plugin-rpc-wiring.ts` 的 `registerFrameworkDefault`)

**框架默认 action:**

| Action        | 说明                                                   |
| ------------- | ------------------------------------------------------ |
| `submit-form` | 持久化玩家输入、找模板消息、按 `{{字段}}` 填充自然语言 |

**响应 200 — action 级:**

```json
{
  "status": "ok",
  "result": {/* 取决于 handler */}
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
      "output": {/* runtime final output (parsed envelope) */}
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
  "runtimeId": "dashscope-image-gen/image-generator",
  "phase": "prompt"
}
```

当请求体包含 `expectsBackgroundFollower: true` 时，sync prompt-builder 也会使用同样的 202 形态立即返回（响应中 `phase: "prompt"`）；此时 `_jobs/{jobId}` 先以 `phase: "prompt"` / `message: "Generating image prompt..."` 写入，prompt 完成并排入后续 background follower 后会更新为 `status: "done"` 且包含 `deferredJobs`。如果 prompt-builder 返回但**没有**触发任何 background follower，框架会把 `_jobs/{jobId}` 标记为 `status: "failed"` 并附带 `reason: "expected-background-follower-missing"`。

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
  owner?: string,                             // status=pending：写入该行的进程 id
  startedAt: ISO8601,
  completedAt?: ISO8601,
  durationMs?: number,
  runtimeResults?: RuntimeResultSummary[],   // status=done
  deferredJobs?: { jobId: string; runtimeId: string }[], // prompt-builder follower 队列
  phase?: "prompt" | string,
  message?: string,
  progress?: number,
  error?: string,                             // status=failed
  reason?: "expected-background-follower-missing" | "orphaned" | string, // status=failed 时的细分原因
  abortReason?: string
}
```

**崩溃恢复**：后台任务由进程内队列驱动，没有持久队列——进程在任务完成前退出，该行会永远停在
`pending`。开机扫描按 `owner` 回收：`owner` 不等于当前进程（含老版本写下的、根本没有 `owner`
的行）即判定为孤儿，立即置为 `status: "failed"` + `reason: "orphaned"`，并保留原 `payload` /
`triggerEvent` 供插件 UI 或玩家发起重试。框架**不自动重跑**——重跑会二次计费（图像 / 语音生成），
且请求级 `userSettings` 并未持久化在行上，重跑等于换参数重新扣费。

> 该判定假设**一个 store 对应一个服务进程**，对当前发布的所有部署形态（桌面、自部署）都成立。
> 多实例共享一个数据库时它并不安全：新启动的实例会把其它实例正在执行的行读成孤儿并立即失败。
> 上多实例前需要给 `owner` 配上租约（运行期续租的 `leaseExpiresAt`），判定改为"非本进程**且**已过期"。

每次写入都会通过 store-proxy 发出 `plugin-data.changed` SSE 事件(见 [protocol.md](./protocol.md)),前端据此刷新 loading / final UI。

**错误响应:**

| 状态码 | 触发条件                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `pluginId` 缺失 / `action` 与 `runtimeId` 同时设置或同时缺失 / `RpcValidationError` / `plugin-mismatch`(runtimeId 不属于 pluginId) |
| 404    | 会话不存在 / `unknown-action`(action 未注册) / `runtime-not-active`(runtimeId 未加载到该 session)                                  |
| 429    | `queue-full`(community trust 的待批准队列满)                                                                                       |
| 500    | handler 抛出未处理异常 / handler 模块加载失败 / `runtime-execution-failed` / `background-enqueue-failed` / `turn-commit-failed`    |

> 注意: background 模式下 runtime 内部异常 **不会**映射为 5xx HTTP 状态 —— 202 已经发出,失败信息写入 `_jobs/{jobId}.value.error`,前端通过 SSE 感知。

> **提交结果是权威判据**：runtime 可能返回 `success` 而其 proposal 提交失败。此时同步 RPC 返回 `500 turn-commit-failed`，background job 标记 `failed`（`error` 说明失败的 proposal 数量），且**不会**调度该回合的 deferred follower —— 后续 follower 不应建立在已回滚的状态上。主回合路径（`POST /api/actions`）遵循同一规则。

> **community 插件 + `entry` action 的延迟激活**：首次调用时 action 声明尚未注册，服务端先返回固定 `action: "covel:plugin-server-code"` 的全模块审批，避免由调用方伪造的 action label 诱导加载代码。session-scope 审批后加载 entry 并验证 action：不存在立即 404；存在则再返回该真实 action 的独立审批。客户端应处理这两个连续的 `approval-required` 响应，并为审批重试设置两阶段上限。hosted 层级两个步骤都要求 operator token。builtin/official 的 entry 在 boot 时已运行，其未知 action 直接 404。
>
> **community 插件的声明式 `manifest.rpc` action 同样两阶段**：dispatch 一个声明式 action 会动态 `import()` 该插件的 handler 模块，按同一定义它就是 server code。因此缺少 server-code grant 时，第一次调用先返回 `covel:plugin-server-code` 审批；批准后重试才返回该 action 自身的审批。builtin/official 声明式 action 不受影响（照旧自动放行）。
>
> **community 插件 + `runtimeId`（runtime 模式）同样两阶段（2026-07-20 审计 H-01）**：缺少 server-code grant 时第一次调用先返回 `covel:plugin-server-code` 审批；批准后重试返回 `runtime:<runtimeId>` 审批；两个**精确** grant 同时存在 runtime 才会加载执行（runtime loader 要求 AND，不再是任一 grant 即可）。entry import 也只认精确 `covel:plugin-server-code` grant——任意其他 action grant 不再解锁模块加载（`hasGrant` 已改为精确匹配、action 必填）。revoke 按 `(session, plugin)` 前缀清除两类 grant，语义不变。

**插件 PLUGIN.md 中声明 RPC action:**

```yaml
---
name: my-plugin
description: ...
rpc:
  regenerate:
    handler: ./rpc/regenerate.js
    input: ./rpc/regenerate.schema.json # 可选
    description: 重新生成上一次叙事
  cancel:
    handler: ./rpc/cancel.js
    trustLevel: builtin # 强制 builtin 信任
---
```

> Action 名不能以 `framework-` 开头(保留给框架默认 handler)。所有 action 名必须是 kebab-case。

> Handler 是 `default export` 函数,签名 `(payload, context) => Promise<unknown>`。`context` 至少包含 `{ sessionId, pluginId, action, store }`。模块在首次调用时按需 `import()`。

> RPC 分发一律同步返回。耗时工作走后台 job,进度经 `plugin-data.changed` SSE 推给前端(见 plugin-rpc 的 `mode: background`),没有流式 RPC 协议。

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

| 状态码 | 含义                                          |
| ------ | --------------------------------------------- |
| 202    | `community` 信任级别需要 approval。响应体见下 |

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
    "payload": {/* 原始 payload */},
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

| 字段       | 类型                    | 必需        | 说明                                                                                                                          |
| ---------- | ----------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `decision` | `"allow"` \| `"deny"`   | 是          | 玩家选择                                                                                                                      |
| `scope`    | `"once"` \| `"session"` | 仅 allow 时 | 普通 action 可选 `once`（默认）或 `session`；`covel:plugin-server-code` 与 `runtime:*` 会加载长生命周期模块，只接受 `session` |

**响应 200:**

```json
{
  "ok": true,
  "decision": "allow",
  "scope": "once",
  "pending": {/* 原始 pending 数据,已从队列移除 */}
}
```

**错误响应:**

| 状态码 | 触发条件                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 400    | `decision` 字段缺失 / 非 `allow` 或 `deny` / `scope` 非法 / server-code 或 runtime 使用非 session scope |
| 404    | `approvalId` 不存在或已被消费                                                                           |

#### `DELETE /api/sessions/:id/approvals`

撤销该 session 已缓存、一次性和未决的授权（community 插件 mid-session 收回）。可选 `?pluginId=<id>` 只撤销该插件的授权；省略则撤销整个 session 的全部授权。pending approval 按 `(session, plugin, action)` 去重；disable/冲突移除插件时也会撤销，旧 approvalId 无法在之后重新激活代码。

**查询参数:**

| 参数       | 必需 | 说明                                         |
| ---------- | ---- | -------------------------------------------- |
| `pluginId` | 否   | 限定撤销范围到单个插件；省略撤销整个 session |

**响应 200:**

```json
{ "ok": true, "cleared": 2 }
```

`cleared` 为清除的授权条目数（session-cached 与 one-time 授权合计）。

#### 信任等级与 approval 行为

| 信任等级    | 来源                        | Approval 行为                              |
| ----------- | --------------------------- | ------------------------------------------ |
| `builtin`   | 框架自带 / 框架默认 handler | 永远直接执行                               |
| `official`  | 维护团队白名单              | 永远直接执行                               |
| `community` | 第三方,默认级别             | 每次都需要玩家批准,除非 session-cache 命中 |

> One-time grant 的 TTL 为 60 秒。如果玩家批准后 60 秒内没有发起对应的 dispatch,grant 会过期,需要重新走 dialog 流程。

> Approval 状态是**进程内 + 内存**,服务器重启后所有 pending / cache 全部清空。如果跨重启的持久化变得必要,可以把 gate 的状态写入 `plugin_data`(见 `packages/approval/src/rpc-approval.ts` 内联说明)。

---

### 插件管理

#### `GET /api/framework/capabilities`

返回框架级 discovery 索引，供第三方开发者、外部工具和 AI Agent 程序化判断“Covel 当前支持哪些字段、URI、工具和事件”。它描述框架能力，不依赖某个具体插件。

**响应节选:**

```json
{
  "schemaVersion": 1,
  "framework": {
    "pluginManifest": {
      "triggerTypes": ["auto", "manual", "scheduled", "event"],
      "outputKinds": ["story", "plugin", "system"],
      "runtimeTypes": ["agent", "function"],
      "executionModes": ["sync", "background"],
      "inputInjectKinds": ["runtime", "plugin-data", "runtime-export"],
      "uiSlots": ["right", "message", "left"]
    },
    "pluginData": {
      "scope": "(sessionId, pluginId, namespace, key)",
      "reservedNamespaces": [
        "_jobs",
        "_logs",
        "__ui_right__",
        "__ui_message__"
      ],
      "writePaths": [
        "builtin-tool:plugin-data-set",
        "function-output:pluginData[]"
      ]
    },
    "worldData": {
      "targetUris": [
        "world:metadata.<path>",
        "plugin:<pluginId>/<namespace>",
        "plugin:<pluginId>/<namespace>+lorebook"
      ],
      "schemaUris": [
        "covel://world/dimensions",
        "plugin://<pluginId>/<namespace>",
        "<local-json-schema-path>"
      ]
    }
  }
}
```

> **`triggerTypes` 的取值范围**：schema 接受且生产可用的取值就是 `auto` / `manual` / `scheduled` / `event` 四种，`triggerTypes` 完整列出它们。详见 [reference/plugins.md → trigger 类型](./plugins.md#trigger-类型)。

#### `GET /api/plugins`

列出所有已加载的插件。`name` 与 `description` 是 `I18nText`（可能是字符串或 `{ "<locale>": "..." }` 字典）。`capabilities` 为该插件所有 runtime 声明的 capability 并集；`tags` 是玩家/作者筛选标签；`relations` 是目录关系元数据；`outputKind` 取首个 runtime 的输出类别（`story` / `plugin` / `system`）；`source` 是框架根据加载路径派定的信任层级（`builtin` / `official` / `community`）。

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
      "capabilities": ["narrative", "narrative-engine"],
      "tags": ["mode:traditional-story", "role:narrator", "cost:llm"],
      "relations": {
        "provides": ["narrative-engine"],
        "conflicts": ["chat-mode-narrator"]
      },
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
      "tags": ["role:image", "cost:llm"],
      "outputKind": "plugin"
    }
  ]
}
```

#### `GET /api/plugins/:id`

获取单个插件的详细信息。返回字段与列表项一致。

**参数:**

| 参数 | 位置 | 说明                     |
| ---- | ---- | ------------------------ |
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
  "capabilities": ["narrative", "narrative-engine"],
  "tags": ["mode:traditional-story", "role:narrator", "cost:llm"],
  "relations": {
    "provides": ["narrative-engine"],
    "conflicts": ["chat-mode-narrator"]
  },
  "outputKind": "story"
}
```

**响应 404:**

```json
{
  "error": "Plugin \"narrator\" not found"
}
```

#### `GET /api/plugins/:id/contract`

返回单个插件从 `PLUGIN.md` manifest 聚合出的开发契约。多 runtime 插件会把所有 runtime 合并为 plugin-level 视图，同时保留 `runtimes[]` 明细。该端点用于回答“这个插件声明了哪些 capabilities、工具、RPC action、UI slot、`dataSchemas` 和 plugin-data namespace”。

**响应节选:**

```json
{
  "id": "codex",
  "capabilities": [],
  "declaredPluginDataNamespaces": ["entries"],
  "dataSchemas": {
    "entries": {
      "namespace": "entries",
      "schemaVersion": 1,
      "acceptsWorldData": true,
      "schema": "./schemas/entries.schema.json"
    }
  },
  "tools": {
    "builtin": [],
    "local": [{ "runtimeId": "codex", "name": "unlock-codex-entries" }]
  },
  "ui": {
    "right": [{ "runtimeId": "codex", "path": "./ui/codex-panel.json" }],
    "message": [{ "runtimeId": "codex", "path": "./ui/codex-message.json" }],
    "left": []
  },
  "runtimes": [
    {
      "id": "codex",
      "runtimeType": "agent",
      "readablePluginDataNamespaces": ["entries"],
      "writablePluginDataNamespaces": ["entries"],
      "input": {
        "inject": [
          {
            "kind": "plugin-data",
            "namespace": "entries",
            "as": "<existing-entries>"
          }
        ]
      }
    }
  ]
}
```

`declaredPluginDataNamespaces` 来自 `dataSchemas` 和 `input.inject: plugin-data`。运行时动态 key（如 `entries/<entryId>`、`images/<turnId>`）不会在这里枚举；需要结合 schema、插件文档或 `_index` 端点查看当前 session 的实际 key。

---

### 会话插件管理

#### `GET /api/sessions/:id/plugins`

列出会话的活跃插件和所有可用插件。`available[]` 同样暴露插件 `capabilities`、`tags`、`relations`，供前端筛选和组合包状态说明使用。

**响应:**

```json
{
  "active": ["pregame", "narrator"],
  "available": [
    {
      "id": "narrator",
      "name": "核心叙事者",
      "description": "主要叙事生成插件",
      "pluginType": "core-plugin",
      "active": true,
      "capabilities": ["narrative", "narrative-engine"],
      "tags": ["mode:traditional-story", "role:narrator", "cost:llm"],
      "relations": {
        "provides": ["narrative-engine"],
        "conflicts": ["chat-mode-narrator"]
      }
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

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
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
  "error": "Session not found: <id>",
  "code": "session_not_found"
}
```

---

### 消息历史

#### `GET /api/sessions/:id/messages`

获取会话的**完整**消息列表（升序）。长会话优先用 `/page`；本端点保留给快照缺失兜底和批量同步。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**响应:** 扁平化消息对象的**数组**（`metadata.{turnId,runtimeId,kind,block}` 提升为顶层字段）。

```json
[
  {
    "id": "msg-001",
    "sessionId": "mistport-a1b2c3d4",
    "role": "user",
    "content": "我环顾四周",
    "turnId": "turn-1",
    "createdAt": "2025-01-15T10:00:00.000Z"
  }
]
```

#### `GET /api/sessions/:id/messages/page`

keyset（游标）分页消息，**按时间正序（oldest-first）**。不传游标返回最新窗口；传游标返回其之前（更旧）的一页 —— 聊天界面向上滚动时用它增量加载历史。

**参数:**

| 参数                | 位置 | 说明                                                           |
| ------------------- | ---- | -------------------------------------------------------------- |
| `id`                | 路径 | 会话 ID                                                        |
| `limit`             | 查询 | 每页条数，默认 80，上限 500                                    |
| `before_created_at` | 查询 | 游标：只返回早于此 `createdAt` 的消息（需与 `before_id` 成对） |
| `before_id`         | 查询 | 游标 tie-break：同 `createdAt` 时按 `id` 断序                  |

`(before_created_at, before_id)` 是 `(createdAt, id)` 元组游标，即使同毫秒也不漏不重（`messages` 表无单调 `order` 列，故 `id` 断序是必需的）。

**响应:**

```json
{
  "items": [
    {
      "id": "msg-041",
      "role": "user",
      "content": "…",
      "turnId": "turn-8",
      "createdAt": "…"
    }
  ],
  "nextCursor": { "createdAt": "2025-01-15T10:00:00.000Z", "id": "msg-041" }
}
```

`nextCursor` 指向本页最旧一条的位置，作为下一页（更旧）的 `before_*`；当返回条数少于 `limit`（已到历史开头）时为 `null`。

---

### 插件数据（Plugin Data）

插件的 session 级持久化 KV 存储。数据按 `(sessionId, pluginId, namespace, key)` 隔离。

> **接入状态（2026-04-27）**：内置 Web UI 目前使用 GET/list 读取 plugin-data（右侧面板、message UI specs、plugin data store）。PUT/DELETE 是管理/API 写入口，当前内置 Web UI 暂未直接调用；插件 runtime 推荐通过 plugin-data tools、plugin RPC 或 proposal 写入。PUT/DELETE 保持兼容，但若未来收窄攻击面，应先标记 deprecated 或加 admin/debug gate，而不是静默删除。

#### `GET /api/sessions/:id/plugin-data/:pluginId/:namespace`

列出某插件某 namespace 下的所有数据条目。

**参数:**

| 参数        | 位置 | 说明                                   |
| ----------- | ---- | -------------------------------------- |
| `id`        | 路径 | 会话 ID                                |
| `pluginId`  | 路径 | 插件 ID（如 `world-init`）             |
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

#### `GET /api/sessions/:id/plugin-data/:pluginId/_index`

列出某 session 下某插件已经存在的 plugin-data namespace 和 key，不返回 `value`。这个端点用于调试、AI Agent 自动发现当前 session 数据形态、或 UI 构建轻量索引。

**响应:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "pluginId": "codex",
  "namespaces": [
    {
      "namespace": "entries",
      "count": 2,
      "latestUpdatedAt": "2026-05-07T10:00:00.000Z",
      "keys": [
        {
          "key": "codex-001",
          "createdAt": "...",
          "updatedAt": "...",
          "valueType": "object"
        },
        {
          "key": "codex-002",
          "createdAt": "...",
          "updatedAt": "...",
          "valueType": "object"
        }
      ]
    }
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

**存储配额**：与 `working_memory.set` commit handler 共用同一份配额定义（`packages/shared/src/utils/working-memory-quota.ts`）：单条 value 序列化后上限 8000 字符（超限返回 `413`，`code: "value-too-large"`）；单 session 上限 200 条（达到上限后新 key 返回 `409`，`code: "entries-exhausted"`，**已存在的 key 仍可更新**）。

#### `DELETE /api/sessions/:id/working-memory/:scope/:key`

删除工作记忆条目。

**响应:**

```json
{ "success": true }
```

---

### Suspend / Resume（S4-T4）

> **过期清理（S4-T4.c）**：`POST /api/sessions/:id/resume` 与 `GET /api/sessions/:id/suspensions` 在处理前会机会式触发一次**时间门控**（最多每小时一次）、**best-effort**、**全局**的过期挂起项清理 —— 删除 `resolvedAt` 未设置且 `createdAt` 早于 `now - COVEL_SUSPENSION_TTL_MS`（默认 7 天）的记录。清理是 fire-and-forget，**不阻塞**本次响应。此外服务**启动时**会执行一次强制 sweep，清掉停机期间堆积的陈旧记录。**claimed（恢复进行中，`resolvedAt = "claimed:<iso>"`）与已成功解决的记录永不被清理。** 设 `COVEL_SUSPENSION_TTL_MS=0` 关闭清理。详见 [`docs/guide/env-registry.md`](../guide/env-registry.md)。

#### `POST /api/sessions/:id/resume`

用玩家提交的数据重新启动一个被 `suspend` 工具暂停的 runtime。
请求**必须**带 `X-Provider-Keys` header（API key 不在服务端持久化，每次 resume 都要重新提供）。

**请求体:**

```json
{
  "suspensionId": "susp_abc123",
  "data": {/* shape 必须匹配 suspension.resumeSchema */}
}
```

服务器会用 `suspension.resumeSchema` 对 `data` 做完整 JSON Schema 校验（经 Ajv：enum、嵌套对象、min/max、minLength/maxLength、pattern、array items、oneOf/anyOf 等）；不匹配返回 `400`。

**响应:**

```json
{ "result": <ResumeResult>, "events": [ /* 本次 resume 产生的事件 */ ] }
```

**错误码:**

| 状态  | 触发条件                                                                      |
| ----- | ----------------------------------------------------------------------------- |
| `400` | 缺少 `X-Provider-Keys`、JSON body 错误、`suspensionId` 缺失或 schema 校验失败 |
| `404` | session、suspension 不存在，或 runtime manifest 找不到                        |
| `409` | suspension 已 resolved（含并发 claim 竞争的失败方）                           |
| `500` | `resumeSuspendedRuntime()` 抛出错误                                           |

#### `GET /api/sessions/:id/suspensions`

列出指定 session 当前所有挂起项，按 `createdAt asc` 排序。

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
      "resumeSchema": {
        "type": "object",
        "required": ["choice"],
        "properties": { "choice": { "type": "string" } }
      },
      "pendingContinuation": {/* runtime-internal serialized state */},
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

> **接入状态（2026-04-27）**：服务端手动快照、列表和 fork 能力已实现并有测试覆盖；当前内置 Web UI 只直接使用 `GET /api/sessions/:id/snapshot` 做恢复/重连，暂未提供手动快照列表或 fork 操作界面。

物化快照是存档 / 读档 / 时间线分叉的核心 —— 每个快照把一个回合结束时的完整 session 状态序列化为 `payload`，保存在 `state_snapshots` 表。`kind` 取三种值：`auto`（按 checkpoint 节奏自动写入：`turnCount <= 1` 与每 `COVEL_SNAPSHOT_INTERVAL_TURNS`（默认 5）回合各写一份；resume 路径强制写入）、`manual`（`POST /snapshot` 显式创建）、`fork`（`POST /fork` 写到子 session 上记录来源）。

#### `POST /api/sessions/:id/snapshot`

从当前 session 状态物化一份 `kind="manual"` 的快照。payload 包含 session 生命周期/运行配置（status、turnCount、preGameCompleted、locale、activePlugins、presetId、runtimeModelOverrides）、characters、stateEntries、pluginData、workingMemory、lorebookEntries、suspensions（未解决的挂起项）以及 messagesCursor（最后一条 `turn_message.id`）。读取和保存全程持有该 session 的执行锁，因此不会捕获正在提交回合的混合状态。PG 部署下若锁被一个执行中的回合持有超过获取超时（30s），返回 `503 { code: 'session_busy' }`，应稍后重试。payload 里的 `turnCount` / `preGameCompleted` 同样是物化时由 `phase` / `completedPlayerTurns` / `setupRuntimes` 派生写入，不是内核维护的独立持久列。

**响应:**

```json
{
  "snapshot": {
    "id": "<uuid>",
    "sessionId": "mistport-a1b2c3d4",
    "turnId": "turn-42",
    "kind": "manual",
    "payload": {
      "schemaVersion": 2,
      "turnId": "turn-42",
      "session": {
        "status": "active",
        "turnCount": 42,
        "preGameCompleted": ["world-init"],
        "locale": "zh-CN",
        "activePlugins": ["world-init", "narrator"],
        "presetId": "default",
        "runtimeModelOverrides": { "narrator": "balance" }
      },
      "characters": [/* ... */],
      "stateEntries": [/* ... */],
      "pluginData": [/* ... */],
      "workingMemory": [/* ... */],
      "lorebookEntries": [],
      "suspensions": [/* 未解决的 SuspensionRecord[] */],
      "messagesCursor": "tm_abc"
    },
    "createdAt": "2026-04-13T00:00:00.000Z"
  }
}
```

返回 `201 Created`；session 不存在时返回 `404`。

#### `GET /api/sessions/:id/snapshots`

列出指定 session 的快照元数据（`auto` / `manual` / `fork`），**keyset（游标）分页**，与 `/messages/page`、traces 分页同一约定。**不返回 `payload`**（快照 payload 序列化整个 session 状态，全量返回会无界增长）；store 层用投影查询计算 `payloadSize` 且从不加载 payload JSON，需要完整 payload 时按 id 单独获取（见下）。

Query 参数：`limit`（默认 50，最大 500）、`before_created_at` + `before_id`（`(createdAt, id)` 元组游标，需成对出现；只提供一半将被忽略并回落到最新窗口）。无游标返回最新一批；带游标返回紧邻更旧的一页。页内按 `createdAt` 升序（最旧在前）。

```json
{
  "snapshots": [
    {
      "id": "<uuid>",
      "sessionId": "mistport-a1b2c3d4",
      "turnId": "turn-42",
      "kind": "manual",
      "parentId": null,
      "createdAt": "2026-04-13T00:00:00.000Z",
      "payloadSize": 18342
    }
  ],
  "nextCursor": { "createdAt": "2026-04-13T00:00:00.000Z", "id": "<uuid>" }
}
```

`nextCursor` 指向本页最旧一条快照的 `(createdAt, id)` 位置，作为下一页（更旧）的 `before_*`；返回条数少于 `limit`（已到最早一份）时为 `null`。session 不存在时返回 `404`。`kind="fork"` 的快照 `parentId` 指向源 snapshot id，其余 kind 为 `null`。

#### `GET /api/sessions/:id/snapshots/:snapshotId`

按 id 获取单个快照（含完整 `payload`），响应 `{ "snapshot": SnapshotRecord }`。快照不存在或不属于该 session 时返回 `404`。

#### `POST /api/sessions/:id/fork`

基于指定 snapshot 物化一个新的 session。请求体：

```json
{ "fromSnapshotId": "<snapshot-uuid>" }
```

服务端会：

1. 创建新 sessionId（`{worldId}-{uuid8}`）；
2. 从 schema v2 snapshot payload 恢复 locale / activePlugins / status / turnCount / preGameCompleted / presetId / runtimeModelOverrides；历史 schema v1 快照缺少这些字段，读取时降级（upgrade-on-read）为父 session 的**当前**生命周期字段（即 v2 之前的 fork 行为）。快照中 `status: 'ended'` 会被钳制为 `paused`——ended 是终态且没有取消结束的 API，fork 的目的就是继续游玩；
3. **拷贝** characters / state entries / plugin data / working memory / state schemas / unresolved suspensions 到新 session；
4. 从 `turn_messages` 中按顺序拷贝消息直到 `payload.messagesCursor`（含），超过 cursor 的消息不拷贝。cursor 在父 session 中已丢失（compact / 删除等）时返回 `409 { code: 'cursor_missing' }`；
5. 写入一个 `kind="fork"` 的快照到子 session，`parentId` 指向源 snapshot，供 provenance 追踪；
6. 在 eventBus 上广播 `session.forked`（SSE topic=`session`）。

**响应:**

```json
{
  "sessionId": "mistport-<new-uuid8>",
  "parentSessionId": "mistport-a1b2c3d4",
  "fromSnapshotId": "<parent-snapshot-id>",
  "forkSnapshotId": "<child-fork-snapshot-id>"
}
```

返回 `201 Created`；快照不属于该 session、快照不存在、或父 session 不存在均返回 `404`；`fromSnapshotId` 缺失返回 `400`；`payload.messagesCursor` 指向的消息已不在父 session 中返回 `409 { code: 'cursor_missing' }`；内部写入失败返回 `500`。

整个 fork 在父 session 执行锁内读取来源数据，并在 `withTransaction` 下写入；中途任何失败都会 rollback，不会留下半成品子 session。与手动快照一样，PG 部署下锁获取超时返回 `503 { code: 'session_busy' }`。

---

### 角色数据

> **接入状态（2026-04-27）**：当前内置 Web UI 主要通过 `GET /api/sessions/:id/snapshot` 获取角色快照；本节 REST 端点保留为轻量读取/管理 API。插件 runtime 推荐使用 `create-character` / `update-character` / `list-characters` / `get-character` 工具维护角色。`POST /characters` 是兼容管理入口，后续若收敛角色写路径，应保持 URL/响应兼容并优先替换内部实现。

#### `GET /api/sessions/:id/characters`

获取会话中的所有角色。角色在游戏过程中动态创建和演化。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**响应:**

```json
{
  "items": [
    {
      "id": "char-001",
      "sessionId": "mistport-a1b2c3d4",
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

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
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

| 字段          | 类型   | 必填 | 说明                           |
| ------------- | ------ | ---- | ------------------------------ |
| `id`          | string | 是   | 角色 ID                        |
| `name`        | string | 是   | 角色名称                       |
| `type`        | string | 是   | 角色类型（如 `player`, `npc`） |
| `description` | string | 否   | 角色描述                       |
| `fields`      | object | 否   | 自定义属性（JSON）             |
| `version`     | number | 是   | 版本号                         |

**响应:**

```json
{
  "id": "char-001",
  "sessionId": "mistport-a1b2c3d4",
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

| 参数          | 类型   | 必填 | 说明                                        |
| ------------- | ------ | ---- | ------------------------------------------- |
| `sessionId`   | string | 是   | 会话 ID                                     |
| `topics`      | string | 否   | 逗号分隔的 topic 过滤（如 `runtime,state`） |
| `lastEventId` | string | 否   | 从此 ID 之后重放事件（用于断线重连）        |

**示例:**

```bash
curl -N "http://localhost:3001/api/events/stream?sessionId=<sessionId>"
```

**SSE 事件格式:**

连接成功后收到的第一条消息：

```
event: system.connected
data: {"sessionId":"mistport-a1b2c3d4","timestamp":"2025-01-15T10:00:00.000Z"}
```

后续事件。命名事件头就是 `CovelEventType` 本身（`deriveSseEventName` 原样返回 `event.type`，不做任何改写），完整清单见 [protocol.md](./protocol.md)：

```
event: execution.completed
data: {"runtimeCount":4,"resultCount":4,"durationMs":2500}
id: evt-001

event: state.changed
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
  "sessionId": "mistport-a1b2c3d4",
  "targetRuntime": "combat"
}
```

| 字段            | 类型   | 必填 | 说明                   |
| --------------- | ------ | ---- | ---------------------- |
| `topic`         | string | 是   | 事件主题               |
| `payload`       | object | 否   | 事件负载数据           |
| `sessionId`     | string | 是   | 目标会话 ID            |
| `targetRuntime` | string | 否   | 指定接收事件的 Runtime |

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
  "sessionId": "mistport-a1b2c3d4",
  "locale": "zh-CN",
  "payload": {
    "content": "我拔出剑，准备迎战"
  }
}
```

支持的 `type`：`send_message` · `execute_command` · `start_session` · `retry_runtime`。

| `payload` 字段 | 适用 `type`       | 说明                                                                                     |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `content`      | `send_message`    | 玩家自然语言输入。`actions.ts` 优先读取此字段。                                          |
| `command`      | `execute_command` | 以 `/` 开头的命令（如 `/look`），与 `content` 互斥。                                     |
| `runtimeId`    | `retry_runtime`   | 可选。收窄重跑到指定 runtime（走 manual-trigger 路径）；缺省保持整回合重跑语义（M-07）。 |

**`start_session` 的前置条件**：会话必须已有非空 `activePlugins`。插件集合由会话创建时决定（显式 `plugins` 数组，或世界 manifest 播种的推荐集），`start_session` 只负责在注册表里激活它们。空集合会被 **400** 拒绝（`Session has no active plugins. …`），而不是回退到"激活全部已注册插件"——那个回退会把玩家从未选择的社区插件、以及互斥的两个叙事引擎同时拉进会话，并持久化到会话生命周期结束。

**开场接力（opening continuation）**：当一次玩家动作（`send_message` / `execute_command` / `start_session`）完成了**最后一个** setup runtime（setup 执行独立提交，phase 翻转到 `playing`），同一个请求会在同一条 SSE 流上**自动接力一个主循环回合**（全新的 `turnId`、独立事务，读取刚提交的 setup 状态），让叙事 runtime 直接产出开场叙事——玩家提交完开局表单后无需再手动发一条消息。接力回合是第一个计数的玩家回合（`completedPlayerTurns` 0 → 1）。整条流仍只发**一个** `execution.completed`（取接力回合的数据）。守卫：`retry_runtime` 不接力；执行被中止（`abortReason`）、提交失败、或 setup 仍有未完成项（还有后续开局交互）时不接力。

> 玩家输入字段是 `payload.content`（`send_message`）/ `payload.command`（`execute_command`），没有别的别名。插件侧发事件请用 builtin `emit-event` 工具；未列出的 `type` 一律 400。

**请求头（可选）:**

| Header                   | 说明                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Provider-Keys`        | base64(JSON) 的 provider API key，不入库、每次请求携带。                                                                                                                                                                                                                                                                                                                             |
| `X-Plugin-User-Settings` | base64(JSON) 的玩家 per-plugin 设置 `{ [pluginId]: { [settingKey]: value } }`，只发玩家显式改过的值。`actions.ts` 解码后与世界默认 `WorldRecord.metadata.pluginSettings` 合并（玩家覆盖优先），注入 `TurnInput.userSettings`，再经 `resolveUserSettings` 用 manifest 默认补齐缺失 key。这让玩家在设置里调的插件配置真正进入主回合循环（此前仅 `plugin-rpc` 手动路径读取该 header）。 |

**响应:** SSE 事件流，使用 **data-only** SSE 帧（无 `event:` 命名头），每条 `data:` 是一个 `SseEnvelope` 对象（不是 `ProtocolEvent`）：

```ts
interface SseEnvelope {
  type: string; // 事件子类型，参见下方「SSE 协议」
  requestId: string; // 请求关联 ID（来自请求体）
  traceId: string; // 本回合的 trace ID
  sessionId: string;
  turnId?: string; // 开场接力时同一条流会先后出现两个 turnId（setup 回合 + 接力回合）
  flowId: string; // 等于 traceId
  seq: number; // 该流内自增
  timestamp: string;
  payload: Record<string, unknown>;
}
```

客户端用 `fetch()` + `ReadableStream` 解析（见 `apps/web/src/services/api/actions.ts: sendAction`），不能用 `EventSource.addEventListener('<type>', …)` —— 因为帧没有命名 event 头。`/api/events/stream` 才使用命名事件。

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

AI 生成世界包。LLM 自主决定世界的所有细节（id、name、tags、dimensions、lore）。服务器会把模型输出的 `dimensions` 写入 `data/dimensions.yaml`，生成 `data/world.data.yaml` descriptor，并在 `world.yaml` 中写入 `worldData: data/world.data.yaml`。

这个接口使用 SSE 返回进度和最终世界。客户端通过 `fetch()` + `ReadableStream` 解析 `data: {...}\n\n` 帧。

**请求体:**

```json
{
  "concept": "一个被永恒暴风雪笼罩的冰封大陆",
  "locale": "zh-CN",
  "model": "deepseek-chat",
  "saveTarget": "server-file"
}
```

| 字段         | 类型   | 必填 | 说明                                                  |
| ------------ | ------ | ---- | ----------------------------------------------------- |
| `concept`    | string | 是   | 世界概念描述（最多 4000 字符）。也接受同义键 `prompt` |
| `locale`     | string | 否   | 语言区域，默认 `zh-CN`                                |
| `model`      | string | 否   | 覆盖 LLM 模型                                         |
| `saveTarget` | string | 否   | 保存目标，默认 `server-file`。可选值见下表            |

| `saveTarget`   | 保存位置                              | 持久性来源                     | 适用场景                                                       |
| -------------- | ------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `server-file`  | 服务端 `COVEL_USER_WORLDS_DIR` 世界包 | 服务端文件系统                 | Electron、本机开发、可信私有服务                               |
| `server-store` | 服务端 `DataStore.upsertWorld()`      | `STORE_BACKEND=sqlite` 或 `pg` | 自部署 Web 服务希望复用服务端数据库，并避免长期保留世界包文件  |
| `return-only`  | SSE 响应体                            | 调用方自行保存                 | 浏览器本地 IndexedDB、预览生成结果、公开服务避免写服务端持久层 |

`server-store` 和 `return-only` 会先把世界包写入临时目录做校验，然后删除临时目录。因为当前 `worldData` 文件导入依赖包内相对路径，这两个模式保存的 `WorldRecord.metadata` 会移除 `worldDataPath`、`worldData` 和 `dimensionSources`，保留已经归一化到 `metadata.dimensions` 的世界维度数据。

响应里的 `world.metadata.storage` 标注真实保存位置：

```json
{
  "scope": "server",
  "backend": "pg",
  "durable": true
}
```

Web 前端根据 `/api/health.storage.data.frontendMode` 选择生成世界保存目标。`local` 模式使用 `saveTarget: "return-only"`，然后通过 `packages/store` 的 IndexedDB `DataStore.upsertWorld()` 保存到用户浏览器，并把 `world.metadata.storage` 标注为 `{ "scope": "browser", "backend": "indexeddb", "durable": true }`。`remote` 模式使用 `saveTarget: "server-store"`，并通过服务端 `packages/store` 后端持久化。缺少 `frontendMode` 时使用 `server-file`。

**响应 200:** SSE 帧。

```text
data: {"type":"progress","phase":"generating"}

data: {"type":"progress","phase":"validating"}

data: {"type":"progress","phase":"saving"}

data: {"type":"done","world":{"id":"frost-continent","name":"冰封大陆","metadata":{"storage":{"scope":"server","backend":"file","durable":true}}}}
```

**响应 422:** `{ "error": "World generation failed", "details": [...] }`

**响应 400:** `{ "error": "concept (string) is required" }` 或 `{ "error": "saveTarget must be \"server-file\", \"server-store\", or \"return-only\"" }`

---

### Trace 调试

#### `GET /api/traces/:sessionId`

获取会话的所有 trace 事件。

**响应:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "count": 42,
  "discovery": {
    /* plugin/runtime discovery snapshot for this session (buildSessionDiscoverySnapshot) */
  },
  "events": [
    {
      "type": "runtime.started",
      "requestId": "",
      "traceId": "8f1c2d3e-…",
      "sessionId": "mistport-a1b2c3d4",
      "turnId": "turn-001",
      "flowId": "8f1c2d3e-…",
      "seq": 0,
      "timestamp": "2025-01-15T10:00:00.000Z",
      "payload": {}
    }
  ]
}
```

- `discovery` — top-level plugin/runtime discovery snapshot (same shape the
  `/debug` page consumes); present on both trace endpoints.
- `flowId` equals `traceId` for the event (protocol.md `flowId = traceId`).
- `requestId` is reserved and currently emitted as `""` (no per-turn request id
  is threaded yet).

#### `GET /api/traces/:sessionId/turns`

按 Turn 分组的 trace 事件。

**响应:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "turnCount": 3,
  "discovery": {
    /* plugin/runtime discovery snapshot (same as /api/traces/:sessionId) */
  },
  "turns": [
    {
      "turnId": "turn-001",
      "flowId": "8f1c2d3e-…",
      "traceId": "8f1c2d3e-…",
      "startedAt": "2025-01-15T10:00:00.000Z",
      "completedAt": "2025-01-15T10:00:05.000Z",
      "eventCount": 12,
      "events": [...]
    }
  ]
}
```

#### `GET /api/traces/:sessionId/turns/page`

只把**最近一段事件窗口**分组为 Turn 返回，供 debug 时间线增量加载 —— `trace_events` 是增长最快的表，全量 `/turns` 在长会话上会把整表读进内存。

**参数:**

| 参数                | 位置 | 说明                                                  |
| ------------------- | ---- | ----------------------------------------------------- |
| `sessionId`         | 路径 | 会话 ID                                               |
| `limit`             | 查询 | 每页**事件**数（非 Turn 数），默认 400，上限 500      |
| `before_created_at` | 查询 | 游标：只返回早于此位置的事件（需与 `before_id` 成对） |
| `before_id`         | 查询 | 游标 tie-break                                        |

分页单位是**事件**：一个 Turn 可能跨窗口边界被切开，前端加载更旧一页后按 `turnId` 合并边界 Turn。`nextCursor` 指向窗口内最旧**事件**的 `(createdAt, id)`。

**响应:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "turns": [
    { "turnId": "turn-008", "startedAt": "…", "completedAt": "…", "eventCount": 6, "events": [...] }
  ],
  "nextCursor": { "createdAt": "2025-01-15T10:03:00.000Z", "id": "evt-1042" },
  "discovery": {
    /* 与 /turns 相同 */
  }
}
```

`nextCursor` 为 `null` 时表示窗口已到 trace 起点。

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

| 条件                                                        | 行为                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COVEL_MEDIA_CLEANUP_ENABLED` 未设为 truthy（`true` / `1`） | 403 `{ "error": "cleanup endpoint disabled", "code": "forbidden" }`                                                                               |
| `DEPLOYMENT_TIER=commercial`                                | 503 `{ "error": "cleanup endpoint not available in this deployment tier", "code": "unavailable" }` — 在管理员鉴权中间件就绪前永远不在商业部署可用 |
| `dryRun:false` 且无 `X-Confirm-Cleanup: yes` 请求头         | 400 `{ "error": "confirmation header missing: …", "code": "invalid_request" }`                                                                    |
| 同一时刻第二次并发请求                                      | 429 `{ "error": "Operation already in progress" }` (singleFlight)                                                                                 |
| 任一会话的扫描行数超过 `scanLimit`（默认 1000）             | 400 `{ "error": "scan limit exceeded for session …", "code": "limit_exceeded" }`                                                                  |

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

Covel 有两条独立的 SSE 流，**信封格式和帧格式都不同**：

| 端点                     | 帧形态                                     | 信封                                                            | 客户端                                                            | 说明                                                          |
| ------------------------ | ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `POST /api/actions`      | data-only（`data: {...}`，无 `event:` 头） | `SseEnvelope`（带 `requestId/traceId/flowId/seq`）              | `fetch()` + `ReadableStream`（`api.ts:sendAction`）               | 回合内主流：narrative / runtime lifecycle / 工具调用 trace 等 |
| `GET /api/events/stream` | 命名事件（`event: <type>\ndata: {...}`）   | `ProtocolEvent`（带 `id/source`），并由 server 经 EventBus 广播 | `EventSource` + `addEventListener('<type>')`（`subscription.ts`） | 回合外辅助通道：跨 session 通知 / 持久订阅 / 重连补放         |

> 关键差异：`/api/actions` 使用 data-only 帧，前端**无法**通过 `EventSource.addEventListener` 订阅；`/api/events/stream` 才是命名事件。

### 事件类型枚举（`CovelEventType`）

完整定义见 `packages/shared/src/types/protocol.ts`。所有 server→client 事件已收口为单一 discriminated union `CovelEvent`；`ProtocolEventType` 现为 `CovelEvent['type']` 的历史别名（保留向后兼容）。事件是否转发到 `/api/actions` 流由 `COVEL_EVENT_META[type].forwardToActionStream` 决定，转发白名单 `FORWARDED_EVENT_TYPES` 完全从该元数据派生。完整分类表见 [protocol.md § 一、事件类型](./protocol.md#一事件类型covelevent)。

| 类型                       | 分类         | 说明                                                                                            |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `narrative.delta`          | 叙事         | 叙事文本增量（逐 token 流式）                                                                   |
| `narrative.completed`      | 叙事         | 叙事文本完成                                                                                    |
| `interaction.requested`    | 交互         | 请求玩家输入（表单/选择/确认）                                                                  |
| `interaction.completed`    | 交互         | 玩家交互完成                                                                                    |
| `ui.rendered`              | UI           | `ui.render` proposal commit 后发出                                                              |
| `ui.part.update`           | UI           | UI part 状态更新（每个 part 一条）                                                              |
| `state.changed`            | 状态         | 游戏状态变更                                                                                    |
| `state.snapshot`           | 状态         | 状态快照                                                                                        |
| `state.snapshot.created`   | 状态         | 自动 / 手动 / fork 写入 snapshot 后发出                                                         |
| `session.forked`           | 会话         | `POST /api/sessions/:id/fork` 物化子 session 后发出                                             |
| `execution.started`        | 执行生命周期 | Turn 执行开始                                                                                   |
| `runtime.started`          | 执行生命周期 | 单个 Runtime 开始执行                                                                           |
| `runtime.completed`        | 执行生命周期 | 单个 Runtime 执行完成                                                                           |
| `runtime.failed`           | 执行生命周期 | Runtime 执行失败                                                                                |
| `execution.completed`      | 执行生命周期 | Turn 执行完成                                                                                   |
| `record.updated`           | 会话生命周期 | 记录更新（角色、任务等）                                                                        |
| `event.emitted`            | 会话生命周期 | 事件发射                                                                                        |
| `asset.progress`           | 资产         | 多模态生成进度（`0..100`）                                                                      |
| `asset.generated`          | 资产         | `asset.generate` proposal commit 后发出                                                         |
| `world.dimensions.changed` | 世界         | 世界维度文件变更（热更新）                                                                      |
| `plugin-data.changed`      | 插件数据     | `plugin-data-set` / DELETE / batch 等所有写路径                                                 |
| `turn.suspended`           | 流程控制     | `suspend()` 工具序列化 pendingContinuation                                                      |
| `turn.resumed`             | 流程控制     | `POST /api/sessions/:id/resume` 重启 runtime                                                    |
| `working_memory.changed`   | 流程控制     | `working_memory.set` proposal commit 后直接写入 `/api/actions`（commit-direct，不经转发白名单） |
| `proposal.failed`          | 流程控制     | 单条 proposal 提交失败——显式上报而非静默丢弃，由提交方直接写入 action stream                    |
| `job-status.updated`       | 流程控制     | 后台 function runtime 经 `ctx.progress` 汇报进度（append-only job 通道，转发到 action stream）  |
| `context.pruned`           | 系统         | prompt 装配超出 slot 预算、历史被硬裁剪；仅 trace（`/debug` 用），不进 action stream            |
| `error.occurred`           | 系统         | 执行错误                                                                                        |
| `connection.restored`      | 系统         | 连接恢复                                                                                        |

### 转发的运行时内部事件（已纳入 `CovelEventType`）

下列事件已是 `CovelEvent` union 的正式成员（不再是「未进 enum 的私有事件」），并在 `COVEL_EVENT_META` 中标记是否 `forwardToActionStream`。前端穷尽校验强制处理或显式忽略每一种：

| 事件                                                                   | 来源                              | 转发到 `/api/actions` | 说明                                                                    |
| ---------------------------------------------------------------------- | --------------------------------- | :-------------------: | ----------------------------------------------------------------------- |
| `runtime.skipped`                                                      | `actions.ts`                      |          否           | runtime 因 cooldown / startTurn / maxTriggerCount 跳过                  |
| `character.upserted`                                                   | `session-commit-emitter.ts`       |          是           | `character.upsert` proposal commit 后发出（与 `record.updated` 平行）   |
| `tool.calling` / `tool.completed` / `tool.failed`                      | TurnEmitter                       |          是           | 工具调用 trace（debug timeline 用）                                     |
| `llm.calling` / `llm.responded` / `message.completed`                  | TurnEmitter                       |          是           | LLM 调用 trace                                                          |
| `block.emitted` / `state.patch.applied`                                | TurnEmitter                       |          是           | 块发出 / state patch 应用 trace                                         |
| `hook.fired` / `hook.rewrote` / `hook.aborted`                         | TurnEmitter                       |          是           | Hook 行为 trace                                                         |
| `gateway.calling` / `gateway.responded` / `gateway.failed`             | TurnEmitter（`withGatewayTrace`） |          是           | function-runtime `ctx.gateway` provider 调用 trace（与 `llm.*` 对等）   |
| `function.executing` / `function.completed`                            | TurnEmitter                       |          否           | function-runtime handler 边界 trace，仅经订阅通道 / `trace_events`      |
| `recursive.calling` / `recursive.completed` / `recursive.failed`       | TurnEmitter                       |          否           | 递归 runtime trace，仅经订阅通道（topic `trace`）                       |
| `utils.fetch.calling` / `utils.fetch.responded` / `utils.fetch.failed` | `withUtilsTrace`                  |          否           | 插件自带 wire 的 provider HTTP 调用 trace（`ctx.utils.fetchWithRetry`） |

详见 [protocol.md § 转发的运行时内部事件](./protocol.md#转发的运行时内部事件apiactions-转发已纳入-covelevent)。

### 信封格式

```typescript
// /api/actions data-only 帧每条 data: 的形态
interface SseEnvelope {
  type: string; // 见上方两张事件表（CovelEventType 的成员）
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId?: string;
  flowId: string; // = traceId
  seq: number; // 该流内自增
  timestamp: string;
  payload: Record<string, unknown>;
}

// /api/events/stream 命名事件帧的 data 形态
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

Covel 支持三种部署层级 (Deployment Tier)，每种层级使用不同的存储策略。浏览器模式可切换：`local` 保存到用户浏览器 IndexedDB，`remote` 通过服务端 API 保存到 `STORE_BACKEND` 指定的后端。

### T1: 自部署 (Self-Deploy)

- **服务器存储**: SQLite（默认，`./data/covel.db`）；可显式切换 Memory（仅用于一次性测试）
- **前端存储**: 默认 remote 使用服务端 SQLite；local 模式使用浏览器 IndexedDB
- **数据流**: remote 模式下前端通过 API 读写服务端 store；local 模式下业务记录持久保存在浏览器 `covel-browser` IndexedDB 中，并在执行 turn 前通过 `syncToServer()` 向本地服务器补齐临时执行上下文；生成世界等服务器能力通过 `return-only` 响应交给前端保存
- **API 密钥**: 用户自行管理，存储在浏览器 localStorage
- **认证**: 无

```bash
# 启动方式
pnpm dev:server                       # SQLite 后端（默认）
STORE_BACKEND=memory pnpm dev:server  # 临时 Memory 后端（重启即丢失）
```

### T2: 演示托管 (Demo Host)

- **服务器存储**: Memory 或 SQLite
- **前端存储**: 演示公开写入可用 local IndexedDB；私有演示也可用 remote 服务端存储
- **API 密钥**: 用户自行管理，HTTPS 传输必需
- **认证**: **必需**——会话作用域端点强制 session owner token，全局/管理端点强制 operator token（`COVEL_DESKTOP_REST_TOKEN`）；缺 token 时 `validateSecurityPosture` 直接拒绝启动。详见上方[鉴权章节](#鉴权session-owner-tokenaudit-s-02)

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

| 能力     | Memory                 | SQLite                                     | PostgreSQL                                               |
| -------- | ---------------------- | ------------------------------------------ | -------------------------------------------------------- |
| 持久化   | 否 (重启丢失)          | 是 (本地文件)                              | 是 (远程数据库)                                          |
| 并发     | 单进程                 | 单进程                                     | 多进程（`pg_advisory_lock` 实现 session 级跨进程串行化） |
| 适用场景 | 测试 / 一次性 demo     | 单机部署（默认）                           | 生产环境                                                 |
| 配置     | `STORE_BACKEND=memory` | 默认（`STORE_BACKEND=sqlite`，可显式指定） | `STORE_BACKEND=pg` + `DATABASE_URL`                      |

> **多进程部署 session 锁**：当 `STORE_BACKEND=pg` 时，服务器启动日志会输出 `session lock: pg-advisory`。每次 `/api/actions` / `/api/sessions/:id/resume` 都会在专用 PG 连接上拿到 `pg_advisory_lock(hash(sessionId))`，确保同一 session 在任意时刻只有一个 Node 进程执行 turn。Memory / SQLite 后端使用进程内 `Map` 锁，足以覆盖单进程场景。

### 关键环境变量

完整 registry 见 [`docs/guide/env-registry.md`](../guide/env-registry.md)。

| 变量                | 说明                  | 默认值            |
| ------------------- | --------------------- | ----------------- |
| `STORE_BACKEND`     | 存储后端类型          | `sqlite`          |
| `SQLITE_PATH`       | SQLite 数据库路径     | `./data/covel.db` |
| `DATABASE_URL`      | PostgreSQL 连接字符串 | -                 |
| `SERVER_PORT`       | 服务器端口            | `3001`            |
| `DEPLOYMENT_TIER`   | 部署层级              | -                 |
| `CORS_ORIGIN`       | CORS 允许的源         | -                 |
| `ENABLE_DEBUG_PAGE` | 启用调试页面          | -                 |
| `RATE_LIMIT_RPM`    | 速率限制 (请求/分钟)  | -                 |

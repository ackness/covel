# HTTP API

Covel 的服务器对外只有一套 HTTP JSON 接口。网页和桌面应用用的就是它，所以你不开界面，只发 HTTP 请求，也能玩完一整局。

这一页列出全部端点、请求字段、响应和错误码。写脚本、做自己的客户端、排查某个请求为什么失败时来查它。第一次用，先照[快速开始](#快速开始)跑一遍。

**在本机怎么调用**

- 地址：`pnpm dev:server` 启动后是 `http://localhost:3001/api/`。
- 请求体：JSON，带 `Content-Type: application/json`。
- 鉴权：本机默认不需要任何 token。只有托管部署（`DEPLOYMENT_TIER=demo` 或 `commercial`）才要带会话的 owner token 或运维 token，见[鉴权：Session owner token](#鉴权session-owner-token)。
- 回合不是普通的请求-响应：发消息、开局、提交选择都走 `POST /api/actions`，响应是一条 SSE 流。

**这一页怎么组织**

| 部分                                                      | 内容                                          |
| --------------------------------------------------------- | --------------------------------------------- |
| [概览](#概览)                                             | 存储后端、响应和错误的统一格式、鉴权          |
| [Personal configuration API](#personal-configuration-api) | 模型配置、服务器设置、provider key 是否已配置 |
| [快速开始](#快速开始)                                     | 用 `curl` 从建会话到多轮对话                  |
| [端点列表](#端点列表)                                     | 按功能分组的全部端点，每个一行                |
| [详细文档](#详细文档)                                     | 常用端点的字段、示例和错误码                  |
| [SSE 协议](#sse-协议)                                     | 事件类型和信封格式                            |
| [存储模式说明](#存储模式说明)                             | 三种部署方式、环境变量、配置文件端点          |

**按任务找端点**

| 我想……                       | 端点                                                     | 在哪一节                                     |
| ---------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| 确认服务器活着               | `GET /api/health`                                        | [健康检查](#健康检查)                        |
| 列出、创建、修改世界         | `GET` / `POST /api/worlds`，`PATCH /api/worlds/:id`      | [世界管理](#世界管理)                        |
| 建一局、列出、删除会话       | `POST` / `GET /api/sessions`，`DELETE /api/sessions/:id` | [会话管理](#会话管理)                        |
| 开局、发消息、提交选择       | `POST /api/actions`                                      | [Turn 执行](#turn-执行)                      |
| 打断或引导正在跑的回合       | `POST /api/sessions/:id/abort`、`/steer`                 | 端点列表的“回合中控制（W4）”                 |
| 回答回合里弹出的表单或选项   | `POST /api/actions`（`submit_interaction`）              | [玩家交互](#玩家交互)                        |
| 读聊天记录                   | `GET /api/sessions/:id/messages`                         | [消息历史](#消息历史)                        |
| 读状态表、角色               | `GET /api/sessions/:id/state`、`/characters`             | [状态查询](#状态查询)、[角色数据](#角色数据) |
| 给一局开关插件               | `PUT` / `DELETE /api/sessions/:id/plugins/:pluginId`     | [会话插件管理](#会话插件管理)                |
| 调用插件的手动功能           | `POST /api/sessions/:id/plugin-rpc`                      | [插件 RPC 通道](#插件-rpc-通道)              |
| 批准或拒绝插件的请求         | `POST /api/approvals/:approvalId/decision`               | [RPC Approval 流程](#rpc-approval-流程)      |
| 读写插件自己的数据           | `/api/sessions/:id/plugin-data/...`                      | 端点列表的“插件数据（Plugin Data）”          |
| 存档、分支                   | `POST /api/sessions/:id/snapshots`、`/fork`              | 端点列表的“Snapshot / Fork”                  |
| 订阅一局的实时事件           | `GET /api/events/stream?sessionId=...`                   | [事件系统](#事件系统)                        |
| 测试模型连接、让 AI 生成世界 | `POST /api/ai/ping`、`/api/ai/generate-world`            | [AI 生成](#ai-生成)                          |
| 看一个回合里发生了什么       | `GET /api/traces/:sessionId`                             | [Trace 调试](#trace-调试)                    |
| 管理图片等媒体               | `/api/media/...`                                         | [媒体管理](#媒体管理)                        |
| 安装插件或世界               | `/api/install/...`                                       | 端点列表的“插件与世界安装（Install）”        |
| 看或改配置                   | `/api/config/...`、`/api/llm-config`                     | [配置信息](#配置信息)                        |

**请求体的基本检查**

- 要求 JSON 对象的端点，收到 `null`、数组或单个值时直接返回 `400`，不会进入处理逻辑。
- 审批决定先检查 `decision` 和 `scope` 是不是合法取值，通过了才会消耗那条待决审批。
- 事件注入先检查各个标识符是字符串、`payload` 是对象，然后才发布。

## 概览

- **基础 URL**：`http://localhost:3001/api/`
- **协议**：HTTP JSON API（`Content-Type: application/json`）
- **服务器框架**：[Hono](https://hono.dev/)

### 存储后端

服务器把数据存在哪里，由环境变量 `STORE_BACKEND` 决定：

| 后端       | 值               | 用途                                                   |
| ---------- | ---------------- | ------------------------------------------------------ |
| SQLite     | `sqlite`（默认） | 本机开发、单机部署。数据在 `./data/covel.db`           |
| Memory     | `memory`         | 测试，以及浏览器私有模式的临时执行。进程重启后数据丢失 |
| PostgreSQL | `pg`             | 生产环境。需要 `DATABASE_URL`                          |

补充两点：

- 浏览器私有模式下，服务器用 `memory`，数据由浏览器里的 BrowserVault 保存。
- 用 `pg` 跑多个实例时，会自动启用 `pg_advisory_lock` 会话锁：不同 Node 进程不会同时写同一个会话。

> [!NOTE]
> `idb` 不是服务器的存储后端。它只在浏览器里用，给 MediaStore 和 BrowserVault 存数据。服务器部署只用 `memory`、`sqlite`、`pg`。

### 多实例能力边界

选 `pg` 之后，数据是共享的，一部分跨进程的协调也有了。但不是每种能力都会变成共享服务。

| 能力                         | Memory / SQLite               | PostgreSQL 多实例                                |
| ---------------------------- | ----------------------------- | ------------------------------------------------ |
| 会话写入互斥                 | 进程内的锁，按单进程部署使用  | 共享数据库的 advisory lock                       |
| 事件投递给 SSE 订阅者        | 只在当前进程内广播            | 通过 PG `LISTEN/NOTIFY` 转发                     |
| 活跃回合的 `steer` / `abort` | 操作当前进程持有的执行句柄    | 仍然只在进程内有效                               |
| 后台任务 `_runtime_jobs`     | 能不能保住取决于存储后端      | 通过 CAS 和可续期的租约认领                      |
| 媒体二进制数据               | 由单独的 `MEDIA_BACKEND` 决定 | `mirror` 存进 PG；本地媒体后端的文件不会自动共享 |

PostgreSQL 一列的细节：

- **事件投递**：`LISTEN/NOTIFY` 初始化失败时，服务器拒绝启动，不会悄悄退回进程内广播。
- **`steer` / `abort`**：请求必须到达正在执行那个回合的实例。到了别的实例，就算数据库显示回合在执行，也返回 `409`。
- **后台任务**：包括 detached 的 stage，以及在后台运行的手动或事件触发的 runtime。实例正常关闭时，还没提交的任务放回队列，由下一个 worker 重跑。实例崩溃时，租约过期的 `claimed` / `running` / `committing` 任务会标成 `orphaned`，不会自动重放已经对外产生的效果。

所以，需要可靠地控制当前回合的部署，应当用单实例，或者保证一个动作和它的 `steer` / `abort` 请求被路由到同一个实例。实例退出后，内存里的执行句柄不能搬到别处；数据库共享，不代表另一个实例能接手正在跑的回合。

任务恢复的细节见 [Protocol](./protocol.md)。浏览器和服务器各自以谁的数据为准，见 [Storage Architecture](../internals/storage.md)。

### 响应格式约定

所有普通的 JSON 端点用同一套外层结构：

| 情况                       | 响应                                                 |
| -------------------------- | ---------------------------------------------------- |
| 查询、创建或替换单个资源   | 直接返回资源对象，外面不再包一层 `{ resource: ... }` |
| 查询集合                   | `{ "items": [...] }`                                 |
| 命令或删除，不产生独立资源 | `{ "ok": true, ... }`，其余字段只放有用的确认信息    |
| 聚合视图                   | 保留自己的字段，不是普通的资源列表                   |

- 集合带游标分页时，多一个不透明的字符串 `nextCursor`。取下一页时原样传回：`?cursor=<nextCursor>`。
- 聚合视图的例子：state 的 `tables`、trace 的 `turns`、UI spec 的 `slots`、LLM 配置的 `slots` / `providers`。

成功的状态码：

| 状态码         | 什么时候         |
| -------------- | ---------------- |
| `201 Created`  | 通常是新建了资源 |
| `202 Accepted` | 已接受，异步处理 |
| `200 OK`       | 其他成功的请求   |

失败一律用非 2xx 状态码，加上这个错误信封：

```jsonc
{
  "error": "string", // 必有：人类可读的错误消息
  "code": "snake_case", // 可选：稳定的机器可读错误码
  "details": {}, // 可选：结构化诊断（如 Zod 校验错误数组）
}
```

`error` 一定有。需要客户端按错误码分别处理的端点（如 `plugin-rpc`、`media`）会同时给 `code`。

几种全站统一的错误：

| 状态码 | 响应体                                                                 | 什么时候               |
| ------ | ---------------------------------------------------------------------- | ---------------------- |
| 413    | `{ "error": "Payload Too Large" }`                                     | 请求体超过上限         |
| 503    | `{ "error": "Session is busy, please retry", "code": "session_busy" }` | 等这个会话的执行锁超时 |
| 404    | `{ "error": "Session not found: <id>", "code": "session_not_found" }`  | 会话不存在             |

- **请求体上限**。超限的请求不会进入处理逻辑。带 `Content-Length` 的请求和不带它的流式请求用同一个额度。

  | 路径                                       | 上限   |
  | ------------------------------------------ | ------ |
  | 普通 API                                   | 1 MiB  |
  | `/api/install` 及其子路径、`/api/media`    | 20 MiB |
  | `PUT /api/sessions/:id/browser-checkpoint` | 64 MiB |

- **`session_busy` 可以重试，不是服务器故障**。任何路由等锁超时（PG 部署默认 30 秒）都返回它。比如后台在生成媒体，正常会持锁几分钟，这期间玩家的动作就会碰到它。监控里不要把它算成 5xx 故障。原始错误消息带着 sessionId 和内部模块名，只写日志，不返回给调用方。
- **`session_not_found` 对所有会话端点一致**。路径里带 `:id` 的会话端点，和把会话 ID 放在 query 或 body 里的端点，都返回同一个 `code`。
- **`plugin-rpc` 的 4xx / 5xx 也用这个信封**。它响应里的 `status` 字段只出现在 2xx 的业务结果里。
- **未知异常返回 500**。插件 RPC 和安装路由只在本地处理它们认得的错误：校验、授权、队列、HTTP 领域错误。其余异常交给全局处理器，日志里记下 method、脱敏后的 URL 和 stack。生产环境对未知异常只返回 `500 Internal server error`。文件权限错误和数据库错误不会被安装器改写成 400。
- **`200` 加 `ok: false` 不是 API 失败**。连通性探测和配置重载可能返回 `200 { "ok": false, "error": "..." }`，意思是“请求执行成功了，但被探测的东西不可用”。

### 鉴权：Session owner token

在本机（`DEPLOYMENT_TIER=self`，默认值）和桌面应用里，不带任何 token 就能用全部端点。下面的规则主要影响托管部署。

**owner token 是什么**

`POST /api/sessions` 创建会话时，服务器生成一个猜不到的 owner token，放在响应的 `ownerToken` 字段里。它只在这一次响应里出现，服务器只保存它的 SHA-256 哈希。

框架私有的元数据不会出现在任何响应里：owner 哈希、approval / session incarnation、lifecycle 和 delete lease 等，在会话的增删改查、快照和 `/state` 的虚拟表响应里都会被去掉。

**各部署层级怎样检查**

| `DEPLOYMENT_TIER`     | 行为                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `self`（默认）/ 桌面  | 通常不检查。带了 token 也不校验。例外见下面的“生产 MemoryStore 例外” |
| `demo` / `commercial` | 强制检查                                                             |

`self` 和桌面靠网络边界保护：服务器默认只监听回环地址（`COVEL_BIND_HOST=127.0.0.1`，见 [env-registry](./env-registry.md)），并且只回答 `Host` 是 `localhost`、`127.0.0.1`、`[::1]` 或列在 `COVEL_ALLOWED_HOSTS` 里的请求，其他请求返回 `403 { code: "host_not_allowed" }`。

`demo` / `commercial` 的规则：

- 所有会话作用域的端点，token 缺失或不对时返回 `401 { code: "session_owner_required" }`。会话不存在时返回 404。
- “会话作用域”包括两类：
  - 路径里带会话 ID 的：会话增删改查、messages、traces、actions、plugin-rpc、steer / abort、SSE subscribe、snapshots、state 等。
  - 会话 ID 在 query、body 里，或者被间接引用的：approvals 的列表、撤销和决定，`POST /api/media?sessionId=`，`/api/worlds/:id/world-data/preflight`、`sync-data`、`sync-dimensions`，`GET /api/ui-specs?sessionId=`。
- 没有保存哈希的历史会话一律拒绝。
- `GET /api/sessions` 只对带运维 token 的调用方返回内容，其他人拿到空列表。
- `POST /api/sessions` 创建会话需要运维 token，缺失时返回 `401 { code: "operator_token_required" }`。

> [!NOTE]
> 创建会话要运维 token，这是“只有一个运维方”的门禁。完整的用户身份、租户隔离和配额还没有实现。

**生产 MemoryStore 例外**

即使 `DEPLOYMENT_TIER=self`，只要 `NODE_ENV=production` 而且实际用的存储是 MemoryStore：

- 会话仍然强制检查 owner token。
- 全局世界的创建、修改、删除、维度导入，以及服务端生成后保存，强制要求运维 token。
- 没有配置运维 token 时，世界写入保持关闭。公开读取和合法的会话访问照常可用。

这个判断看的是服务器实际注入的存储后端，不看请求参数，也不看可能和运行实例不一致的 `STORE_BACKEND` 环境变量。

**Token 提交方式**（三选一）：

1. `Authorization: Bearer <ownerToken>`
2. `X-Session-Token: <ownerToken>`
3. `?session_token=<ownerToken>` query 参数（给不能设置 header 的 EventSource / SSE 客户端用）

**运维 master token**

设置了 `COVEL_DESKTOP_REST_TOKEN` 之后，把这个值当作 Bearer token：

- 可以通过任何会话的 owner 检查。管理工具和 e2e harness 用它。
- 在托管层级，它还是下面这些操作的凭证：
  - 创建会话
  - 世界写入、维度导入
  - AI 世界生成
  - 模型探测和刷新
  - 查询 provider key 是否已配置（`GET /api/provider-keys`）
  - 激活 community 插件的服务端代码

community 插件的 ESM 代码会在服务器进程里注册全局能力，所以托管层级激活它时同时要求 owner token 和运维 token。这是目前“只有一个运维方”的信任模型，不提供多租户的代码沙箱。

`DEPLOYMENT_TIER=demo|commercial` 启动时如果没有配置这个 token，`validateSecurityPosture` 会直接拒绝启动。

纯 Web 客户端可以在 **设置 → 运维访问** 里输入或清除这个 token：

- 凭据只保存在当前浏览器的 `localStorage`。
- 只在上面这些需要运维 token 的同源请求里，以 `Authorization: Bearer <token>` 发送。
- 保存或清除后，客户端会重新加载，用新凭据重新取会话和世界数据。
- 开发模式和桌面单用户模式仍然可以不带 token 使用。生产 MemoryStore 按上面的例外处理。

**Web 客户端怎样保存 owner token**

自己写客户端时可以参考这套做法：

- 保存位置：按 sessionId 存在单独的 IndexedDB 数据库 `covel-browser-credentials` 里。不放进显示缓存、游戏 checkpoint 或设置导出。客户端不读取 localStorage 里旧格式的 token，用旧格式凭证的开发会话要重建。
- 创建：等凭证写入完成，创建操作才返回。同一个 ID 的创建如果有迟到的响应，不能覆盖另一个操作已经保存的新凭证。
- 读写都是异步的。`clearSessionToken(sessionId, capturedToken)` 在同一个事务里先核对、再删除捕获的那个 token。当前 token 未知或和它不同时，保留不动。
- 删除会话：HTTP 请求用同一份捕获的 token。请求成功，或者确认是 404，才清理凭证。鉴权失败和其他失败都保留凭证。清理失败不会撤销服务端的删除；之后再删一次得到 404 时可以重试清理。
- 重试与取消：同一个请求的传输重试沿用已经捕获的请求头。凭证存储失败不当作网络故障重试。读取凭证时被取消，就不再发出请求。

删除世界时的核验：

- 不管世界删除成功、部分失败，还是世界已经不存在，客户端都会核验这个浏览器里保存的会话凭证。
- 每个核验请求带上捕获的 owner token。只有会话 `GET` 明确返回 `404` 且 `code: "session_not_found"`，才按捕获的值清理。
- 服务端的会话列表可能隐藏会话，不能当作“会话不存在”的证据。凭证表也不另外记录会话属于哪个世界。
- 之前删掉的、或者在别的设备上删掉的会话，会一起回收。还存在的、鉴权失败的、无法确认的记录保留。
- 所有核验请求共用 3 秒的截止时间，不重试。
- 核验或清理失败不会改变世界删除本身的结果。核验失败的日志只报数量，存储读取失败只报通用诊断，都不含凭证、身份或响应正文。

创建会话后的核验：

- 创建响应必须带当前的 `incarnation`。
- 凭证保存后，客户端用刚拿到的 token 核验这个身份。这是为了处理“创建响应比世界删除的清理到得更晚”的情况。
- 确认会话不存在或身份变了：按捕获的值清理，并报告这次创建已失效。
- 无法核验：保留已经创建并保存好的凭证，记录诊断。
- 这些核验不是客户端和服务器之间的分布式事务。离线，或者之后在别处删除，仍然要等下一次操作才能确认。

**community server-code grant 是 session 授权、进程级生效**

玩家批准一个 community 插件运行服务端代码时，实际发生两件作用范围不同的事。

审批记录按 `(sessionId, session incarnation, pluginId, action)` 保存。`session incarnation` 是服务器私有的随机 nonce（历史会话用 owner token 的哈希代替），不会出现在 API 响应里。

它批准的动作是把插件的服务端代码 `import()` 进 Node 进程。ESM 模块只加载一次，entry factory 也只运行一次（按 pluginId 记住）。所以第一个批准这个插件的会话，就把它注册的 tool、RPC handler、media wire 装进了**进程级**的注册表。之后别的会话不用再批准，也能看到这些注册项存在。

因此边界分两层：

| 层面                                                | 作用域                                           |
| --------------------------------------------------- | ------------------------------------------------ |
| **代码加载 / 能力注册**                             | 进程级，一次性，不能撤销。任何一个会话批准就完成 |
| **调用（RPC dispatch / runtime 加载 / hook 执行）** | 每次仍然按发起请求的会话检查 grant               |

没有批准的会话，过不了 `covel:plugin-server-code` 和 `runtime:<name>` 的检查，hook 也会被跳过（返回 `continue`）。

**revoke 边界**

`DELETE /api/sessions/:id/approvals` 和禁用插件，都会撤销授权。做法是：

1. 在会话锁内，轮换持久化的 session / plugin 授权代次。
2. 清掉当前进程里按会话缓存的 grant、一次性 grant 和待决的审批。

结果：

- 其他 Pod 即使内存里还有旧的 grant，也会因为代次不匹配而拒绝。
- 用旧的 approvalId 做决定，返回 `409 approval_scope_changed`。
- 撤销**不会**卸载已经导入的模块，也不会注销已经注册的 tool、RPC handler 和 wire。JavaScript 没有可靠的模块卸载办法。已经进了进程的代码要到重启才消失。
- 进程重启会清空全部易失的 grant（见 [Snapshot / Fork](#snapshot--fork) 一节）。

在“只有一个运维方”的模型下这可以接受：批准 community 代码，就等于信任它在本进程里运行。多租户隔离需要真正的代码沙箱，还没有实现。

> [!IMPORTANT]
> CORS（`CORS_ORIGIN`）只是浏览器策略，**不是鉴权**。真正的授权边界是 owner token、部署层级和回环监听。

CORS 只能阻止网页读取响应，所以另有一道写入来源检查：

- 对象：带 `Origin` 头的 `POST` / `PUT` / `PATCH` / `DELETE` 请求。
- 规则：`Origin` 不在允许列表里，也不是请求访问的主机（`Host` 或 `X-Forwarded-Host`）时，在进入任何路由之前返回 `403 { "code": "origin_not_allowed" }`。
- 不带 `Origin` 的非浏览器客户端不受影响。

## Personal configuration API

这一节是模型配置和个人设置相关的端点。

**`GET /api/llm-config`** 返回当前生效的模型槽位。字段：

| 字段                           | 说明                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 各槽位的 `serverKeyConfigured` | 布尔值，服务器是否为它配置了 key                                                                        |
| `source`                       | `{ kind: "file" \| "builtin", path }`，配置来自文件还是内置默认                                         |
| `error`                        | 可选。加载配置时的错误                                                                                  |
| `envKeyOverrides`              | provider ID 列表。桌面端在“设置”里保存的 key 被服务器环境变量盖住时列在这里，“设置”会为它们显示一条提示 |

**`POST /api/llm-config/reload`** 重新读取配置文件。TOML 有效时就地生效。无效时返回 `ok: false`，继续使用当前生效的配置。

界面里的设置只是随请求带上的覆盖值，不会写进 TOML。

**托管层级（`demo` / `commercial`）的差别**

- 公开的 `GET /api/llm-config` 仍然返回客户端启动要用的模型目录，但不含 `source`、`envKeyOverrides`、加载 `error` 和槽位的 `baseUrl`。`GET /api/presets` 也不返回 `baseUrl`。带运维 token 才能看到这些字段。
- 公开的 `GET /api/config/info` 返回 `isDesktop: false`、`requiresAuth: true`，路径字段都是 `null`。带运维 token 的请求能拿到完整的部署路径。
- 本机 `self` 和桌面端的响应不受影响。

### Server settings

“服务器设置”是由服务器自己执行的设置，也就是设置注册表里 `scope: "server"` 的条目，见 [`settings-store.md`](./settings-store.md)。

**`GET /api/config/server-settings`**

所有层级都能调用，不需要 token，里面没有秘密。它为每个服务器设置返回三样东西：当前生效的值、值的来源、现在写入会不会起作用。

```json
{
  "settings": {
    "diagnostics.traceRetention": {
      "value": "30",
      "source": "default",
      "settable": true
    }
  }
}
```

| 字段       | 说明                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| `value`    | 当前生效的值                                                                     |
| `source`   | `env`（运维方的环境变量）、`setting`（保存过的值）或 `default`                   |
| `settable` | 环境变量固定了这个键时为 `false`。`demo` / `commercial` 部署里所有键都是 `false` |

`source` 是 `env` 时，`value` 可能是设置界面不提供给玩家的值。例如 `COVEL_TRACE_RETENTION_DAYS=14` 对应 `"14"`。

**`PUT /api/config/server-settings`**

请求体是 `{ "entries": { "<key>": <value> | null } }`。它保存每个值（`null` 表示删掉保存的值），返回和 `GET` 一样的响应体。

- 只在 `DEPLOYMENT_TIER=self` 下接受。
- 桌面外壳设置了 bearer token 时必须带上它，否则返回 `401 desktop_rest_token_invalid`。
- 一个请求里只要有一条被拒绝，就什么都不写。
- 保存的值在下一次提交或清理时生效，不用重启。

| 状态码 | `code`                          | 什么时候                                        |
| ------ | ------------------------------- | ----------------------------------------------- |
| 403    | `server_settings_operator_only` | `demo` / `commercial`，不管调用方带什么 token   |
| 400    | `invalid_server_settings_body`  | 请求体不是 `{ entries: object }`                |
| 400    | `unknown_server_setting`        | 某个键不是服务器设置（见 `details.key`）        |
| 400    | `invalid_server_setting_value`  | 某个值不符合该设置的 schema（见 `details.key`） |
| 409    | `server_setting_fixed`          | 环境变量固定了这个键（见 `details.key`）        |

**配置端点的其他规则**

- 配置文件系统出错、文件管理器启动失败，都交给全局错误处理器并写日志。生产环境的响应是通用的 500。
- 提交的 TOML 或代理配置无效时，仍然返回带具体诊断的 400。
- 已有的配置读不出来时，保留原配置，不当作“输入有误”。

**`GET /api/provider-keys`**

只返回 `{ providers: { [provider]: { configured: true } } }`，数据来自运行时当前的凭证表。任何 key 的原文或打码形式都不会经过这个端点，带了桌面鉴权的请求也一样。浏览器不会把这些服务器默认值导入到个人密钥里。

**桌面端的文件管理 API**

- `COVEL_HOME` 只用来选目录。
- 桌面端管理文件系统的 API 必须显式设置 `COVEL_DESKTOP_REST=1` 才启用。Electron 会提供自己的 sidecar token。
- 普通浏览器即使连到开启了这项能力的服务器，也仍然用自己 localStorage 里的设置。

## 快速开始

下面用 `curl` 走一遍完整流程：启动服务器，建一局，开局，对话几轮，最后删掉会话。

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

记下响应里的 `id`。它的格式是 `{worldId}-{uuid8}`，例如 `mistport-a1b2c3d4`。后面的请求都要用它。

### 6. 开局（激活插件并跑 setup）

回合只有一个入口：[`POST /api/actions`](#post-apiactions)。**没有**会话级的 `/turn` 端点。响应是一条只含 `data:` 行的 SSE 流，所以 `curl` 要加 `-N` 关掉缓冲。

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-001",
    "type": "start_session",
    "sessionId": "<sessionId>",
    "payload": {}
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
    "payload": { "content": "走向远处的城镇" }
  }'
```

### 10. 提交玩家交互（如果 Turn 返回了 pendingInputs）

回合有时会停下来等玩家回答，比如让你在几个选项里选一个。这时把答案作为 `submit_interaction` 提交。`turnId` 和 `interactionId` 来自上一条 SSE 流。

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-004",
    "type": "submit_interaction",
    "sessionId": "<sessionId>",
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

### 11. 删除会话

```bash
curl -X DELETE http://localhost:3001/api/sessions/<sessionId>
```

> [!CAUTION]
> 这会删除这个会话和它的全部存档数据（消息、状态、快照等），不能恢复。

## 端点列表

这一节按主题列出全部端点，每张表后面是这组端点共用的规则。请求体、响应示例和错误码在后面的[详细文档](#详细文档)里。

### 健康检查

| 方法 | 路径          | 描述     |
| ---- | ------------- | -------- |
| GET  | `/api/health` | 健康检查 |

### 世界管理

| 方法   | 路径                                    | 描述                                                           |
| ------ | --------------------------------------- | -------------------------------------------------------------- |
| GET    | `/api/worlds`                           | 列出所有世界的摘要（不含 `lore` / `dimensions`）               |
| GET    | `/api/worlds/:id`                       | 获取世界完整记录                                               |
| POST   | `/api/worlds`                           | 创建世界；ID 已存在返回 `409 world_already_exists`             |
| PATCH  | `/api/worlds/:id`                       | 部分更新世界（支持顶层 `dimensions`，`metadata` 与现有值合并） |
| DELETE | `/api/worlds/:id`                       | 删除世界及其全部会话，规则见下文                               |
| GET    | `/api/worlds/:id/dimensions/export`     | 导出世界维度（YAML / JSON）                                    |
| POST   | `/api/worlds/:id/dimensions/import`     | 导入世界维度                                                   |
| POST   | `/api/worlds/:id/sync-dimensions`       | 作者和工具：把世界维度同步到指定的一个活跃会话                 |
| POST   | `/api/worlds/:id/world-data/preflight`  | 只读地预演 worldData 导入                                      |
| POST   | `/api/worlds/:id/sync-data`             | 作者和工具：同步由导入器管理的 worldData 行，默认 dry-run      |
| POST   | `/api/worlds/:id/translate`             | 用配置的模型为用户世界目录里的世界包增加一种语言版本（SSE）    |
| GET    | `/api/worlds/:id/gallery`               | 列出世界包自带的图片（场景、立绘）                             |
| GET    | `/api/media/library`                    | 玩家的媒体库（仅 `self` / 桌面端）                             |
| POST   | `/api/media/library/delete`             | 删除玩家选中的媒体，或所有没有会话使用的媒体                   |
| GET    | `/api/worlds/:id/gallery/:source/:file` | 读取 gallery 列表里的一张图片                                  |

几条补充：

- `POST /api/worlds/:id/sync-dimensions` 只处理指定会话受保护的 `_dimensions` 记录和导入账本，不写 lorebook；见下文的端点说明。
- `POST /api/worlds/:id/world-data/preflight` 构建 worldData 的导入计划但不写入，返回 diagnostics、计划写入的数量和目标摘要。
- `POST /api/worlds/:id/sync-data` 依据来源账本（provenance ledger）判断哪些行归导入器管理。
- `GET /api/worlds/:id/gallery` 让世界列表和世界详情在还没有会话时也能展示图片。
- `GET /api/media/library` 分页列出已存储的媒体、使用它的会话和可释放的空间。

#### 删除世界

`DELETE /api/worlds/:id` 的限制：

- 内置世界（`source: "file"`）返回 `403`。
- 文件世界按存储绑定和清单 ID 定位。找不到或有歧义时返回 `409 world_package_unresolved`。
- 托管层级（`demo` / `commercial`）和生产 MemoryStore 需要运维 token。

删除分几步进行：

1. 服务端短暂持有世界锁，记录“删除中”状态，然后释放世界锁。
2. 逐个走完整的会话删除流程：等待执行中的写入、运行生命周期钩子、清理媒体引用和进程内状态。
3. 删除世界记录和对应的文件包。

文件包先移出加载目录，再删除记录和文件。中断后的启动恢复规则见[世界安装](./world-installation.md#更新与数据保护)。

> [!NOTE]
> 底层 `DataStore.deleteWorld` 只删除世界记录。需要连带清理会话的调用必须走这个 API。

世界处于“删除中”时：

- 仍然可以读取。
- 世界 PATCH、维度导入、会话创建、fork 和 browser checkpoint 写入返回 `409 world_deleting`。checkpoint 同时检查原世界和目标世界。
- 启动加载和文件监听不会覆盖删除状态，也不会用等锁之前读到的旧数据重建已删除的文件世界。
- `metadata.worldDeletion` 由服务端管理。客户端不能通过世界写入或 checkpoint 设置或清除它。

锁的顺序：

- 服务端的创建、fork 和 checkpoint 写入按“会话锁 → 世界锁”提交。
- 世界 DELETE 不会拿着世界锁去等会话锁、后台执行或插件钩子。
- 浏览器私有模式的 Web Locks 是独立的客户端协议，有自己的锁顺序，见[浏览器私有工作区](#浏览器私有工作区)。

级联删除不是覆盖全部会话的一次数据库事务：

- 部分清理失败时，已删除的会话不恢复，世界保留一个可重试的标记。
- 再次 DELETE 会继续清理。普通的失败重试不会重复已完成的 SessionEnd。
- 运行中的 SessionStart 等生命周期钩子可能让删除返回 `409 session_lifecycle_busy`。
- 进程中断后遗留的删除租约，10 分钟后可由后续的 DELETE 接管。

### 会话管理

| 方法   | 路径                | 描述                                               |
| ------ | ------------------- | -------------------------------------------------- |
| GET    | `/api/sessions`     | 列出所有会话（可选 `?worldId=` 过滤）              |
| POST   | `/api/sessions`     | 创建新会话                                         |
| GET    | `/api/sessions/:id` | 获取会话信息                                       |
| PATCH  | `/api/sessions/:id` | 更新会话字段（`status` / `runtimeModelOverrides`） |
| DELETE | `/api/sessions/:id` | 删除会话                                           |

#### 会话身份 `incarnation`

会话列表、创建、详情和 PATCH 的响应都带 `incarnation`。它是同一条持久化会话的身份标记：

- 稳定、不透明。普通字段的修改不会改变它。
- 会话删除后用相同 ID 重建，会得到新的标记，即使创建时间恰好相同。
- 客户端只比较它是否相等，不从中推导业务含义。
- 它不授予权限，也不替代 owner token。
- 它由服务端从内部身份派生，客户端不能设置。内部 nonce 和凭据哈希不公开。
- 服务端会话必须已有持久化的 incarnation nonce。缺少该字段的开发期数据需要重建。

#### Web 客户端的显示缓存（远程模式）

这一段说的是 Web 客户端自己的行为，直接调用 API 的客户端可以跳过。

远程模式下，表单提交标记和历史执行时间线存在独立的浏览器缓存里（IndexedDB），不存在服务端。

缓存怎么确认归属：

- 每次缓存调用都带上界面当时的会话身份（`id`、`worldId`、`incarnation`）。
- 读取时、首次建立归属时、更换归属时，向服务端核对一次（多一次会话 GET）。已核验归属的显示更新直接存在浏览器，流式输出的每一段不会都去请求服务端。
- 所有操作都在 IndexedDB 事务里检查两件事：会话和世界的删除时序，以及缓存是否已经绑定到另一条同 ID 的会话。
- 响应里没有有效身份属于契约错误，缓存操作失败。
- 网络错误或鉴权错误不当作“会话不存在”，也不会用旧缓存代替服务端的数据。

缓存里存什么：

- 表单的增量在事务内合并。时间线保存的是显示快照。
- 远程和本地模式下，每个会话的时间线缓存最多保留最近 1000 条执行记录。更早的记录按首次写入的顺序移出。
- 本地和远程模式各用各的缓存表。远程模式只读当前格式（缓存库 v2，记录会话身份和世界归属），显示历史从当前会话重新积累。服务端的游戏状态不受缓存影响。

删除时怎么清理：

- 远程删除在发出服务端请求之前和之后，都会让相关的缓存操作失效。之后核对已缓存的会话，清掉已消失或被替换的记录。
- 世界只删除了一部分时，也清理已确认删除的那部分，并保留失败响应和仍然有效的缓存。
- 缓存出错不会撤销服务端的删除。之后的删除或缓存读取可以重试清理。
- 这套协调只用 IndexedDB，不需要 Web Locks。
- 会话在其他设备上被删除后，本浏览器在下次核对时清理。离线的浏览器不保证立即清除。

给前端开发者：`DataService` 的四个表单 / 时间线缓存方法要求调用方传入操作发起时的会话对象（`id`、`worldId`、`incarnation`），不能在异步等待之后重新推断归属。前后端按当前契约一起更新，不支持混合版本。

### 浏览器私有工作区

这两个端点是 Web `LocalDataService` 的内部同步协议，不是通用的远程存储 API。

- 只在 `STORE_BACKEND=memory` 的浏览器私有配置（browser-private profile）下可用。
- 鉴权和其他会话端点一样，使用 owner token。

| 方法 | 路径                                   | 描述                                                         |
| ---- | -------------------------------------- | ------------------------------------------------------------ |
| PUT  | `/api/sessions/:id/browser-checkpoint` | body `{ checkpoint }`；事务性地替换临时 MemoryStore 工作区   |
| POST | `/api/sessions/:id/browser-commit`     | body `{ actionId, baseRevision }`；导出下一版完整 checkpoint |

- `browser-checkpoint` 拒绝过期的 revision，也拒绝 revision 相同但 head 不同的分叉。
- `browser-commit` 对重复的 `actionId` 是幂等的，返回同一个 commit。
- `SessionCommit` 的形状是 `{ baseRevision, revision, actionId, checkpoint }`。

#### 校验与错误

| 状态码 | `code`                             | 什么时候                                                                               |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| 400    | `invalid_checkpoint`               | checkpoint 结构不合法，包括 `checkpoint.messages` 里有重复的消息 ID                    |
| 400    | `invalid_checkpoint_scope`         | checkpoint 的 `sessionId` 和路径里的 `:id` 不一致，或 `profile` 不是 `browser-private` |
| 400    | `session_record_scope_conflict`    | 快照、挂起记录或世界导入账本的全局记录 ID 已经属于其他会话                             |
| 401    | `operator_token_required`          | 普通所有者通过 checkpoint 引用服务端还没有的世界（见下文“共享部署”）                   |
| 401    | —                                  | 排队期间会话的所有者变了                                                               |
| 409    | `browser_private_profile_required` | 服务端的存储不是 MemoryStore                                                           |
| 409    | `unsupported_browser_mutation`     | 有 durable detached job 时，上传删除或改写了执行域，或改变了会话身份                   |
| 409    | `world_deleting`                   | 原世界或目标世界正在删除                                                               |
| 409    | —                                  | 还没有上传过 checkpoint、revision 冲突、会话实例变了或会话正在删除                     |
| 413    | —                                  | `browser-checkpoint` 的请求体超过 64 MiB                                               |

校验规则：

- 当前 `BrowserCheckpoint` 的 `schemaVersion` 是 `2`。其他版本直接拒绝。
- 边界上校验必填的会话时钟（session clock）、规范的 `origin` / `commitStatus` 和快照 schema。
- 所有外部记录用 Zod 校验结构。
- 顶层和快照内的会话域记录必须属于 checkpoint 的 `sessionId`，`world.id` 必须等于 `session.worldId`。违反时返回 `400`。
- `session_record_scope_conflict` 会回滚整个 checkpoint 写入。
- 重复消息 ID 的校验会指出重复项的 `messages[index].id`，并且在替换事务、删除原会话或写入世界之前就拒绝。这是 messages 表的身份规则，不要求不同记录域或快照里的历史引用使用不同的 ID。
- checkpoint 不能携带 provider key、owner token 或其他凭据。

两个端点都在拿到会话锁之后，重新验证所有者、会话实例和删除状态，然后才读取 revision 或幂等缓存。相同 ID 的新会话不继承旧实例的 revision、head 和 commit。

#### 请求体上限

- `PUT /api/sessions/:id/browser-checkpoint` 的完整 JSON 请求体上限是 **64 MiB**，其中包含全部消息、轨迹和快照。超过返回 `413`。
- 这个额度只给该路径的 `PUT`。`browser-commit` 等普通 API 仍然是 **1 MiB**。
- 协议不支持分块上传，所以完整的 checkpoint 必须放得进这个额度。
- Web 客户端在请求体达到额度的 80% 时提示玩家一次（每个会话、每次页面载入一次）。

#### 幂等重放缓存

- 每个会话最多缓存最近 16 个完整 commit，用于幂等重放。
- 会话删除成功时，该 API 实例持有的 revision、head 和所有重放 payload 一起释放。其他会话的重试缓存不受影响。
- 删除失败而会话还在时，缓存保留。只有数据确实删除了才清理缓存。

#### 有后台作业时上传 checkpoint

如果服务端已经有验证过的 head，并且存在 durable detached job，checkpoint 上传会保留服务端的作业、租约和执行结果，只接纳相对上次 head 的这些变化：

- 新增的用户消息；
- 会话的 `status` 和模型覆盖（model overrides）；
- 已授权的世界修改。

其他情况：

- 删除、改写执行域或改变会话身份，返回 `409 unsupported_browser_mutation`。
- 成功响应带 `reconcileRequired: true`，同一次上传的幂等重试也带。
- 客户端必须先持久化 `hydrate:<revision>` pending marker，再下载并应用对应的 browser commit，然后才能继续执行。
- 没有已有 head 的首次同步，以及服务端重启后的恢复，仍然由完整的浏览器 checkpoint 重建。

#### 共享部署

启用了会话所有者鉴权的共享部署，以及 production + MemoryStore 的 `self` 部署：

- 普通的 checkpoint 同步保留服务端已有的全局世界记录，忽略上传的世界内容。后续 commit 返回服务端的世界版本。
- 通过 checkpoint 创建或修改全局世界，必须另外持有运维 token。
- 普通所有者引用服务端还没有的世界时，返回 `401 operator_token_required`。checkpoint 里省略 `world` 内容也一样。

开发和桌面单用户模式下，世界照常随 checkpoint 同步。

浏览器在准备或恢复已有世界时会自动同步世界：

- 收到确切的 `401 operator_token_required` 时，保留服务端的共享世界，继续同步会话。
- 其他鉴权、网络和服务端错误照常返回给调用方。
- 创建服务端还没有的本地世界仍然需要管理员凭据。
- 显式的世界编辑 API 不会把“写入被拒绝”当成成功。

#### Web 客户端的协调（私有模式）

以下是 Web 客户端自己的行为，写给改前端的人看。

**一次动作的完整流程。** Web 私有模式按 vault 数据库和 session ID 取得跨标签页的 Web Lock，并在同一次持锁期间完成：

1. 恢复上一次遗留的 pending；
2. 持久化本次输入；
3. 上传 checkpoint；
4. 记录本次 pending；
5. 执行；
6. 下载 commit 并清理 pending。

- 普通的本地 checkpoint 修改和会话删除也用同一把锁。
- 排队期间已经失效的动作不会持久化新输入。
- 其他会话仍然可以独立执行。
- 页面关闭会释放锁，另一个页面可以接着恢复。仍由活跃页面持有的操作不会被提前导出成旧结果。
- 服务端单次请求的会话锁和 revision 检查，不能代替客户端这一整套协调。

**`actionId` 冲突。** 客户端的 `applySessionCommit` 拒绝同一个 `actionId` 携带不同内容的提交，抛出 `ActionIdConflictError`。调用方通过错误类和它的 `sessionId`、`actionId` 判断冲突。这个本地错误没有 `code` 字段；HTTP 响应里的错误码由端点定义。

**世界锁和会话锁。** 顺序固定：先世界，后会话。

- 会话的创建、修改、删除和完整工作区操作，持有世界的共享锁。
- 世界字段修改、生成结果整条保存和删除，持有世界的独占锁。
- 不同会话仍然可以并行。世界修改会等正在执行的会话完成，避免 checkpoint 里的旧世界副本覆盖新数据。
- 删除世界时，先等已获准的会话操作全部结束，再枚举并清理会话。删除之后才排到的新建会话会重新检查世界是否存在，不存在就失败。
- 世界字段的 patch 在锁内合并最新记录。`saveGeneratedWorld` 是显式的整条替换。

**样例世界。** 浏览器样例世界只在新 vault 首次初始化、并且世界列表为空时插入。

- 样例和初始化标记在同一个事务里提交。跨标签页只初始化一次，失败可以重试，不会留下一部分样例。
- 删除全部世界后刷新，列表保持为空。
- Dexie schema v5 升级保留已有列表（包括空列表），不会再次补入样例。
- 只有显式清空整个 vault 才会重置初始化标记。

**显示历史、表单和时间线缓存。** 它们存在独立的缓存库里，不替代 checkpoint，也不替代游戏状态。

- 状态变化的显示历史：读取直接查 IndexedDB；单条追加在读写事务里合并，事务提交后才算完成。
- 追加和保存沿用世界 / 会话锁，排队结束后检查会话是否还在。迟到的追加或保存会失败，不会重建已删除会话的缓存。
- 表单和时间线的保存在入队前复制输入。表单在事务内合并，时间线替换显示快照。
- 删除会话（包括删除世界时清理它的会话）会等显示历史、表单和时间线缓存全部清理完。
- 缓存失败不会撤销已提交的游戏状态或会话删除。清理失败时在开发环境输出警告，再次删除可以重试清理。
- 远程模式不会因此得到本地 vault 的这套生命周期协调。

**运行环境。**

- 浏览器私有执行需要支持 Web Locks 的 HTTPS 或 localhost 环境。缺少这项能力时，在发送动作之前就报告工作区错误，不会降级成只在当前标签页排队。
- 锁只协调共用同一个同源 vault 的页面，不跨独立的浏览器，也不跨 origin。远程存储模式仍然由服务端协调。
- `LocalDataService` 的工作区回调提供已经持锁的输入 / 同步操作，调用方必须等这些操作完成。不要在回调里再调用会去拿本地世界锁或会话锁的公开方法。

### 会话快照

| 方法 | 路径                      | 描述                                                         |
| ---- | ------------------------- | ------------------------------------------------------------ |
| GET  | `/api/sessions/:id/view`  | 获取会话聚合视图，用于客户端恢复和重连                       |
| GET  | `/api/sessions/:id/turns` | 列出持久化的回合执行记录（`turn_results`），返回 `{ items }` |

`GET /api/sessions/:id/turns`：

- 每项带 `commitStatus` 和 `origin`。
- `?limit=n` 的上限是 500。
- 声明了 `io.concealed` 的 runtime，结果里的 `output` 和工具参数 / 结果会被清空。
- 这是一条很薄的路由，主要给真实模型验证工具（见 [用真实模型验证](../ship/real-model.md)）使用。

`GET /api/sessions/:id/view` 有几点要知道：

- **只含最近窗口。** `messages` 和 `executionSteps` 默认是最新的 80 条消息和 600 条 trace 事件，不是全量。
- **向上翻页。** 视图带一个不透明的 `messagesCursor`。前端向上滚动时，把它原样作为 `?cursor=` 传给 `GET /api/sessions/:id/messages/page`。
- **窗口外的旧回合**不渲染执行时间线。
- **会话时钟。** 视图内嵌的 session 对象带有和会话 API 相同的必填时钟：`phase`、`completedPlayerTurns`、`setupRuntimes`。恢复和重连只以这些字段判断进度。

视图的 `submittedInteractions` 列出玩家已经回答过的交互，形状是 `{ turnId, interactionId, values }[]`。`values` 是服务端保存的值。

- 只返回 `messages` 窗口内的消息所在回合的回答（按消息的 `turnId`，或表单块自己的 `meta.turnId`）。它的用途是给窗口里的表单块打标记。更早的表单随历史分页载入，按位置视为已回答。
- 答案和它的后续回合在同一个 `submit_interaction` 请求里保存和开始。所以列在这里的交互一定已经有回合跟上。
- 客户端把对应消息里的表单标成已提交并回填，不再发送。
- 刷新、换设备或在第二个标签页打开，看到的都和提交的那个浏览器一致。浏览器自己的缓存只在提交和下次恢复之间有效，以服务端记录为准。
- 提交的响应丢失时，客户端从这里得知答案已经保存，并通过 `execution` 状态观察那个回合。

恢复已有会话时，如果最近窗口和已加载的消息不重叠：

- 客户端用同一个 `/messages/page` 接口向旧锚点补读，再把连续的窗口合并起来。
- 中间页不会被当作全局最旧的一页，旧历史和它的分页游标不会被覆盖。
- 补读失败时保留旧窗口并提示，重试只做只读恢复。
- 这种补读不需要新的 API，也不会重发回合。

### 刷新与未完成回合恢复

`GET /api/sessions/:id/execution` 返回 `SessionExecutionStatus`，说明这个会话现在有没有回合在跑。它使用和其他会话端点相同的归属校验。`GET /api/sessions/:id/view` 的可选字段 `execution` 给出同一份状态。

| 字段          | 说明                                                      |
| ------------- | --------------------------------------------------------- |
| `state`       | `idle`、`running`、`completed`、`failed` 或 `interrupted` |
| `turnId`      | 可选                                                      |
| `requestId`   | 可选                                                      |
| `startedAt`   | 可选                                                      |
| `origin`      | 可选                                                      |
| `abortReason` | 可选                                                      |
| `retry`       | 可选，`{ type, payload }`，玩家显式重试时使用             |

这个接口不会去等长回合的锁。PostgreSQL 下用非阻塞的 advisory lock 探测；另一个进程还持有锁，或暂时拿不到连接时，保守地返回 `running`，这时可能没有回合标识。

#### 会话在查询期间被替换

`/execution` 把通过 owner 校验的会话 incarnation 绑定到响应一侧的读取上。如果查询期间会话消失了，或者同 ID 的会话被删除后重建，返回：

```json
{
  "error": "Session was replaced while the request was reading",
  "code": "session_incarnation_changed"
}
```

状态码是 `409`，响应里不会带新会话的重试输入。这次复核不等长回合结束。请求开始时会话就不存在，仍然返回 `404`；owner 校验失败仍然返回 `401`。

#### 各种情况下的状态

- **玩家停止了回合，回合还没提交。** `state` 是可重试的 `"failed"`，并带 `abortReason: "aborted-by-player"`。界面应该显示“主动停止”，不是通用错误。停止原因从持久化的 `turn.completed` 读取，刷新不会丢，也不会自动重试。
- **网页刷新或 SSE 断开。** 原回合不会被取消。客户端只查询状态，恢复已提交的消息、时钟和任务步骤，不会自动重新调用模型。
- **服务器进程停止。** 前台的内存执行会丢失。没有活跃的锁、没有已提交的记录、也没有终止记录时，状态是 `interrupted`。
- **已经提交、但来不及记录终止 trace 的回合**仍然是 `completed`。
- **浏览器里的旧步骤**只用来补充服务端快照缺少的信息，不能把终态改回 `running`。`runtime.completed` 的 `payload.status` 决定一个步骤是成功、失败、跳过还是挂起。

#### 重试

- `retryFromTurnId` 指向逻辑回合的顶层持久化记录。递归执行可能保存同一个 turnId 的子记录；服务端不会把子记录选为重试源，也不会把同一回合的子记录当成后续的故事推进。actions 和 runtime RPC 用同一套筛选规则。
- 玩家显式重试时，使用 `retry` 里的描述和一个新的 `requestId`，并在 payload 里加上 `recoverFromTurnId`。
- 服务端在会话锁内再次核实源回合。重复点击，或原回合已经结束，都不会再执行一次。
- 开场延续的重试保留 `origin: continuation`，不增加玩家回合数。
- 新回合的 `turn.started` 只记录恢复所需的动作输入，不记录请求头和凭据。
- 对于旧日志，只有同一请求的 traceId 能证明它是开场延续时，才提供无输入的重试；否则要求玩家重新输入。
- 批量辅助任务的恢复使用 `retry_failed_runtimes`。中断之后必须按 `retry` 的描述恢复同一组目标。没有提交的成功任务不能算作已恢复，也不能用作上下文。

### Turn 执行

回合执行的唯一入口是 [`POST /api/actions`](#post-apiactions)（SSE 桥接）。没有会话级的回合端点。

有些 runtime 不需要回合等它跑完：安全的叶节点 runtime 声明 `schedule.completion.mode: detached` 后，会在原回合的事务里进入持久化队列，成为后台作业（runtime job）。下面的端点管理这些作业：

| 方法 | 路径                                           | 描述                                                         |
| ---- | ---------------------------------------------- | ------------------------------------------------------------ |
| GET  | `/api/sessions/:id/runtime-jobs`               | 列出该会话的后台 runtime job，不返回内部冻结的 `payload`     |
| POST | `/api/sessions/:id/runtime-jobs/:jobId/cancel` | 取消仍处于 `queued` / `claimed` / `running` 的 job           |
| POST | `/api/sessions/:id/runtime-jobs/:jobId/retry`  | 为失败类终态显式创建新的 queued job；返回 `202` 和新 `jobId` |

### 回合中控制（W4）

| 方法 | 路径                      | 描述                                           |
| ---- | ------------------------- | ---------------------------------------------- |
| POST | `/api/sessions/:id/steer` | 向进行中的回合插话。body `{ message: string }` |
| POST | `/api/sessions/:id/abort` | 中止进行中的回合。幂等                         |

两个端点在没有进行中的回合时都返回 `409`。

`steer`（插话）：

- 消息并入 story runtime 的下一次 LLM 调用，并保存到消息历史。
- 只对 `outputKind: story` 的 runtime 生效。plugin runtime 执行的是结构化任务，不接受插话。
- 插话在最终响应流式输出期间到达时，story runtime 在收尾前追加一步 LLM 调用来消化它（受 maxSteps 约束）。
- 消息保存失败时，撤回队列里的这一项并返回 `500`。

`abort`（中止）：

- 立刻切断进行中的 LLM 流，不保留已生成的部分内容，不保存任何半截提案，并停止调度后面的 runtime。
- 当次 action SSE 的 `execution.completed` 载荷带 `abortReason: "aborted-by-player"`。
- 提交前收到停止信号时，本次执行不提交消息、领域状态和回合计数。已经提交的回合不回滚。
- 回合开始前和提交前，如果正在等上一轮的记忆更新，也会响应停止：取消当前的等待并释放会话执行锁。上一轮已提交回合的记忆更新会独立完成。

两者共同的限制：

- 回合的控制注册表在进程内。多 pod（PG）部署下，steer / abort 只能到达同一个 pod 上的回合。跨进程的执行状态探测不改变这一点。
- 注册发生在拿到会话锁之后，覆盖准备、模型执行、提交和收尾，直到 action 完成才释放。所以刷新时不会在提交还没完成时误判为空闲；排队的请求也不会覆盖当前回合的控制注册。
- 停止信号不能撤回已经完成的事务。

### Setup runtime 控制（重试 / 跳过）

会话停在 setup 阶段时，再发一次 `start_session` 就是“重试 setup”：

- 它不记录玩家消息，只运行还没完成的 setup runtime。`pending` 的重新执行，`done` 的不动。
- 已保存的表单提交照常被读取。
- 玩家提交表单之后、后续动作发出之前关掉了页面，回来后也用它继续。

Web 在这三个条件同时成立时显示提示和按钮：会话处于 setup、屏幕上没有待填的表单、没有执行在跑。有 runtime 记录了 `lastError` 时，提示为失败并显示错误。

setup runtime 反复失败、用完重试预算（`maxTriggerCount`）后进入 `blocked`：

- 会话会停在 setup 阶段。该插件的其他 runtime 被跳过，原因是 `skipped: setup-incomplete`。
- `blocked` 的 runtime 不会被 `start_session` 重新执行，要先用下面的端点解封。
- Web 的“重试”按钮先对每个 `blocked` 的 runtime 调用 `retry`，再发 `start_session`。

这两个端点使用和其他会话端点相同的 owner token 鉴权。

| 方法 | 路径                                       | 描述                                                             |
| ---- | ------------------------------------------ | ---------------------------------------------------------------- |
| POST | `/api/sessions/:id/setup/:runtimeId/retry` | 把 `blocked` 的 setup runtime 复位为 `pending`                   |
| POST | `/api/sessions/:id/setup/:runtimeId/waive` | 跳过 `blocked` 的 setup runtime。body 必须是 `{ confirm: true }` |

两个端点都返回 `{ ok, runtimeId, state }`。

- `retry` 把 runtime 写回新的 `pending`：`generation + 1`、`attempts = 0`，下次执行时重新跑一遍。
- `waive` 把 runtime 标记为 `done{resolution:"waived"}`，并附一条降级 `warning`。这样它所属插件的会话门就算满足了。
- `:runtimeId` 是完整的 runtime id（`<pluginId>/<runtimeName>`），需要 URL 编码。
- 幂等：`retry` 对已经是 `pending` 的目标、`waive` 对已经是 `waived` 的目标，都返回 `200`，没有副作用。
- 两个端点只更新 `setupRuntimes`。`phase` 的切换仍然由下一回合的 finalize 事务负责。

| 状态码 | `code`             | 什么时候                                                                                           |
| ------ | ------------------ | -------------------------------------------------------------------------------------------------- |
| 400    | `confirm_required` | `waive` 的 body 缺少 `{ confirm: true }`                                                           |
| 404    | —                  | 会话不存在                                                                                         |
| 409    | —                  | 目标不是 `blocked`（例如 `done{completed}`、`pending`）；`error` 里说明只有 blocked 才能重试或跳过 |

### 玩家交互

| 方法   | 路径                                  | 描述                                                         |
| ------ | ------------------------------------- | ------------------------------------------------------------ |
| POST   | `/api/sessions/:id/plugin-rpc`        | 统一的插件 RPC 通道（action / runtime / command / event 级） |
| GET    | `/api/sessions/:id/approvals`         | 列出该会话待批准的 RPC 请求                                  |
| DELETE | `/api/sessions/:id/approvals`         | 撤销该会话已缓存的授权，返回 `{ ok, cleared }`               |
| POST   | `/api/approvals/:approvalId/decision` | 提交玩家的审批决定（allow / deny + once / session）          |

`DELETE /api/sessions/:id/approvals` 可以用 `?pluginId=` 只撤销一个插件的授权。撤销后，下次调用会重新弹出审批。

### 会话插件管理

| 方法   | 路径                                  | 描述                                       |
| ------ | ------------------------------------- | ------------------------------------------ |
| GET    | `/api/sessions/:id/plugins`           | 列出会话插件，每项携带 `active` / `locked` |
| PUT    | `/api/sessions/:id/plugins/:pluginId` | 启用插件                                   |
| DELETE | `/api/sessions/:id/plugins/:pluginId` | 禁用插件（必需的 core 插件返回 `403`）     |

`GET` 只读已经保存的会话记录，不等正在运行的回合，也不等后台任务。回合进行中刷新页面，插件面板和命令列表照样立刻拿到。

### 全局插件

| 方法   | 路径                          | 描述                                                                       |
| ------ | ----------------------------- | -------------------------------------------------------------------------- |
| GET    | `/api/framework/capabilities` | 框架级能力索引：manifest 枚举、工具、proposal、world-data URI              |
| GET    | `/api/framework/authoring`    | 世界创作面：世界包文件、内置数据目标、各数据契约的创作说明与示例、插件目录 |
| GET    | `/api/plugins`                | 列出 registry 中的插件及其注册 / 错误状态                                  |
| GET    | `/api/plugins/:id`            | 获取插件详情及完整的 manifest 开发契约                                     |
| DELETE | `/api/plugins/:id`            | 卸载第三方插件（删除 `~/.covel/plugins/<id>`）                             |
| GET    | `/api/plugin-flows`           | 开局前流程的预览数据（插件列表 + 分段步骤），供准备页展示                  |

`DELETE /api/plugins/:id`：

- 鉴权：桌面端要求 bearer token；没有 token 的生产部署要求 `COVEL_INSTALL_API_ENABLED=1`。
- 成功返回 `{ ok, id, restartRequired: true }`。
- 先改名移出加载目录，再清理文件。改名失败返回 500，原包保持完整；清理失败仍返回成功并记日志，下次启动重试清理。

| 状态码      | 什么时候      |
| ----------- | ------------- |
| `400`       | id 格式非法   |
| `401`/`403` | 鉴权失败      |
| `404`       | 插件没有安装  |
| `409`       | id 是内置插件 |

### 插件与世界安装（Install）

这组端点安装插件和世界，有两种来源：

- 上传 `.zip` 包；
- GitHub 链接。解析和下载遵循现有的网络代理设置。

世界包见 [世界目录与安装](./world-installation.md)，插件见 [插件目录与安装](./plugin-installation.md)。

鉴权：

- 基础鉴权和 `DELETE /api/plugins/:id` 相同：桌面端要求 bearer token；没有 token 的生产部署要求 `COVEL_INSTALL_API_ENABLED=1`。
- 在 `demo` / `commercial` 层级，所有安装管理接口必须持有运维 token。启用安装 API 不会绕过这项检查。
- 世界安装还要满足全局世界写入的鉴权：生产 MemoryStore（包括 `self`）和 托管层级必须持有运维 token。启用安装 API 同样不会绕过。

| 方法   | 路径                                                | 请求                           | 描述                                                         |
| ------ | --------------------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| POST   | `/api/install/plugin`                               | multipart 字段 `file`          | 把插件 `.zip` 解压到用户插件目录                             |
| POST   | `/api/install/world`                                | multipart 字段 `file`          | 把世界 `.zip` 解压到用户世界目录                             |
| POST   | `/api/install/plugin/github/preview`                | `{ url }`                      | 解析公开的 GitHub 仓库或子目录并返回预览；不安装、不执行插件 |
| POST   | `/api/install/plugin/github`                        | `{ token, acceptRisk: true }`  | 校验已确认的预览并安装                                       |
| POST   | `/api/install/world/github/preview`                 | `{ url }`                      | 同上，对象是世界包                                           |
| POST   | `/api/install/world/github`                         | `{ token, acceptRisk: true }`  | 校验已确认的预览并安装世界                                   |
| POST   | `/api/install/{plugin,world}/github/update/preview` | `{ id, url? }`                 | 检查一个从 GitHub 安装的包有没有更新                         |
| POST   | `/api/install/{plugin,world}/github/update`         | `{ token, acceptRisk: true }`  | 应用已预览的更新                                             |
| DELETE | `/api/install/{plugin,world}/github/update/:id`     | —                              | 取消还没有应用的更新，返回 `{ ok: true }`                    |
| POST   | `/api/install/github/preview`                       | `{ url }`                      | 一次预览链接下的插件、世界或合集成员                         |
| POST   | `/api/install/github/batch`                         | `{ tokens, acceptRisk: true }` | 把已预览的包作为一个整体安装，失败时回滚本次写入             |
| POST   | `/api/install/collection`                           | multipart 字段 `file`          | 导入打包好的合集 ZIP                                         |
| GET    | `/api/install/plugins`                              | —                              | 列出用户插件目录中的包及可用的来源记录                       |

各端点接受什么、返回什么：

- `POST /api/install/plugin`：接受根目录有 `PLUGIN.md` + `package.json` 的 `.zip`，或多 runtime 布局的 `.zip`。返回 `201 { ok, kind: "plugin", id, restartRequired: true, hasServerCode }`。
- `POST /api/install/world`：接受根目录有 `world.yaml` + `WORLD.md` 的 `.zip`。返回 `201 { ok, kind: "world", id, restartRequired: false }`。
- `POST /api/install/plugin/github/preview`：返回固定的提交、摘要和签名预览。
- `.../github/update/preview`：返回 `{ status: "current" }`、`{ status: "pinned" }`，或 `{ status: "available", ... }` 加预览。更新端点的完整契约见[插件安装](./plugin-installation.md#http-契约)和[世界安装](./world-installation.md)。
- `POST /api/install/plugin/github`：返回 `201 { ok, kind: "plugin", id, restartRequired: true }`。
- `POST /api/install/github/preview`：返回 `{ collection, items, problems }`，见[插件安装](./plugin-installation.md#http-契约)。
- `POST /api/install/github/batch`：返回 `201 { ok, installed, restartRequired }`。
- `POST /api/install/collection`：响应和 batch 相同。

批量安装失败的撤回结果见[插件安装](./plugin-installation.md#多包预览和批量安装)：`details.rolledBack` 和 `details.retained` 分别列出已撤回和保留的包。

- `GET /api/install/plugins`：列表里包含还没有重启加载的插件。

`/api/install/world` 在写入世界记录之前检查 worldData 的 diagnostics：

- 有 error 时返回 `400`，删除本次新建的目录，不创建记录。修复后可以用同一个 ID 重试。
- warning 不阻止安装。
- 校验复用现有的 descriptor、source 和 schema 校验器，不使用本机的 overrides，也不执行社区插件的代码。

> [!IMPORTANT]
> **canonical 插件身份**：插件的唯一身份是 manifest 根上的 `id`，它就是运行期的 `pluginId`。
>
> - `package.json` 的包名只在去掉精确的 `plugin-` 前缀后参与一致性校验（`@covel/plugin-foo` 对应 `id: foo`）。不一致返回 `400`。
> - 内置保留 ID 的检查、安装目录和返回的 `id` 都使用这个 canonical ID。`@covel/plugin-narrator` + `id: narrator` 会命中保留 ID，返回 `409`。
> - 启动时的插件发现同样要求目录名等于 manifest 根 `id`。不一致的插件注册为 `hostState: "error"`，不加载任何 runtime、tool、hook 或 wire。

### 状态查询

| 方法 | 路径                              | 描述                                |
| ---- | --------------------------------- | ----------------------------------- |
| GET  | `/api/sessions/:id/state`         | 获取所有状态表                      |
| GET  | `/api/sessions/:id/state-patches` | 获取状态变更补丁列表（`{ items }`） |

恢复整个会话用 `GET /api/sessions/:id/view`。物化存档的创建、列表和读取统一使用 `/api/sessions/:id/snapshots` 资源，见 [Snapshot / Fork](#snapshot--fork)。

### 消息历史

| 方法 | 路径                              | 描述                                                      |
| ---- | --------------------------------- | --------------------------------------------------------- |
| GET  | `/api/sessions/:id/messages`      | 获取会话完整消息列表（`{ items }`；长会话优先用 `/page`） |
| GET  | `/api/sessions/:id/messages/page` | keyset 游标分页消息（最新窗口 + 向上加载更旧）            |
| POST | `/api/sessions/:id/messages/sync` | 按稳定 ID 幂等追加消息（外部客户端用）                    |

### 统一翻译层（Runtime Outputs / Interaction Records）

服务器为每次执行留两种规范记录，方便其它 runtime 和观测工具读取：

- 每次 runtime 执行，写一条 `RuntimeOutput`。
- 每次外部输入（玩家消息、插件界面操作、RPC 调用），写一条 `InteractionRecord`。

它们和 `trace_events` 并存。这两种记录给程序读；trace 给人在调试时看细节。

内置 Web 界面不调用下面这些查询端点（调试页用的是 `/api/traces/*` 和 `/api/sessions/:id/view`）。它们面向观测工具和 API 客户端。

| 方法 | 路径                                                      | 描述                          |
| ---- | --------------------------------------------------------- | ----------------------------- |
| GET  | `/api/sessions/:id/runtime-outputs`                       | 列出该会话的 runtime 输出记录 |
| GET  | `/api/sessions/:id/runtime-outputs/:outputId`             | 获取单条 runtime 输出记录     |
| GET  | `/api/sessions/:id/runtime-outputs/:outputId/full-prompt` | 重建该次调用时的消息历史      |
| GET  | `/api/sessions/:id/interaction-records`                   | 列出该会话的外部输入记录      |

查询参数：

| 端点                  | 可用的过滤参数                                      |
| --------------------- | --------------------------------------------------- |
| `runtime-outputs`     | `?runtimeId=`、`?pluginId=`、`?since=`、`?limit=`   |
| `interaction-records` | `?type=`、`?source=`、`?targetPluginId=`、`?limit=` |

- `runtime-outputs` 列表按 `timestamp` 降序返回。
- `full-prompt` 从 `turn_messages` 重建历史，只是尽力而为：不含 system prompt 和注入段。
- runtime 声明了 `io.concealed` 时，前两个端点返回的记录里 `results` 是空数组，`metaData.toolCallList` 各项的 `input` / `output` 是 `null`。

**`RuntimeOutput` 结构**：

```ts
{
  id: string,
  sessionId: string,
  turnId: string,
  runtimeResultId?: string,  // 对应 turn_results.runtimeResults 中该 runtime 的 runId
  pluginId: string,
  runtimeId: string,         // "{plugin}" 或 "{plugin}/{runtime}"
  timestamp: string,
  results: [{ text: string, structured?: unknown }],
  metaData: {
    turn: number,
    preGameDone?: boolean,                  // Pre-Game runtime 声明自身初始化已完成
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

> [!NOTE]
>
> - 这两种记录的写入是尽力而为的。写入失败只记一条警告日志，不会让回合失败。
> - `full-prompt` 只回放 `turn_messages`。会话做过压缩（compaction）后，结果也不完全精确。粗略调试够用；要精确重建或审计，请读 `trace_events`。

### 插件数据（Plugin Data）

> [!NOTE]
> 内置 Web 界面只用这里的 GET 端点读取插件数据（右侧面板、消息区界面、插件数据缓存）。PUT / DELETE 是给管理工具和 API 客户端的写入口。插件 runtime 自己写数据时，推荐用 plugin-data 工具、插件 RPC 或 proposal。

| 方法   | 路径                                                      | 描述                                    |
| ------ | --------------------------------------------------------- | --------------------------------------- |
| GET    | `/api/sessions/:id/plugin-data`                           | 一次列出会话内所有已激活插件的可读数据  |
| GET    | `/api/sessions/:id/plugin-data/:pluginId`                 | 列出某插件的全部数据                    |
| GET    | `/api/sessions/:id/plugin-data/:pluginId/_index`          | 列出某插件各 namespace 下的 key，不含值 |
| GET    | `/api/sessions/:id/plugin-data/:pluginId/:namespace`      | 列出某 namespace 下的数据               |
| GET    | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 获取单条数据                            |
| PUT    | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 写入或更新数据                          |
| DELETE | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | 删除数据                                |

会话级列表（第一行）：

- `items[]` 的每一项带 `pluginId`。Web 客户端用它一次恢复全部插件数据。
- 只包含会话已激活、并且已注册的插件。未激活插件的数据仍可以用按插件的路径读取。

三种列表（会话级、按插件、按 namespace）用同一套规则：

- 可见性相同：`_hidden.*` 和归内核所有的行不返回；维度行只返回公开的形状。
- 会话访问校验相同：托管部署下需要 owner token。

以 `_` 开头的 namespace 保留给内核：

- PUT / DELETE 和通用的 plugin-data 工具不能修改 `_dimensions` 和 `_dimension-settlements`。
- `_hidden.<namespace>`（`visibility: hidden` 的世界数据）不出现在列表、`/state` 和 discovery 里。单条读取返回 404。
- 玩家修改维度走 [manual runtime RPC](#维度编辑与待结算恢复)。公共读取用 session view，不去扫描提供者的私有规则。

### 插件记忆

故事记忆由 `memory` 插件管理，内核没有单独的记忆 CRUD 路由，也没有记忆块的专用存储表。

读取：

- 已提交的记忆块：`GET /api/sessions/:id/plugin-data/memory/blocks`。
- 世界定义：该插件的 `definitions/world` 记录。

记忆怎么产生、怎么用：

- 后台提取是一个 detached runtime，声明了 `before-next-execution` 屏障，所以下一次执行会等它完成。
- 已提交的记忆块通过 `prompt.segment@1` 进入后续提示词。

插件自己读写数据：

- 在插件内，用绑定了当前会话和插件的 `ctx.pluginData`，或 RPC 里的 `ctx.store`。
- 插件要提供自定义编辑操作时，必须在 `contributes.actions` 里声明，并通过通用的 plugin-RPC 路由调用。
- 公共服务只能访问提供者自己的只读快照。

### Lorebook

这一组端点对会话里的 lorebook 词条做增删改查。

词条通常由插件通过 proposal 提交写入（存储层的 `lorebook_entries` 表）。这里的管理端点给玩家界面和程序用，**不走提案系统**。

词条归谁所有：

- 词条的身份键是 `(sessionId, owner, entryId)`。
- `owner` 是 `{kind:"world"}`、`{kind:"player"}` 或 `{kind:"plugin",pluginId}`。不同所有者可以用相同的 ID。
- 列表包含所有所有者的词条。
- 这里的创建、更新和删除固定作用于 `player` 所有者，不能覆盖世界导入的词条或插件的词条。
- 插件 `lorebook.upsert` 的所有者由提案来源决定。

| 方法   | 路径                                  | 描述                                              |
| ------ | ------------------------------------- | ------------------------------------------------- |
| GET    | `/api/sessions/:id/lorebook`          | 列出该会话的全部词条，按 `insertionOrder` 升序    |
| POST   | `/api/sessions/:id/lorebook`          | 创建词条                                          |
| PUT    | `/api/sessions/:id/lorebook/:entryId` | 完整替换词条，或按指定 id 创建                    |
| PATCH  | `/api/sessions/:id/lorebook/:entryId` | 切换词条的 `enabled`，body `{ enabled: boolean }` |
| DELETE | `/api/sessions/:id/lorebook/:entryId` | 删除单条词条                                      |

响应：

| 方法     | 响应                                                                       |
| -------- | -------------------------------------------------------------------------- |
| `GET`    | `{ items: LorebookEntryRecord[] }`（类型见 `packages/store/src/types.ts`） |
| `POST`   | `201` 和 `LorebookEntryRecord`                                             |
| `PUT`    | `LorebookEntryRecord`                                                      |
| `PATCH`  | `{ ok: true, entryId, enabled }`                                           |
| `DELETE` | `{ ok: true }`                                                             |

会话不存在或 `entryId` 不存在时返回 404。这组端点没有功能开关，始终启用。

禁用一条词条（`enabled: false`）的效果：

- 它被完全排除：自动注入、archival 关键词检索和向量检索都不再用它。不用等后台 ingestion 清理旧向量。
- 管理列表仍然包含它。禁用不删除记录，也不改变 `(sessionId, owner, entryId)` 的归属。
- 重新启用后恢复可检索。关键词检索不依赖索引，立即可用；如果索引已被清理，语义检索要等后续 ingestion 重建后才恢复。

内置界面目前不使用这组端点：右侧面板的“世界”标签页显示的是 WORLD.md（见 [ui-panels.md](./ui-panels.md)）。插件可以在自己的 `ui.right` JSON spec 里使用它们。

### Suspend / Resume

| 方法   | 路径                                                 | 描述                                         |
| ------ | ---------------------------------------------------- | -------------------------------------------- |
| POST   | `/api/sessions/:id/suspensions/:suspensionId/resume` | 用提交的 data 重新启动该挂起项对应的 runtime |
| GET    | `/api/sessions/:id/suspensions`                      | 列出当前会话所有未解决的挂起项               |
| DELETE | `/api/sessions/:id/suspensions/:suspensionId`        | 放弃一个挂起项（删除记录）                   |

### Snapshot / Fork

> [!NOTE]
> 服务端已经支持手动快照、快照列表和 fork。内置 Web 界面还没有对应的操作界面，它用 `GET /api/sessions/:id/view` 做恢复和重连。

| 方法 | 路径                                      | 描述                                                     |
| ---- | ----------------------------------------- | -------------------------------------------------------- |
| POST | `/api/sessions/:id/snapshots`             | 创建一份手动快照（kind=`manual`）                        |
| GET  | `/api/sessions/:id/snapshots`             | 分页列出快照元数据（auto / manual / fork，不含 payload） |
| GET  | `/api/sessions/:id/snapshots/:snapshotId` | 按 id 获取单个快照（含完整 payload）                     |
| POST | `/api/sessions/:id/fork`                  | 从指定 `snapshotId` 生成一个新会话                       |

`POST /api/sessions/:id/fork`：

- 新会话（child）拷贝快照里的状态，以及截至 cursor 的消息。
- 响应里一次性返回 child 的 `ownerToken`。

自动快照被刷新时：

- 同一会话内刷新已有的自动快照，快照 ID 不变，payload 和采集时间 `createdAt` 会更新。
- 单条读取和元数据分页都按更新后的采集时间排序。

fork 和社区插件的授权：

- fork 不继承社区插件的服务端代码授权（community server-code grant）。child 里对应的插件保持未激活，需要运维方在新会话里重新启用并批准。
- 快照绑定的维度 provider 是社区插件时，child 在创建时无法启用它：
  - 快照里有该 provider 的维度数据或结算回执：fork 返回 `409 { "code": "dimension_provider_required" }`，不创建子会话。
  - 快照里没有维度数据：子会话正常创建，但不带这个绑定。
- 进程重启后，易失的授权同样不会恢复。`GET /api/sessions/:id/plugins` 把缺少当前授权的社区插件显示为未激活（`approvalRequired: true`），但保留会话里保存的插件选择，方便之后重新授权。

### 角色数据

> [!NOTE]
> 内置 Web 界面主要通过 `GET /api/sessions/:id/view` 拿角色视图。这一节的端点是轻量的读取和管理 API。在插件里，一次追踪一批角色的 runtime 推荐用 `sync-characters` 工具；其它插件可以按需使用底层的 `create-character` / `update-character`，以及读取工具 `list-characters` / `get-character`。

角色 `id` 只需要在当前会话内唯一。不同会话可以放心使用同一个 ID。

| 方法 | 路径                           | 描述             |
| ---- | ------------------------------ | ---------------- |
| GET  | `/api/sessions/:id/characters` | 获取会话角色列表 |
| POST | `/api/sessions/:id/characters` | 创建或更新角色   |

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

下表里的“托管部署”指 `DEPLOYMENT_TIER` 为 `demo` 或 `commercial`。

| 方法 | 路径                     | 描述                                               |
| ---- | ------------------------ | -------------------------------------------------- |
| POST | `/api/ai/ping`           | 测试 LLM 提供商连通性                              |
| POST | `/api/ai/models`         | 读取服务商端点提供的模型 ID；托管部署需运维 token  |
| GET  | `/api/ai/protocols`      | 可配置的协议：内置协议和已加载插件注册的文本协议   |
| POST | `/api/ai/generate-world` | AI 生成世界包；托管部署需运维 token                |
| POST | `/api/ai/revise-world`   | 按一句话修改应用内创建的世界；托管部署需运维 token |

### 模型数据库（Model DB）

| 方法 | 路径                                                       | 描述                                 |
| ---- | ---------------------------------------------------------- | ------------------------------------ |
| GET  | `/api/model-db`                                            | 获取模型数据库信息                   |
| GET  | `/api/model-db/search?q=xxx`                               | 搜索模型                             |
| GET  | `/api/model-db/lookup?model=xxx&provider=yyy&protocol=zzz` | 查找模型能力、匹配来源和价格性质     |
| POST | `/api/model-db/refresh`                                    | 刷新模型数据库；托管部署需运维 token |

`GET /api/model-db/search` 返回 `{ items: ModelSearchResult[] }`。

`GET /api/model-db/lookup`：

- `model` 被当作不透明的 ID，服务器不会改写你实际请求用的模型 ID。
- `matchedModelId`、`matchKind` 和 `candidates` 只说明能力资料是怎么匹配上的。
- `source` 是 `known`、`model-database` 或 `protocol-default`。
- `pricingKind=reference` 表示这是通过聚合服务商匹配到的上游模型参考价，实际账单可能不同。
- `reasoning` 返回按上游模型家族识别出的思考强度档位、默认值和家族名称，供生成参数界面使用。

`POST /api/model-db/refresh`：

- 在线获取 LiteLLM 的最新数据。
- 在桌面和自部署环境中，数据会写入用户配置目录。之后启动时，这份缓存优先于安装包自带的固定快照。
- 成功返回 `{ ok: true, count, persisted }`。
- 上游下载或解析失败返回 `502 { error, code: "model_db_refresh_failed" }`。

### Trace 调试

| 方法 | 路径                                | 描述                                                        |
| ---- | ----------------------------------- | ----------------------------------------------------------- |
| GET  | `/api/traces/:sessionId`            | 会话最近的 trace 事件，一次最多 5000 条，`?cursor` 读更早的 |
| GET  | `/api/traces/:sessionId/turns`      | 同一窗口按 Turn 分组                                        |
| GET  | `/api/traces/:sessionId/turns/page` | 最近事件窗口分组为 Turn + 游标（向上加载更旧）              |

### 媒体管理

| 方法 | 路径                                | 描述                                                    |
| ---- | ----------------------------------- | ------------------------------------------------------- |
| GET  | `/api/media/:id?token=<signed>`     | 按内容寻址下载媒体（校验 HMAC token 和会话引用）        |
| GET  | `/api/sessions/:id/media-token?id=` | 为指定 mediaId 颁发短时签名 token，供上面的下载端点使用 |
| POST | `/api/media?sessionId=<id>`         | 玩家上传图片，返回 `201 { id, mime, size }`             |
| POST | `/api/media/cleanup`                | 破坏性的维护端点，默认禁用                              |

`POST /api/media?sessionId=<id>`（上传图片）：

- body 是文件的原始字节，`Content-Type` 是文件的 MIME。
- 只接受 `image/*`，大小不超过 20MB。
- 字节必须以 PNG、JPEG、GIF、WebP、AVIF 或 BMP 的文件头开头，否则返回 400。
- 入库的 MIME 取自文件头判定的类型，不取请求头。
- 图片按内容寻址入库，并记下会话的所有权和引用。

> [!WARNING]
> `image/svg+xml` 一律以 400 拒绝。SVG 是可执行的内容类型，内联渲染时会在应用的源下执行脚本。

`POST /api/media/cleanup`（清理媒体）：

- 默认禁用，用 `COVEL_MEDIA_CLEANUP_ENABLED` 打开。
- `demo` 层级需要运维 token。
- `commercial` 层级返回 503。
- `dryRun:false`（真正删除）还要带请求头 `X-Confirm-Cleanup: yes`。

### 配置信息

| 方法 | 路径                           | 描述                                                                        |
| ---- | ------------------------------ | --------------------------------------------------------------------------- |
| GET  | `/api/presets`                 | 列出配置的模型预设（`{ items }`）                                           |
| GET  | `/api/plugins`                 | 列出插件（`PluginSummary`）                                                 |
| GET  | `/api/worlds/:id/plugin-plan`  | 返回某个世界的插件方案 `WorldPluginPlan`                                    |
| GET  | `/api/ui-specs?sessionId=<id>` | 列出插件的 UI 声明，按 slot 分组                                            |
| GET  | `/api/llm-config`              | 返回 slot 配置与能力信息                                                    |
| POST | `/api/llm-config/reload`       | 重读 `llm.toml` 并应用，无需重启                                            |
| GET  | `/api/provider-keys`           | 返回哪些 provider 配置了密钥，不含密钥内容                                  |
| GET  | `/api/config/info`             | 返回当前部署信息（`isDesktop`、`covelHome`、`dataRoot` 等）                 |
| GET  | `/api/config/server-settings`  | 所有层级：返回服务端设置的生效值、来源和能否设置                            |
| PUT  | `/api/config/server-settings`  | 仅 `self` 层级：保存服务端设置                                              |
| GET  | `/api/config/keys`             | 仅桌面：以 `{ items: string[] }` 列出已配置的 provider（不返回值）          |
| PUT  | `/api/config/keys`             | 仅桌面：写入 `<covelHome>/keys.env`；body `{ provider: value }`             |
| GET  | `/api/config/settings`         | 仅桌面：读取 `<covelHome>/settings.json`（统一的 SettingsStore）            |
| PUT  | `/api/config/settings`         | 仅桌面：原子写 `settings.json`；body `{ entries: Record<string, unknown> }` |
| GET  | `/api/config/proxy`            | 仅桌面：读取出站请求的代理模式与生效状态                                    |
| PUT  | `/api/config/proxy`            | 仅桌面：写入代理并立即应用                                                  |
| GET  | `/api/app-update/latest`       | 仅桌面：查询 GitHub 上最新的稳定 Release                                    |
| PUT  | `/api/config/data-root`        | 仅桌面：改写 `config.toml` 的 `data_root` 行，需要重启服务器                |
| POST | `/api/config/open-folder`      | 仅桌面：打开 config / data / logs 目录，或 `llm.toml` / `keys.env`          |
| GET  | `/api/config/raw`              | 列出可以在应用内当文本编辑的配置文件                                        |
| GET  | `/api/config/raw/:name`        | 读取一个配置文件的文本和 `digest`                                           |
| PUT  | `/api/config/raw/:name`        | 校验并保存文本；body `{ content, baseDigest }`                              |

各端点的补充说明：

- `GET /api/plugins`：数据来自 registry 快照。加载失败的插件也会返回，是一条 `status: "error"` 的 item。它的 `error` 文字里，插件目录的服务器绝对路径写成 `<plugin>`（例如 `<plugin>/PLUGIN.md: …`）；完整原文只写进服务器日志。
- `GET /api/worlds/:id/plugin-plan`：服务端解析世界的插件策略、组合包和默认选择。
  - 各个 `requested` 和 `defaultPluginIds` 只含已安装的插件。
  - 世界请求了、但宿主没装的插件列在 `missing: [{ pluginId, packId? }]`。
- `GET /api/ui-specs`：带 `sessionId` 时只返回该会话已激活的插件；不带则返回全部插件。详见[下文](#get-apiui-specs)。
- `GET /api/llm-config`：`llm.toml` 解析失败时回退到默认配置，并附带 `error` 字段。
- `POST /api/llm-config/reload`：原地应用到运行中的 gateway，返回 `{ ok, slots, error? }`。
- `GET /api/provider-keys`：
  - 只返回 `{ providers: { [provider]: { configured: true } } }`。
  - 状态来自对所有 `*_API_KEY` 的动态扫描。不含原始或掩码后的密钥内容，桌面客户端也一样。
  - `demo` / `commercial` 层级**需要运维 token**，因为已配置的 provider 清单属于运维信息。
- `GET` / `PUT /api/config/server-settings`：这些是由服务端执行的设置（`scope: "server"`）。PUT 的 body 是 `{ entries: { [key]: value | null } }`，按注册表校验。详见上文 [Server settings](#server-settings)。
- `GET /api/config/proxy`：返回 `{ mode, url?, effective, systemAvailable }`。
- `PUT /api/config/proxy`：body 是 `{ mode: "direct" | "system" | "http" | "socks", url? }`。HTTP/S 和 SOCKS5 地址可以在 URL 里带认证信息。
- `GET /api/app-update/latest`：通过当前代理查询，返回 `{ version, name, publishedAt }`。
- `GET /api/config/raw`：可编辑的文件是 `llm.toml`，桌面模式下还有 `config.toml`。返回 `{ items: [{ name, path, exists, applies }] }`。
- `GET /api/config/raw/:name`：文件不存在时，`content` 是一份起始内容。
- `PUT /api/config/raw/:name`：`llm.toml` 保存后立即重载。

`PUT /api/config/proxy` 按固定顺序执行，写盘失败不会留下半套状态：

1. 先准备并验证新的传输。
2. 再原子地把配置写入磁盘。
3. 最后在进程内生效。

磁盘写入失败时，原来的 dispatcher 和 GET 返回的状态都保持不变。

> [!NOTE]
> 给服务器代码的作者：底层 `prepareOutboundProxy()` 提供 `commit()` / `dispose()`，没有提交的传输由调用者释放；`configureOutboundProxy()` 用于立即应用。

#### GET /api/config/keys

`GET /api/config/keys` 和写入接口一样：设置了 `COVEL_DESKTOP_REST_TOKEN` 时，必须携带匹配的 Bearer token，否则返回 `401`。

#### PUT /api/config/keys

仅桌面可用。把 provider 密钥写入 `<covelHome>/keys.env`。

- body 是 `{ provider: string | null }`。空字符串或 `null` 表示删除这个密钥。
- 整批输入先校验。值里有换行，或者是其它类型时，返回 `400`，文件和运行时都保持原状。
- 文件原子写入成功后，运行时的密钥才更新，立即对回合、连接测试和模型列表生效。外部环境（shell、`.env`、`.env.llm`）的密钥始终优先；删除或替换本地密钥只改变保存的副本，不清除或覆盖外部密钥。

桌面应用（Electron）保存密钥时的行为：

- 它提交完整的密钥列表。已有、但这次没出现的 provider 会被转成显式删除。
- 清空最后一个密钥时，文件和运行时的值一起清除。
- 只有连不上 sidecar 时才回退到本地保存。HTTP 请求被拒绝不会触发本地覆盖。

#### GET /api/ui-specs

返回插件的 UI 声明，按 slot 分组。前端在启动时调用它，用来动态构建右侧面板的标签页和消息区的 block 渲染器。

**查询参数：**

| 参数        | 类型           | 说明                                                                                                   |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `sessionId` | string（可选） | 指定后只返回该会话已激活的插件；会话不存在返回 `404 session_not_found`；省略时返回 registry 中全部插件 |

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

每个 slot 是一个数组，元素为 `{ pluginId, specs[] }`。`specs` 里的每一项是一个 json-render spec，从插件的 `ui/*.json` 文件加载。

**校验与 `specVersion`**：

- 聚合时，每个 spec 都做 Zod 校验（结构和 `specVersion`）。
- `specVersion` 可以省略，按 v1 处理。声明的版本高于服务端支持的版本（当前 `CURRENT_UI_SPEC_VERSION = 1`）会被拒绝。
- 一个 spec 校验失败，**不会影响整个响应**：只把它从所在的 slot 里去掉。
- 失败原因写在顶层的 `diagnostics[]` 里，每项是 `{ pluginId, runtimeId, slot, specIndex, specId?, issues[{ path, message, code }] }`，说明是哪个插件、哪个字段、什么问题。
- 带 `sessionId` 时，`diagnostics` 只包含该会话已激活的插件。

**开发热重载**：`POST /api/plugins/:id/reload` 重新加载一个社区插件。

- 请求 body：`{ "sessionId"?: string }`。
- 响应：`{ "ok": true, "pluginId": string, "generation": string }`。
- 只在开发环境、只对社区插件可用。需要通过安装 API 的鉴权，并且该会话当前持有服务端代码授权。
- 重载失败返回 `409 plugin_reload_failed`，旧的一代继续生效。
- 功能关闭时返回 `403 plugin_reload_disabled`。
- 已经开始的执行继续用旧一代的能力、handler 和 guard；之后的执行用新一代。
- 资源排空，以及哪些模块会重新加载，见[开发时单插件热重载](./plugin-extensions.md#开发时单插件热重载)。

**读取模型**（这些数据从哪里来）：

- UI 声明来自启动时发布到 registry 的 manifest 快照。静态的 `ui/*` 资源按这份快照惰性加载并缓存。
- runtime 的 UI 资源目录和文档路径，取自 discovery 快照里保存的实际 `PLUGIN.md` / `RUNTIME.md` 路径，不从 runtime ID 里的斜杠推断目录。
- GET 请求不会重新发现插件，不会重读 `PLUGIN.md`，也不会把 UI 定义写入 `plugin_data`。
- 开发模式下，社区插件目录有变化时 registry 自动重载；也可以显式调用 `POST /api/plugins/:id/reload`。
- builtin 插件和生产环境需要重启服务器。

## 详细文档

下面按功能分组，逐个说明端点的请求、响应和错误。通用的响应外形、错误信封和鉴权方式见[概览](#概览)，这里不再重复。

### 健康检查

#### `GET /api/health`

检查服务器是否在运行，并报告当前使用的存储。

**响应:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "bootId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2025-01-15T10:00:00.000Z",
  "operatorTokenRequired": false,
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
        "id": "browser:idb:cache-media",
        "domain": "browser",
        "backend": "idb",
        "version": 1,
        "status": "managed-by-backend",
        "description": "Browser UI state and media caches use a lightweight IndexedDB schema; durable game data lives in the separate Dexie BrowserVault."
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

| 字段                                      | 说明                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `version`                                 | 应用版本号。                                                                                     |
| `bootId`                                  | 服务器启动 ID（UUID）。每次重启都会变，可以用它发现服务器重启过。                                |
| `operatorTokenRequired`                   | 管理请求是否校验运维 token。`DEPLOYMENT_TIER` 为 `demo` / `commercial` 时是 `true`。             |
| `storage.data.backend`                    | 服务端当前的数据存储后端：`memory` / `sqlite` / `pg`，默认 `sqlite`。                            |
| `storage.data.frontendMode`               | 前端数据模式。`local`：数据存在浏览器的 BrowserVault 里。`remote`：数据经服务端 API 存在服务端。 |
| `storage.media`                           | 媒体存储的配置值、实际后端、是否启用、是否持久。                                                 |
| `storage.migrations`                      | 已登记的迁移域、版本和状态。SQL 迁移由服务端执行，IndexedDB 迁移在浏览器升级数据库时执行。       |
| `vector.capable`                          | 当前后端能否做向量检索。取决于存储类型，以及向量扩展是否可用。                                   |
| `vector.driver`                           | `sqlite-vec` / `pgvector` / `in-memory` / `external` / `none`                                    |
| `vector.modelCount` / `vector.tableCount` | 已注册的 embedding 模型数量，以及对应的物理表数量（每个模型一张表）。                            |

Web 设置页根据 `operatorTokenRequired` 决定是否显示“运维访问”页。顶层的 `vector` 与 `storage.vector` 是同一份数据。

### 世界管理

#### `GET /api/worlds`

列出所有已加载的世界。每一项是**摘要**（`@covel/shared` 的 `WorldSummary`），只带世界列表、卡片和会话准备页头部要显示的字段，不带大块内容。

摘要里有什么、没有什么：

- 没有 `lore` 和 `dimensions`。
- `metadata` 只保留这些键：`source`、`storage`、`packageManaged`、`generated`、`cover`、`accentColor`、`supportedLocales`、`packageInfo`、`defaultViewMode`、`pluginSettings`，以及 `localizedText` 里的 `name` / `description`。
- 各语言的设定正文 `localizedText.lore` 不在摘要里。
- 其余键（`dimensions`、`embeddedCharacters`、`embeddedLorebook`、`characterSchema`、`pluginPolicy`、`worldData` 等）要用 `GET /api/worlds/:id` 读完整记录。
- 世界的插件策略解析结果见 `GET /api/worlds/:id/plugin-plan`。

内置四个世界的列表约 3.9 KB。

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
        "supportedLocales": ["zh-CN", "en-US"],
        "cover": "media/gallery/cover.webp",
        "accentColor": "#5b8def",
        "packageInfo": {
          "version": "0.3.0",
          "author": { "name": "Covel Contributors" },
          "license": "MIT"
        },
        "localizedText": {
          "name": { "en-US": "Mistport" },
          "description": { "en-US": "A fantasy world above the clouds..." }
        }
      },
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

#### `GET /api/worlds/:id`

读取一个世界的**完整记录**：`lore`、`dimensions` 和全部 `metadata`。列表只返回摘要，所以需要设定正文或维度的地方（会话准备页、世界详情、世界编辑器）读这一条。

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
    "pluginPolicy": {
      "presetId": "traditional-story",
      "requested": ["pregame", "world-init", "char-creator"],
      "recommended": ["narrator", "guide"],
      "preferredTags": ["mode:traditional-story"],
      "avoidedTags": ["mode:dialogue"]
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
  "error": "World not found"
}
```

#### `POST /api/worlds`

创建一个世界记录。

- `id` 可以省略，服务端会生成 `world-<uuid8>`。
- `id` 已存在时不会覆盖，返回 `409 world_already_exists`。
- 修改已有世界用 `PATCH /api/worlds/:id`。

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

**响应 201:**

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

导出作者写的全部维度定义（含 `schema`、`initialValue` 和可选的 `updateRule`），格式是 YAML 或 JSON。它导出的是定义，不是某个会话里维度的当前值。

**参数:**

| 参数     | 位置 | 说明                    |
| -------- | ---- | ----------------------- |
| `id`     | 路径 | 世界 ID                 |
| `format` | 查询 | `yaml`（默认）或 `json` |

**响应:** 以 `Content-Disposition: attachment` 返回维度数据文件。

**错误:**

| 状态码 | 什么时候                      |
| ------ | ----------------------------- |
| 400    | `format` 不是 `yaml` / `json` |
| 404    | 没有这个世界                  |

#### `POST /api/worlds/:id/dimensions/import`

用请求里的内容**整体替换**世界的维度定义。

- 导入后，活跃的会话会收到“作者源已变化”的通知。
- 会话里的当前值不会自动重置。已有会话要显式调用同步端点来采用新定义，同步时会检查冲突。
- 任何合法的维度 ID 都用同一种定义格式。

**请求体:**

```json
{
  "dimensions": {
    "reputation": {
      "name": "声望",
      "schema": { "type": "integer", "minimum": 0, "maximum": 100 },
      "initialValue": 0,
      "updateRule": "完成居民委托后增加 5，只计已完成的委托。"
    }
  }
}
```

**响应:** 更新后的 WorldRecord。

**错误:**

| 状态码 | 什么时候                                                      |
| ------ | ------------------------------------------------------------- |
| 400    | 请求体里没有对象类型的 `dimensions`                           |
| 422    | 维度定义、schema 或初值校验失败。未知的 schema 关键字会被拒绝 |

校验不会替你转换类型，也不会补默认值。格式与限制见 [World Data](./world-data.md#动态世界维度dimensions)。

> [!IMPORTANT]
> 只接受上面这种统一的维度定义。用其他格式写的世界文件需要改写，受影响的开发世界、会话与快照需要重建；没有格式迁移，也没有读取回退。

#### `PATCH /api/worlds/:id`

部分更新一个世界。可以更新基础字段，也可以直接提交顶层的 `dimensions`。

行为：

- 顶层 `dimensions` 会写入 `metadata.dimensions`。
- `metadata` 是合并写入：没提到的同级字段保留原样。
- `dimensions` 与 `metadata.dimensions` 都会经过世界维度校验。

**请求体示例:**

```json
{
  "description": "更新后的描述",
  "dimensions": {
    "cityWall": {
      "name": "城墙耐久",
      "schema": { "type": "number", "minimum": 0, "maximum": 100 },
      "initialValue": 100,
      "updateRule": "只根据明确发生的损坏或修复更新；程度不明时保持原值。"
    }
  }
}
```

#### `POST /api/worlds/:id/sync-dimensions`

作者和工具用的接口，把世界当前的维度定义同步到 `sessionId` 指定的一个活跃会话。应用没有供玩家操作的入口。这个端点直接尝试写入，不支持 dry-run；想先预览，或者需要通用的同步选项，用 [`sync-data`](#post-apiworldsidsync-data)。

它只处理维度：使用 `world_data_import_ledger` 账本和受保护的 `_dimensions` 记录，不写 `entries`，也不写常驻 lorebook，也不清理其他导入的数据。

每个维度按下面的规则处理：

| 情况                                 | 结果                                     |
| ------------------------------------ | ---------------------------------------- |
| 定义没变                             | 保留已经演化的值，不重新应用初值。       |
| 新增的维度                           | 用合法的初值初始化。                     |
| 定义被修改或删除                     | 只有值还等于导入基线的记录可以直接应用。 |
| 值已演化、被手改，或还有待结算的义务 | 报告冲突，定义、值和版本都保持原样。     |

- 有冲突的维度保持原样并列在报告里，其余维度照常应用。
- 写入事务内会再校验一次，并发的写入不会被覆盖。
- schema 变了不会自动迁移当前数据。
- 成功后，公共读取会按已提交的当前值重新发布。

**请求体:**

```json
{ "sessionId": "mistport-abcd1234" }
```

**响应:**

```json
{
  "ok": true,
  "imported": true,
  "dryRun": false,
  "diagnostics": [],
  "planned": 2,
  "upserted": 1,
  "deleted": 0,
  "unchanged": 1,
  "conflicts": [],
  "mediaRefs": []
}
```

#### `POST /api/worlds/:id/world-data/preflight`

只读地预检一次 worldData 导入：告诉你会导入多少条、写到哪里，但什么都不写。

请求有两种写法：

- 传 `sessionId`：使用这个会话**已保存的 `activePlugins`**。这时请求里的 `plugins` 会被忽略。
- 只传 `plugins`：在创建会话之前，预检某一组插件选择。

预检不会加载也不会执行 `worldProjections` handler，所以 projection 的输出不计入 `planned` / `targets`。响应会带一条 warning，说明这部分推迟到真正导入或同步时执行。

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
      "target": "contract:character.blueprints@1",
      "sourceId": "cast",
      "pluginId": "character-blueprint",
      "namespace": "blueprints",
      "key": "kamishiro-mio"
    }
  ]
}
```

#### `POST /api/worlds/:id/sync-data`

作者和工具用的接口，把世界包里更新过的 worldData 同步到 `sessionId` 指定的一个已有会话。应用目前没有供玩家操作的同步入口。**默认只预览（dry-run）**，传 `dryRun: false` 才写入；实际写入要求会话为 `active`。

更新世界包、文件热更新、启用插件和批准插件运行服务端代码都不会自动调用它。接口使用会话已保存的 `activePlugins`，不启用插件，不重新运行开局流程，也不重写历史故事。玩家要使用新的开局数据，请新开会话；正文仍按[世界数据](./world-data.md)中“改文件后自动重载”的规则更新。

**请求字段:**

| 字段        | 类型    | 必填 | 说明                                                            |
| ----------- | ------- | ---- | --------------------------------------------------------------- |
| `sessionId` | string  | 是   | 要同步的会话，必须属于这个世界                                  |
| `dryRun`    | boolean | 否   | 默认 `true`。`false` 才写入                                     |
| `force`     | boolean | 否   | 覆盖普通导入 row 的 `modified` / `missing` 冲突。不绕过维度保护 |

**同步哪些数据:**

- 已有记录的覆盖和删除，只处理账本 `world_data_import_ledger` 里 `managed=true`、属于当前世界的 row；本次计划里的新记录也会导入并记入账本。
- 用 `valueHash` 判断玩家或插件有没有改过目标数据。
- 维度定义也在同一本账里，包括 inline 定义、`dimensionSources`，以及存储型世界的有效定义。

**冲突怎么处理:**

- 有冲突的 row 保持原样并列在 `conflicts` 里，其余 row 照常同步。`upserted` / `deleted` 是实际写入和删除的数量。
- 冲突不会拦住别的 row。玩过的会话总有已经演化的维度；如果冲突拦住全部同步，世界包后来新增的资料（例如立绘）就永远进不了旧会话。
- 维度的源没变时，不重置进度。
- 作者修改或移除了维度，而会话里的值已演化、被手改，或还有待结算的回执时，报告冲突。
- `force: true` 不解除这些维度保护，不触发结构迁移，也不强制重置。

**并发:**

- 读取 source、校验 schema 和运行 projection Worker 都在会话写锁之外完成。dry-run 全程只读。
- 真正写入时，服务端先取一把短锁，再重新核对世界、locale、活跃插件和审批范围。准备计划期间这些发生了变化，返回 `409`（`world_data_sync_plan_stale`）。

**请求体:**

```json
{ "sessionId": "haruka-academy-abcd1234" }
```

执行写入：

```json
{ "sessionId": "haruka-academy-abcd1234", "dryRun": false }
```

强制覆盖普通导入 row 的 modified/missing 冲突（不绕过维度保护）：

```json
{ "sessionId": "haruka-academy-abcd1234", "dryRun": false, "force": true }
```

**响应:**

```json
{
  "ok": true,
  "imported": true,
  "dryRun": true,
  "diagnostics": [],
  "planned": 12,
  "upserted": 2,
  "deleted": 1,
  "unchanged": 9,
  "conflicts": [
    {
      "target": "contract:character.blueprints@1",
      "key": "kamishiro-mio",
      "sourceId": "cast",
      "reason": "modified"
    }
  ]
}
```

**错误:**

| 状态码 | `code`                       | 什么时候                                       |
| ------ | ---------------------------- | ---------------------------------------------- |
| 400    | —                            | 缺少 `sessionId`，或会话不属于这个世界         |
| 404    | —                            | 会话不存在                                     |
| 409    | `world_data_sync_plan_stale` | 准备计划期间，世界、locale、插件或审批范围变了 |

#### `POST /api/worlds/:id/translate`

给一个世界包增加一种语言版本。

服务端做这几件事：

1. 找出这种语言还缺哪些文字。
2. 请配置好的模型翻译：先列出世界里的名字和术语，再译名字字段，最后译正文。同一个名字只有一种译法。
3. 把译文写成世界包里主文件旁边的语言文件：`world.<locale>.yaml`、`WORLD.<locale>.md`、`data/*.<locale>.yaml`。
4. 把这种语言加进 `world.yaml` 的 `supportedLocales`。

之后用这种语言创建的会话就使用这个版本。

**请求体:**

```json
{ "locale": "ja-JP", "idleTimeoutMs": 300000 }
```

| 字段            | 类型   | 必填 | 说明                                                                                          |
| --------------- | ------ | ---- | --------------------------------------------------------------------------------------------- |
| `locale`        | string | 是   | 要增加的语言标签                                                                              |
| `idleTimeoutMs` | number | 否   | 每次模型请求等待下一段输出的最长时间（毫秒）。含义和范围与 `POST /api/ai/generate-world` 相同 |

**限制:**

- 只写**用户世界目录**（`COVEL_USER_WORLDS_DIR`）里的世界包，也就是应用内生成的和安装的世界。
- 内置世界自带语言版本；只存在数据库或浏览器里的世界没有文件可写。这两种都返回 409。
- 译文是模型的草稿。人名、地名和语气需要人看一遍。
- 托管部署（`demo` / `commercial`）需要运维 token。

**写入的时机:**

- 模型生成期间，服务端不持有世界操作锁，也不写语言文件。
- 发布时才取锁。锁内核对世界的创建时间、包的实际路径与目录身份，在暂存副本里写语言文件和 `supportedLocales`，读回预检通过后替换目录并保存记录。模型等待期间你保存的编辑会保留。
- 写文件或读回失败时丢弃暂存副本；保存记录失败时恢复原包。媒体、作者文件和生成标记都随副本保留。
- 世界正在删除、已经删除，或用同一个 ID 重建过时，请求收到 SSE `error`。旧请求不会往新包里写文件，也不会清理新包的文件。

**响应:** SSE 事件流。

| `type`     | 字段                                     | 含义                                                               |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `progress` | `step`, `done`, `total`                  | `step` 为 `glossary`、`names`、`texts` 或 `long texts`             |
| `done`     | `world`, `total`, `translated`, `failed` | 重新加载后的 `WorldRecord`；原本缺多少条、译出多少条、多少条没译成 |
| `error`    | `message`                                | 失败原因；模型一条也没译出时也走这里，世界包不变                   |

**错误（流开始之前）:**

| 状态码 | `code`                     | 含义                                               |
| ------ | -------------------------- | -------------------------------------------------- |
| 400    | —                          | `locale` 不是语言标签，或 `idleTimeoutMs` 超出范围 |
| 404    | `world_not_found`          | 没有这个世界                                       |
| 409    | `world_not_translatable`   | 世界包不在用户世界目录里                           |
| 409    | `world_already_translated` | 这种语言已经没有缺的文字                           |
| 409    | `world_deleting`           | 世界正在删除                                       |

**流开始之后的失败:** HTTP 状态保持 200，失败用 `{ type: "error", message }` 表示。

- 未知的存储或 provider 错误：生产环境的 `message` 是 `Internal server error`，开发环境保留原始诊断。
- 等锁超时：`message` 是 `Session is busy, please retry`。
- 全部文本都被拒收：`message` 是第一条被拒的原因（没有翻译、回复不是 JSON、占位符被改动）。内部原因记在服务端日志里。
- 世界已删除或被替换：`message` 保留这条提示。

无论 `message` 怎么写，语言文件的发布仍是“要么全部写入，要么不写”。

#### `GET /api/worlds/:id/gallery`

列出世界包自带的图片。

世界包里 `kind: media` 的来源要到创建会话时才导入媒体库。世界列表和世界详情页还没有会话，所以这个端点直接从世界包读文件。

**有 `media/gallery.json` 时**，画廊就是这份清单：按清单顺序列出图片，并带上名称、简介和分类。清单字段见[画廊资料与前端使用](../worlds/art-direction.md#画廊资料与前端使用)。接口只读其中这些：

- `id`、`kind`（`hero` / `map` / `scene` / `still` / `portrait`；不认识的值按普通图片展示）。
- `filename` 与可选的 `webFilename`：相对 `media/` 的路径，必须是“一层目录 / 文件名”。有 `webFilename` 时展示它（体积小得多）。
- `name`、`description`、`background`、`location`：`gallery.<locale>.json` 里的译文会并成语言表，由查看者选语言。
- `spoilerLevel`：画廊在开始游玩之前展示，只列出没有声明或声明为 `opening` 的图片。

**没有这份清单（或清单无法解析）时**，列出世界数据描述符里公开的 `kind: media` 来源中的图片。`enabled: false` 和 `visibility: hidden` 的来源不列出。图片按来源顺序、文件名排序，没有名称和分类。

两种情况共同的规则：

- 只列 PNG / JPEG / WebP，最多 60 张。
- 读不出像素尺寸的文件不列出。
- 没有世界包的世界（只存在数据库或浏览器里）返回空列表。
- 世界不存在返回 404。
- 读权限与 `GET /api/worlds` 相同：这些图片是世界包的分发内容，不属于任何会话。

**封面与主题曲:**

- `world.yaml` 声明了 `cover`（`media/` 下一层目录里的图片）时，同一个文件接口也返回它，地址为 `/api/worlds/:id/gallery/<目录>/<文件名>`。世界记录的 `metadata.cover` 与 `metadata.accentColor` 原样带着这两项声明，不需要先读图集。
- `world.yaml` 声明了 `themeMusic` 且文件可以播放时（`media/` 下一层目录里的 `.mp3` / `.wav`），响应多一个 `themeMusic: { url, mime }`。地址形状与图片相同，由同一个文件接口返回。

**响应:**

```json
{
  "items": [
    {
      "id": "literature-clubroom",
      "source": "gallery",
      "url": "/api/worlds/haruka-academy/gallery/gallery/literature-clubroom.webp?v=mutk9d2a-4441o",
      "width": 1536,
      "height": 1024,
      "kind": "scene",
      "name": {
        "zh-CN": "文艺部的春日下午",
        "en": "Spring in the Literature Club"
      },
      "description": {
        "zh-CN": "旧社团楼三层的活动室里，稿纸、旧刊与海风等待下一次校稿。"
      }
    }
  ]
}
```

| 字段               | 说明                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `source`           | 地址的前半段。清单里的图片是 `media/` 下的目录名，否则是描述符里的来源 ID。 |
| `url`              | 带文件版本（修改时间和大小）。文件变了，地址就变。                          |
| `width` / `height` | 读自实际展示的文件。                                                        |

前端按 `kind` 使用图片：

| `kind`            | 用法                                                       |
| ----------------- | ---------------------------------------------------------- |
| `scene` / `still` | 可以铺满屏幕作背景                                         |
| `portrait`        | 作为人物图                                                 |
| `map`             | 只完整显示                                                 |
| `hero`            | 世界自己的封面。应用没有内置封面的世界用它开场             |
| 没有 `kind`       | 按宽高比区分：宽图（宽 ≥ 高的 1.2 倍）作背景，其余作人物图 |

#### `GET /api/worlds/:id/gallery/:source/:file`

返回一张图片（或世界主题曲）的字节。

- 只响应 `GET /api/worlds/:id/gallery` 会列出的文件。
- 其他路径一律 404，包括 `..`、符号链接、未列出的目录或来源，以及清单里超出开局范围的图片。

**缓存:**

- 响应带 `ETag`。`If-None-Match` 命中时返回 304。
- 地址里的 `v` 与当前文件版本一致时，`Cache-Control: public, max-age=31536000, immutable`；否则是 `no-cache`。

### 会话管理

#### `GET /api/sessions`

列出所有游戏会话。可以用 `?worldId=` 只看某个世界的会话。

> [!NOTE]
> **隐私门禁**：同时满足下面三条时，本端点固定返回 `{ "items": [] }`，防止公网共享部署下玩家互相枚举会话。
>
> - 服务器以 `STORE_BACKEND=memory` 运行（前端是 local 模式，服务端的会话只是执行回合用的临时副本）；
> - `NODE_ENV=production`；
> - 没有设置 `ENABLE_DEBUG_PAGE`。
>
> local 模式的前端不调用这个端点（它的列表读浏览器里的数据），所以产品功能不受影响。

**响应:**

```json
{
  "items": [
    {
      "id": "mistport-a1b2c3d4",
      "worldId": "mistport",
      "status": "active",
      "phase": "setup",
      "completedPlayerTurns": 0,
      "setupRuntimes": {},
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

| 字段           | 类型     | 必填 | 说明                                                                                   |
| -------------- | -------- | ---- | -------------------------------------------------------------------------------------- |
| `worldId`      | string   | 否   | 已存在、且没有在删除中的世界 ID（校验：`/^[a-z0-9_-]{1,64}$/i`）。省略时创建无世界会话 |
| `locale`       | string   | 否   | 玩家想用的内容语言，默认 `zh-CN`。见下方“内容语言”                                     |
| `plugins`      | string[] | 否   | 要激活的插件 ID 列表                                                                   |
| `id`           | string   | 否   | 客户端自定义的会话 ID。不提供时自动生成 `{worldId}-{uuid8}`                            |
| `loreOverride` | string   | 否   | 本次会话使用的世界背景文本。见下方“世界背景”                                           |

**内容语言（`locale`）:**

- 会话的内容语言必须是世界实际有的语言版本。世界有这种语言（或同语言、同文字的其他地区）的版本，就用那个版本；否则用世界自己的语言。
- 实际语言与请求的不同时，响应另带 `requestedLocale`（你请求的语言）。客户端据此提示玩家：这个世界没有该语言的版本，故事将用世界的语言进行。
- 世界的语言版本取自 `world.yaml` 的 `supportedLocales`；没声明时只有 `defaultLocale`。应用内生成的世界只有生成时的那一种语言。
- 语言在创建后锁定。之后的回合、手动 runtime 与后台任务都用它，请求改不了。

**世界背景（`loreOverride`）:**

- 它是字符串，格式与世界文档里的背景相同。空字符串表示显式清空。
- 它在创建会话的同一次操作里保存到会话的 metadata。
- 之后的开始冒险、刷新和恢复都使用会话保存的这份背景。它不会重新读取按世界共享的编辑草稿，也不随世界后续的编辑改变。
- 不传这个字段时，会话使用世界原文。已有的会话不会自动导入世界草稿。
- Web 准备页把当前显示的背景文本随创建请求传入。浏览器私有模式先把它存进 BrowserVault 的会话 checkpoint，建立服务端镜像时也传入同一个值。后台草稿保存失败不影响本次会话的选择。

**模型选择:** 会话不保存独立的 `presetId`。模型路由使用槽位配置、请求级覆盖与 `runtimeModelOverrides`。

**世界包里影响创建的字段:**

| 字段                          | 作用                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `metadata.pluginPolicy`       | 准备页的插件组合策略，字段为 `presetId` / `preferredTags` / `avoidedTags` / `requested` / `recommended` / `requires` / `packs` |
| `pluginPolicy.requires`       | 世界必需的契约 ID。见下方说明                                                                                                  |
| `metadata.packageInfo`        | 世界包的 `version` 和[作者信息](./plugins.md#作者信息)（`author`、`license`、`homepage`）。只用于世界卡片展示，不进入提示词    |
| `metadata.characterSchema`    | 创建会话时写入角色 schema（`types` / `attributes`），版本由内核管理                                                            |
| `metadata.embeddedCharacters` | 没有文件型 worldData 时，把通用的 `{id,name,aliases?,type,description?,fields?}` 记录导入会话的 `characters`                   |
| `metadata.embeddedLorebook`   | 没有文件型 worldData 时，导入归世界所有的会话 lorebook                                                                         |

补充说明：

- `metadata.pluginPolicy`：解析器结合插件包声明的契约依赖和授权状态，算出激活集。它不强制锁定 core 插件。
- `pluginPolicy.requires`：
  - 创建时，世界作为一个依赖方参与解析。某个契约只有一个提供者时，它会被自动加入。
  - 这些需求随会话保存在 `metadata.pluginSelection.requiredContracts`。之后的启停与重载沿用它，不再读取世界。
  - 没有已安装的提供者，或有多个提供者而请求里没有指定，返回 `400 { "code": "world_requirement_unmet", "details": { contract, code, candidates? } }`。
  - 玩家显式停用了提供者，或提供者是还在等授权的社区插件时，会话照常创建。
- 依赖缺失的插件：它依赖的契约没有提供者（例如玩家关掉了提供者）时，会话照常创建，这个插件自动停用。玩家要的和 `kind: core` 的这类插件仍写进 `activePlugins`，`GET /api/sessions/:id/plugins` 把它们列在 `unavailable`，依赖回来后自动恢复。规则见[会话插件选择](./plugins.md#会话插件选择)。
- `metadata.characterSchema`：Web 私有模式创建本地会话时写入同样的 schema。预设不合法时，会话不创建。
- `metadata.embeddedCharacters`：它不是插件的角色卡，不会产生插件数据的副本。
- `metadata.embeddedLorebook`：AI 生成的 `server-store` / `return-only` 世界用它携带资料与规则。

**响应 201:**

```json
{
  "id": "mistport-a1b2c3d4",
  "worldId": "mistport",
  "locale": "zh-CN",
  "status": "active",
  "phase": "setup",
  "completedPlayerTurns": 0,
  "setupRuntimes": {},
  "activePlugins": ["pregame", "narrator", "codex"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z",
  "metadata": {},
  "ownerToken": "e7b2c4d1-…"
}
```

响应是会话记录，加上一次性的 `ownerToken`。

**响应字段**:

| 字段                   | 类型                                   | 说明                                                                                                                               |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ownerToken`           | string                                 | 会话的 owner token，**只在这里返回一次**（服务端只存哈希）。什么时候必须携带见下方                                                 |
| `locale`               | string                                 | 会话实际的内容语言                                                                                                                 |
| `requestedLocale`      | string（可选）                         | 只在实际语言与请求不同时出现                                                                                                       |
| `pluginsWithoutLocale` | string[]（可选）                       | 已启用、但没有会话语言文字的插件 ID（只有英文标签，面板显示英文）。只是提示，不影响创建                                            |
| `status`               | `'active' \| 'paused' \| 'ended'`      | 会话生命周期状态                                                                                                                   |
| `phase`                | `'setup' \| 'playing'`                 | 会话处在开局准备还是正式游玩。激活集里有 setup runtime 时初始为 `setup`，否则为 `playing`；全部 setup runtime 完成后变成 `playing` |
| `completedPlayerTurns` | number                                 | 已提交的正式玩家回合数。setup 阶段的交互不计入；同一回合不会被重复计数                                                             |
| `setupRuntimes`        | `Record<runtimeId, SetupRuntimeState>` | 每个 setup runtime 的状态。见下表                                                                                                  |

`ownerToken` 什么时候必须携带：

- `DEPLOYMENT_TIER=demo|commercial`：所有会话作用域的端点都要求携带。
- `DEPLOYMENT_TIER=self`，且 `NODE_ENV=production`、实际存储为 MemoryStore：同样要求携带。
- 其余本地会话可以忽略它。详见[鉴权：Session owner token](#鉴权session-owner-token)。

`SetupRuntimeState` 有三种状态：

| `state`   | 字段                                                                                       | 含义                                                                                              |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `pending` | `generation`, `attempts`, `lastError?`                                                     | 还没完成                                                                                          |
| `done`    | `resolution: "completed" \| "waived"`, `generation`, `attempts`, `completedAt`, `warning?` | 已完成。`waived` 表示玩家跳过了它，按降级完成处理                                                 |
| `blocked` | `generation`, `attempts`, `reason`, `blockedAt`, `lastError?`                              | 用完了 `maxTriggerCount` 的尝试次数仍未完成。会话停在 setup 阶段，要用 `retry` / `waive` 端点解开 |

- `attempts` 是当前这一代里已经结束（且不是挂起）的尝试次数。
- `blocked.lastError` 是用完次数的那次尝试的错误。
- 三种状态都带 `pluginVersion`。插件版本变了，旧的 `done` 失效，runtime 以 `generation + 1` 重跑。

**错误:**

| 状态码 | `code`                    | 什么时候                                                             |
| ------ | ------------------------- | -------------------------------------------------------------------- |
| 400    | `plugin_rejected`         | 玩家要的插件因冲突等原因被拒（不包括依赖缺失）；`details` 是这条拒绝 |
| 400    | `world_requirement_unmet` | 世界必需的契约没有提供者，或有多个提供者而没有指定                   |
| 401    | `operator_token_required` | 托管部署（`demo` / `commercial`）下创建会话没有带运维 token          |
| 404    | `world_not_found`         | 提供了 `worldId`，但世界不存在                                       |
| 409    | `world_deleting`          | 世界正在删除                                                         |
| 409    | `session_already_exists`  | 客户端自定义的 `id` 已存在                                           |

- `id` 已存在时的响应体是 `{ "error": "Session already exists: <id>", "code": "session_already_exists" }`。创建不会覆盖原会话，也不会把原会话的子记录当成新会话的数据。
- 服务端在准备资源之前和提交会话时各检查一次世界。准备阶段不建立媒体归属；失败后留下的无引用字节由媒体 GC 回收，不会强删可能被其他会话使用的内容。

> [!NOTE]
> **Session ID 格式**: 自动生成的 ID 是 `{worldId}-{uuid8}`（如 `mistport-a1b2c3d4`），后缀来自 `crypto.randomUUID()`，防止被枚举。没有提供 `worldId` 时前缀是 `session`。

#### `GET /api/sessions/:id`

读取一个会话的完整信息。

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
  "phase": "playing",
  "completedPlayerTurns": 3,
  "setupRuntimes": {
    "pregame": { "state": "done", "resolution": "completed" },
    "world-init/schema-gen": { "state": "done", "resolution": "completed" }
  },
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

#### `GET /api/sessions/:id/view`

返回恢复或重连时用的聚合视图 `SessionSnapshot`：一次请求拿到消息、角色、插件和执行状态。顶层另有维度的公开快照和结算摘要：

| 字段                        | 说明                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `dimensions`                | `{id: {name,description?,schema,value,version}}`，当前值而非作者初值              |
| `dimensionProviderPluginId` | 可选，宿主绑定的活跃提供者 ID                                                     |
| `dimensionRecovery`         | 可选，宿主验证过的 `{editorRuntimeId,trackerRuntimeId}`                           |
| `dimensionSettlements`      | 回执摘要数组：`{source:{resultId,turnNumber},status,sourceTurnId,version,error?}` |

- 回执摘要的 `status` 是 `pending-settlement` / `settled` / `no-change` / `manual` / `skipped` 之一。
- 回执摘要的 `version` 是回执的版本，不是某个维度的值版本。
- 响应不包含维度规则、初值，也不包含完整回执的 `definitions` / `readVersions`。
- 会话还没初始化维度时，`dimensions` 可以为空。
- 已绑定的提供者缺失或读取失败时，端点明确报错，不会退回去读 `WorldRecord.metadata.dimensions`。

浏览器私有模式用相同的快照形状，并通过一次原子的 BrowserVault checkpoint 保存当前值、版本与结算义务。字段与冻结时序见 [World Model](./world-model.md#动态维度快照)。

#### `PATCH /api/sessions/:id`

更新会话字段。目前可以改 `status` 与 `runtimeModelOverrides`。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**请求体:**

```json
{
  "status": "paused",
  "runtimeModelOverrides": {
    "narrator": "story",
    "npc-graph/extractor": "fast"
  }
}
```

**字段说明:**

| 字段                    | 类型                              | 必填 | 说明                                              |
| ----------------------- | --------------------------------- | ---- | ------------------------------------------------- |
| `status`                | `'active' \| 'paused' \| 'ended'` | 否   | 会话生命周期状态                                  |
| `runtimeModelOverrides` | object                            | 否   | 给单个 runtime 指定模型槽位：`runtimeId → 槽位名` |

`status`：

- 不是合法枚举值时返回 400。
- `ended` 是终态，不能再改回 `active` / `paused`（返回 `409 session_ended`）。

`phase`、`completedPlayerTurns` 与 `setupRuntimes` 不能用 PATCH 修改，它们由服务端在回合提交时维护：

- `phase` 与 `completedPlayerTurns` 只在回合收尾的事务里写入。
- `setupRuntimes` 另外在这些时候更新：事务之后结算尝试次数（回滚的尝试仍然消耗次数）；执行器发现 `needs(scope: session)` 成环时预先阻断；调用 `retry` / `waive` 端点。

`runtimeModelOverrides`：

- key 是 runtime ID（`pluginId` 或 `pluginId/runtimeName`），必须匹配 `/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/`。
- value 是 `llm.toml` 里定义的槽位名，如 `story` / `utility` / `fast`。
- 每个回合执行前，框架读取一次这个字段。这里的显式选择最优先；没设置时按[实际选择优先级](./slots.md#实际选择优先级)往下找。
- 空对象 `{}` 清除所有覆盖。
- 插件列表与会话准备页会显示 runtime 声明的槽位。声明的槽位没配置时，界面提示补上 `[covel.<slot>]`，不会悄悄改绑到不相关的文本槽位。
- 这里只存槽位名。**Provider 与 API key 仍由前端保存，随请求放在 `X-Provider-Keys` 头里，不入库。**

**校验规则(runtimeModelOverrides):**

- 必须是对象。`null`、数组或其他类型返回 400。
- 最多 64 条。
- key 是空字符串、value 不是字符串、key 不匹配上面的格式：这些条目被静默丢弃。
- 请求里没有这个字段：现有的覆盖不变。

**响应 200:** 合并后的会话对象，含 `status`、`phase` / `completedPlayerTurns` / `setupRuntimes` 和 `runtimeModelOverrides`。

**错误:**

| 状态码 | `code`                   | 什么时候                                                                |
| ------ | ------------------------ | ----------------------------------------------------------------------- |
| 400    | —                        | `status` 不合法，或 `runtimeModelOverrides` 不是对象                    |
| 409    | `session_ended`          | 会话已经 `ended`                                                        |
| 409    | `session_deleting`       | 会话正在删除                                                            |
| 409    | `session_lifecycle_busy` | 要改 `status`，而 `SessionStart` / `SessionEnd` hook 还在运行。稍后重试 |

#### `DELETE /api/sessions/:id`

删除一个游戏会话，以及它的全部数据。不可恢复。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**响应 200:**

```json
{
  "ok": true
}
```

**响应 404:**

```json
{
  "error": "Session not found: <id>",
  "code": "session_not_found"
}
```

**删除按这个顺序进行:**

1. 在会话锁内：停止接收新的操作，写入删除标记，并轮换授权范围。
2. 从持久化的 `_runtime_jobs` 里找出还没结束的作业（`queued` / `claimed` / `running` / `committing`），等它们对应的后台 runtime 锁排空。
3. 不持有会话锁，运行只观察、不能改写的 `SessionEnd` hook。
4. 短暂持有会话锁：清理媒体存储里这个会话的归属和引用，然后级联删除数据存储里的记录。

旧的后台任务在最后检查会话范围和状态时会失败，所以删除之后不会有孤儿记录被写回来。媒体的会话归属和引用随删除清除，用同一个 ID 新建的会话不会继承旧媒体的访问权。

**冲突与重试:**

| 状态码 | `code`                   | 什么时候                                                                 |
| ------ | ------------------------ | ------------------------------------------------------------------------ |
| 409    | `session_lifecycle_busy` | `SessionStart` / `SessionEnd` 正在运行时改动生命周期。等 hook 完成后重试 |
| 409    | `session_deleting`       | 删除正在进行                                                             |

- hook 运行期间只挡住生命周期类的改动，同一会话的普通 API 不受影响。
- 排空作业、清理媒体或删除数据库任何一步失败时：会话保持 `paused`，授权范围保持已轮换，删除标记保持有效，普通的写操作继续被拒绝。
- 失败后服务端记下一次性的重试凭据。下一次 `DELETE` 可以接手继续删，并且不会重复触发已经跑完的 `SessionEnd`。
- 进程在恢复之前崩溃时，删除租约在 10 分钟后过期，之后新的 `DELETE` 可以接手。

**复用同一个 ID:** 只有旧会话完全删除之后，用同一个 ID 创建才会成功。删除还在 hook 或排空阶段时，创建返回 ID 重复的 `409`；等 `DELETE` 成功后再重试。

**较早创建的会话:** 没有私有身份标记的会话仍然可以删除。服务端只在请求隔离检查里，用它已有的 owner 哈希或持久化的 `(id, createdAt)` 作为它的身份。新建的会话总是带随机的身份标记，用同一个 ID 重建不会继承旧身份。

### Turn 执行

回合（Turn）是游戏的基本交互单元。玩家每发一次言就触发一个回合：服务器调度所有活跃的 runtime，收集模型输出并返回。

唯一的入口是 [`POST /api/actions`](#post-apiactions)。请求体、SSE 帧格式与开场接力见该章节。

**回合语义：**

- runtime 按 stage 依次执行：`setup` / `pre-turn` / `narrative` / `post-turn` / `audit`。一个 stage 全部结束后才开始下一个。
- 同一个 stage 里，互不依赖的 runtime 并行执行；有依赖的按 `needs` / `after` / `inputs` 排序。
- `session.completedPlayerTurns` 是已提交的正式玩家回合数。setup 阶段的执行会保存 `turn_results`，但不计入。`phase` 变成 `playing` 之后，第一个成功的玩家回合把它推进到 `1`。
- 服务端用 `commitExecution` 在一个事务里提交顶层执行和递归子执行的结果、journal 与挂起。事务里对每个结果先规范化、再提交状态；事务提交之后才发布 SessionEvent。
- runtime 的输出里有 `pendingInputs` 时，玩家的回答通过 `POST /api/actions` 的 `submit_interaction` 提交。同一个请求既保存回答，又运行读取它的回合。
- `schedule.completion.mode: detached` 只对通过安全检查的 `post-turn` / `audit` function 叶节点生效：
  - 它的上游结果、来源执行、模型和设置在原始回合里冻结；
  - 排队记录与原始回合在同一个事务里提交；
  - 静态检查认为不安全的声明仍在前台执行，并产生一条诊断。

### Staged Runtime 后台作业

这组端点管理调度器因 `schedule.completion.mode: detached` 创建的后台作业（`_runtime_jobs`）。它与 plugin-rpc 的 `execution: background` / `_jobs` 协议是两套东西，互不影响。

- 鉴权方式与其他会话端点相同（owner token）。
- 成功作业的 `result` 包含后台回合、执行和 runtime 的身份、耗时，以及 runtime 的 `output`。
- 内部冻结的输入与设置放在 `payload` 里，任何响应都不返回它。

**后台作业用谁的模型凭据:**

- worker 优先使用来源请求在内存里短期保留的 adapter / gateway。凭据不写进作业。
- 来源凭据过期，或进程重启之后：只有服务端解析出的有效模型配置带 API key 或认证头时，才改用服务端的 adapter。
- 否则作业保持 `queued`，等一个带凭据的新执行请求来提供服务，或者等到排队期限。
- 服务端有默认的 adapter 对象，不等于已经配置了凭据。

**“能不能跑”是怎么判断的:**

- 判断与执行使用同一套模型解析和环境密钥来源校验。
- 使用来源请求的服务时，两者都按那个请求的模型配置（槽位绑定、自定义预设）和凭据解析。
- 使用服务端 adapter 时，只按服务端配置解析，不受碰巧唤醒 worker 的其他请求影响。
- 它无法静态证明一个 function handler 会不会调用模型，也不会自动放行没有密钥的本地端点。
- 嵌入式宿主或测试可以通过 `ApiBootstrapConfig.canRunRuntimeJobWithServerServices` 显式确认自己的 adapter 可用。这个确认不改变运行时授权、会话身份校验或提交校验。

#### `GET /api/sessions/:id/runtime-jobs`

列出还保留着的作业，按 `enqueuedAt, jobId` 排序。

保留规则：

- 没结束的作业全部保留。
- 已结束的作业，每个 runtime 只保留最近 20 条。更早的由后台 worker 清理，清理之后不能再重试。

每个作业对象包含：

- `jobId` / `pluginId` / `runtimeId` / `status` / `origin` / `enqueuedAt` / `updatedAt` / `attempt`；
- 期限与租约时间；
- 后台回合和执行的身份；
- 结束后的 `result` / `error` / `reason`。

响应不返回内部的 `payload`，所以不会泄露冻结的输入、用户设置或审批范围。

```json
{
  "items": [
    {
      "schemaVersion": 1,
      "jobId": "job-uuid",
      "pluginId": "mimo-tts",
      "runtimeId": "mimo-tts/auto-narrate",
      "status": "running",
      "origin": {
        "activation": "stage",
        "sourceTurnId": "turn-uuid",
        "sourceExecutionId": "execution-uuid",
        "sourceRuntimeId": "mimo-tts/auto-narrate"
      },
      "enqueuedAt": "2026-09-03T06:00:00.000Z",
      "updatedAt": "2026-09-03T06:00:01.000Z",
      "attempt": 1,
      "maxQueueMs": 120000,
      "maxExecutionMs": 120000
    }
  ]
}
```

`status` 的全部取值：`queued | claimed | running | committing | succeeded | failed | timed_out | cancelled | stale | orphaned`。

`succeeded` 作业的 `result` 是后台回合、执行和 runtime 的摘要，不是插件数据的副本。插件数据以 proposal 提交之后的标准 API 和 SSE 为准。

#### `POST /api/sessions/:id/runtime-jobs/:jobId/cancel`

取消一个还没进入提交的作业。

- 可取消的状态：`queued` / `claimed` / `running`。服务端在会话锁内把它改成 `cancelled`，然后发出 `job-status.updated`。
- 成功时直接返回更新后的作业对象。
- 作业不存在、已进入 `committing` 或已经结束时，返回 `409`，`code: "runtime_job_not_cancellable"`。

取消之后作业不会再提交。已经发出的 provider 调用可能只能配合着停下来，但它迟到的结果进不了提交。

#### `POST /api/sessions/:id/runtime-jobs/:jobId/retry`

重试一个已经失败结束的作业。

- 可重试的状态：`failed` / `timed_out` / `cancelled` / `stale` / `orphaned`。会话必须仍是 `active`。
- 重试保留冻结的原始输入和稳定设置，并刷新这些：当前会话身份、插件审批范围、locale、`runtimeModelOverrides`。
- 重试创建一个**新的** `jobId`，状态是 `queued`；手动或事件激活的作业同时换用新的执行 `turnId`。原作业的终态不变。
- 成功时以 `202` 直接返回新作业对象。
- 不可重试时返回 `409`，`code: "runtime_job_not_retryable"`。

框架不会自动重跑失败类的作业，以免重复调用已经计费、但结果没有存下来的 provider。`queued` 作业在重启后会继续执行，包括正常关闭时放回队列的作业。

**作业是怎么执行的:**

- worker 先认领作业并持有一个可续期的租约。默认并发为 4；同一个 `(session, plugin, runtime)` 的作业串行执行。
- `maxQueueMs` 限制排队时间。
- `maxExecutionMs` 限制从 `running` 到 runtime 执行返回的时间。之后等会话锁来提交的时间不计入。
- 正常关闭时，还没进入 `committing` 的作业等这次执行返回后放回 `queued`，jobId 不变。已经进入 `committing` 的作业照常提交完。
- 重启后继续认领合法的 `queued` 作业。排队超时的作业标为 `timed_out`，租约过期的在途作业标为 `orphaned`。
- 提交之前再检查一次：会话是否仍 `active`、身份是否没变，插件的审批范围和版本，以及实际的 proposal effects。

检查失败时的终态：

| 终态     | `reason`                  | 什么时候                                 |
| -------- | ------------------------- | ---------------------------------------- |
| `stale`  | `pre-execution-rejected`  | 执行之前，会话或插件身份检查没通过       |
| `stale`  | `commit-barrier-rejected` | 到了提交这一步，会话或插件身份检查没通过 |
| `failed` | —                         | effect 检查或数据提交失败                |

这两种终态都不会写入任何游戏数据。

### 玩家交互

回合执行后可能产生 `pendingInputs`，例如表单、选择题、确认框。玩家的回答通过 `submit_interaction` action 提交。

**保存回答和开始后续回合是服务端的一次操作：**

1. 在同一把会话锁内校验回答，并确认它还没有被回答过。
2. 在一个事务里写入玩家输入和后续回合的 `turn.started`。
3. 在同一条 SSE 流上运行这个回合。回答填成的自然语言就是这个回合的玩家消息。

所以不存在“回答已保存、回合没有开始”的中间状态。第二个标签页或一次重试也不会让回合再跑一遍。

如果这个回合完成了最后一个 setup runtime，服务端会在同一条 SSE 流里，用新的 `turnId` 和独立的事务自动接着跑正式回合。也就是说，setup 完成和第一段正式叙事是两个回合。

#### `POST /api/actions` (`submit_interaction`)

提交一个或多个玩家交互的回答，并运行读取它们的回合。请求头、SSE 帧格式和开场接力见 [`POST /api/actions`](#post-apiactions)。

**请求体:**

```json
{
  "requestId": "req-003",
  "type": "submit_interaction",
  "sessionId": "mistport-a1b2c3d4",
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

| 字段                  | 类型         | 必填 | 说明                          |
| --------------------- | ------------ | ---- | ----------------------------- |
| `type`                | string       | 是   | 固定为 `"submit_interaction"` |
| `payload.turnId`      | string       | 是   | 产生该交互的 Turn ID          |
| `payload.submissions` | Submission[] | 是   | 提交数组，1–20 项             |

**Submission 对象:**

| 字段            | 类型                                       | 说明                                      |
| --------------- | ------------------------------------------ | ----------------------------------------- |
| `interactionId` | string                                     | 交互 ID，来自 Turn 输出的 `pendingInputs` |
| `type`          | `"form"` \| `"choice"` \| `"confirmation"` | 交互类型                                  |
| `values`        | object                                     | 玩家输入的值                              |

Submission 里的其他键会被丢弃。来源插件、字段定义和模板只从已提交的交互里读取。

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

**响应:** SSE 事件流。回答被接受时，第一个事件是 `interaction.submitted`，之后是一个普通回合的事件（`execution.started` … `execution.completed`）：

```json
{
  "type": "interaction.submitted",
  "turnId": "<后续回合的 turnId>",
  "payload": {
    "interactionTurnId": "a1b2c3d4-...",
    "results": [
      {
        "submissionId": "…",
        "interactionId": "char-creation-form",
        "values": { "name": "艾尔文", "class": "战士" },
        "filledNarrative": "旅人自称艾尔文，是一名孤儿出身的流浪剑客，以战士之姿行走江湖。"
      }
    ],
    "message": { "id": "…", "content": "旅人自称艾尔文，……" }
  }
}
```

| 字段                | 说明                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `interactionTurnId` | 产生该交互的回合。信封上的 `turnId` 是后续回合                                                                 |
| `results[].values`  | 服务端保存的值。客户端用它回填表单，而不是用玩家键入的文字                                                     |
| `message`           | 后续回合的玩家消息：`id` 是保存的 `turn_messages` 行的 ID，`content` 是各 `filledNarrative` 用换行连起来的文字 |

- `results[].values` 已经规范化：数字和布尔按字段类型转换，`selectedLabel` 取自原来的 option。
- 交互声明了 `submitBehavior.echoFilledNarrative: false` 时，它的叙事不计入 `message`。全部不计入时没有 `message`，回合不带玩家消息运行。

**拒绝:** 回答没有被接受时，流里只有一个 `error.occurred`，没有 `interaction.submitted` 和 `execution.started`。没有任何内容被保存，也没有回合开始。HTTP 状态是 200。

```json
{ "type": "error.occurred", "payload": {
    "message": "请填写“姓名”。", "code": "form_rejected",
    "details": { "issues": [{ "field": "name", "message": "请填写“姓名”。" }] } } }
{ "type": "error.occurred", "payload": {
    "message": "这项内容已经提交过了。……", "code": "interaction_already_submitted" } }
{ "type": "error.occurred", "payload": {
    "message": "Interaction not found: …", "code": "invalid_interaction_submission" } }
```

| `code`                           | 含义                                                       | 能否再次提交             |
| -------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `form_rejected`                  | 玩家填的值没有通过校验                                     | 能，改正后提交同一张表单 |
| `interaction_already_submitted`  | 这个 `(turnId, interactionId)` 已经有保存的回答            | 不要重发                 |
| `invalid_interaction_submission` | 客户端不该发出的请求：交互不存在、类型不一致、值的形状不对 | —                        |
| `form_validator_failed`          | 来源插件的表单校验器自己抛了错（不是正常返回拒绝原因）     | 能，没有写入任何内容     |

`form_rejected`：

- 校验的内容：必填、数字、范围、步长、选项、文本长度，以及来源插件的表单校验器。
- 文本长度与 `send_message.content` 用同一个上限：100 000 个字符（`MAX_PLAYER_MESSAGE_CHARS`）。
  - 单个 `text` / `textarea` 字段超过时，按字段拒绝。
  - 各字段填成的整段玩家消息超过时，作为整张表单的错误拒绝。原因是这段文字就是后续回合的玩家消息，回合失败后的重试也把它当作一条消息发送。
- `message` 是按会话 locale 写给玩家的文字，用字段的 `label` 指出哪一项、该怎么改。
- `details.issues` 列出每条拒绝原因 `{ field?, message }`。`field` 是表单字段的 `name`；没有 `field` 的是整张表单的错误。所有出错的字段一次全部列出。`message` 就是这些条目用换行连起来的文字。
- 客户端把每条消息显示在对应字段下面，并聚焦第一个出错的字段；整张表单的错误显示在字段上方。不要把它当成请求失败。

`interaction_already_submitted`：

- 同样是写给玩家的文字，不带 `details`。
- 不管这次的值与已保存的是否相同，都返回它。
- 回答它的那个请求同时开始了后续回合，所以客户端不重发。客户端从 `GET /api/sessions/:id/view` 的 `submittedInteractions` 取已保存的值来标记表单，并通过 `GET /api/sessions/:id/execution` 观察那个回合（运行中、已提交，或失败后可以由现有的重试再跑）。

`form_validator_failed`：

- `message` 是按会话 locale 写的固定文字。
- 插件抛出的原文只进服务端日志（带请求方法、URL 和堆栈），开发环境下也不发给客户端。

**流开始之前的 JSON 响应：**

```json
{ "status": "approval-required", "approvalId": "…", "pending": { … } }   // 202
{ "error": "…", "code": "invalid_action_request" }                       // 400，请求体不合 schema
{ "error": "…", "code": "form_provider_inactive" }                       // 400
{ "error": "…", "code": "form_provider_unavailable" }                    // 400
{ "error": "…", "code": "form_validator_undeclared" }                    // 400
{ "error": "Session not found: <id>", "code": "session_not_found" }      // 404
```

**需要授权时（202）:** 带插件校验器的表单，在服务端重启或授权被撤销之后提交，会先返回 **202** `approval-required`，请求来源插件的 `covel:plugin-server-code` 会话授权。

- 来源插件只从已提交交互的 `sourcePluginId` 读取，客户端不能指定。
- 批量提交可能依次请求多个插件的授权。全部授权并校验通过之后，才一次性写入。
- 拒绝授权时，表单内容保留。
- 来源插件已禁用或已卸载时返回 400，不会自动启用它。
- Web 在授权之后用同一个 `requestId` 重发同一份提交。托管部署同时需要运维 token。
- 授权检查先于“是否已回答”的判定。对一张已经回答过、来源插件的授权又已失效的表单再次提交，会先得到 202，授权之后才得到 `interaction_already_submitted`。

**连接中断:** 回合一旦开始，就在服务端运行到提交，与这条连接无关。

- 响应丢失的客户端不知道回答有没有保存，所以不重发。它轮询 `GET /api/sessions/:id/execution`，并从聚合视图的 `submittedInteractions` 把表单标成已提交。
- 后续回合失败时，`execution.retry` 给出的是 `send_message`（内容为那条玩家消息），没有玩家消息时是 `retry_turn`。重试不会再次提交回答。

**使用说明:**

- 只接受当前会话对话记录里已经提交的 assistant 交互。`turnId` / `interactionId` / `type` 必须与原交互一致。客户端不能凭空构造表单，也不能改写交互类型。
- 各类型的校验：
  - `form`：校验必填、字段集合和字段类型。
  - `choice`：`selectedId` 必须来自原来的 options；`selectedLabel` 由服务端按原 option 规范化。
  - `confirmation`：`confirmed` 必须是 boolean。
- 同一个 `(turnId, interactionId)` 只能回答一次。
  - 两个请求同时提交同一个交互时，会话锁让它们一先一后：先到的保存回答并运行回合，后到的收到 `interaction_already_submitted`。
  - 同一批里对同一个交互重复给出相同的值，合并为一条。
  - 批量提交先全部校验，再与 `turn.started` 在同一个事务里写入。
- `filledNarrative` 是把玩家输入填进模板后的**纯自然语言**文本，不含 JSON 结构。它作为后续回合的玩家消息写入 `turn_messages`，供叙事者参考。
- 模板由插件提供，占位符写作 `{{fieldName}}`。
- 已提交的交互没有模板时，生成一段简单的回退叙事，如 `[玩家输入] name: 艾尔文, class: 战士`。
- **本地化**：下面两样按**会话 locale** 解析。
  - `confirmation` 的 `{{confirmed}}` 取值（确认 / 取消）。
  - 回退叙事的前缀（`[玩家输入]` / `[玩家选择]` / `[玩家确认]` / `[玩家取消]`）。
  - 内置文案支持 `zh-CN`、`en-US` 和 `ru-RU`。指定了但不支持的 locale 回退到 `en-US`。
  - `en-US` 下是 `Confirm` / `Cancel` 与 `[Player input]` / `[Player choice]` / `[Player confirmed]` / `[Player cancelled]`。

### 插件 RPC 通道

#### `POST /api/sessions/:id/plugin-rpc`

向一个会话里的插件发一条结构化指令。它不走聊天输入，也不产生玩家回合。请求体的 `kind` 决定指令的种类：

| `kind`    | 请求体                                   | 做什么                           | 返回                         |
| --------- | ---------------------------------------- | -------------------------------- | ---------------------------- |
| `action`  | `{ kind, pluginId, action, payload }`    | 调用插件注册的一个 RPC action    | 一次 JSON                    |
| `runtime` | `{ kind, pluginId, runtimeId, payload }` | 手动运行一次 runtime             | 同步结果，或 `202` + `jobId` |
| `command` | `{ kind, commandId, input }` 或 `args`   | 执行会话命令目录里的一个命令     | 与 action 相同               |
| `event`   | `{ kind, pluginId, topic, payload }`     | 插件界面发出一个本插件声明的事件 | `eventId` 和排入的后台任务   |

##### action 级

调用插件在 `entry` 里用 `covel.registerRpc` 注册的 handler，或者框架默认 handler（如 `slash-debug`）。

- 插件必须在会话当前启用、并且现在能运行的插件里。服务端在审批前检查一次，取得会话锁后再检查一次。插件已禁用时返回 `404 plugin_not_active`，不执行 handler，也不新增审批。玩家确认过、但现在不能运行的插件（见 `unavailable[]`）同样返回这个错误，错误信息写明原因。旧面板迟到的请求同样受这个检查约束。
- `pluginId: "framework"` 表示框架默认 action。它不属于插件启用集，按各自的准入条件执行。`framework` 是保留 ID，没有插件能用它，所以这样的请求只会执行框架默认 action；写插件 ID 的请求也只会执行该插件自己注册的 action。
- handler 在会话锁内运行，时限 30 秒。超时后 handler 的 `ctx.signal` 中止，之后它对 `ctx.store` 的调用一律被拒绝。已在进行的存储调用先完成，再返回 `504 handler_timeout` 并放开锁。超时之前已经写入的数据保留，不会回滚。

##### runtime 级

手动运行一次目标 runtime。它走完整的回合流程：组装 prompt、工具循环、提交 proposal。由事件触发的下游 runtime 会在同一回合内接着运行；同一事件有多个订阅者时按 `name` 排序。

运行方式由 runtime 清单里的 `schedule.manual.execution` 决定：

- `sync`（默认）：等 runtime 跑完并提交 proposal，然后返回汇总 JSON。
- `background`：在会话锁内排入一条持久后台任务（`_runtime_jobs`，`origin.activation: "manual"`），立即返回 `202` 和 `jobId`。
  - 后台 worker 认领并执行任务，在同一个事务里提交写入和任务终态。
  - 状态通过 `job-status.updated` 事件和 `_runtime_jobs` 的 `plugin-data.changed` 事件推送。
  - 入口 runtime 发出的后台 follower 在同一个提交事务里排成事件任务（`origin.activation: "event"`），记录在父任务的 `result.deferredJobs` 里。

##### command 级

执行会话命令目录里的一个命令。有两种互斥的写法，执行的是同一个命令：

- `{ kind: "command", commandId, input }`：来自输入框，`input` 是完整的原始输入。
- `{ kind: "command", commandId, args }`：来自插件 JSON-RENDER 界面的 `invokeCommand`，`args` 是命名参数。

服务端会重新确认插件仍然启用，校验并归一化参数，再从清单决定调用哪个 action、注入哪些上下文。客户端不能提交 `pluginId` 或 `payload`，也不能扩大 context scope。

##### event 级

插件自己的界面（JSON-RENDER 或 `webview` 的 `emitEvent`）发出一个本插件声明的领域事件。

- `topic` 必须在这个插件的 `contributes.events` 里。`advertise: false` 的内部 topic 也可以。别的插件声明的 topic 一律返回 `404 event_not_declared`。
- `payload` 按该 topic 的 schema 校验，不合格返回 `400 event_payload_invalid`。
- 校验和审批通过后，会话里所有订阅该 topic 的 runtime（`trigger: { type: event, topic }`，可以属于任何已启用的插件）在同一个事务里排成事件任务：`_runtime_jobs`，`origin.activation: "event"`，`origin.sourceTurnId` 是本次发射的 `eventId`。后台 worker 带着 `ctx.triggerEvent` 执行它们，各自提交。
- 请求本身不执行 runtime。它返回 `200 { status: "ok", eventId, topic, deferredJobs: [{ jobId, runtimeId }] }`。没有订阅者时 `deferredJobs` 为空数组。
- 和手动运行 runtime 一样，点击就是触发决定。订阅者的 `startTurn`、`maxTriggerCount`、`cooldownTurns` 不参与判断。
- 社区插件按 `event:<topic>` 走审批。订阅者里的社区 runtime 还各需要与手动运行相同的两项授权：服务端代码和 `runtime:<name>`，否则 runtime 加载器会拒绝执行。请求每次只返回缺少的第一项（`202 approval-required`）。客户端批准后重试，直到全部具备才排入任务。
- 后台任务只在会话有可用模型凭据时执行（与其他后台任务相同），否则保持 `queued`。

##### 写入什么时候生效

| 调用方式                                | 写入时机                                                              | 失败时                               |
| --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| 插件注册的 RPC action（内置插件也一样） | 在会话锁内立即写入                                                    | handler 后面失败，已成功的写入不回滚 |
| 框架默认 action                         | 按各自的事务约定                                                      | 按各自的事务约定                     |
| runtime 级                              | `ctx.pluginData` 写入和领域 effects 作为 proposal，执行成功后统一提交 | 提交失败会回滚本次全部领域写入       |

需要多条记录一起成功或一起失败时，用 `trigger.type: manual` 的 function runtime。它直接运行 JS handler，不需要 LLM。手动触发不会顺带运行叙事 runtime；只有显式声明的调度关系（如事件链）才会继续触发下游。见[函数 runtime 契约](./plugins.md#输入和输出)。

##### action 的 `context.store`

action handler 拿到的 `context.store` 绑定在当前会话和当前插件上，只提供：

- `getSession()`
- `listTurnMessages(limit?)`：只返回最近的已提交消息，最多 200 条；省略 `limit` 时也是 200。
- 本插件的 `getPluginData` / `setPluginData` / `listPluginData`

没有 `savePlayerInput`。玩家提交只能由表单提交通道写入，并经过表单校验；action 不能伪造玩家输入。

##### 请求

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**请求体:**

action 级：

```json
{
  "kind": "action",
  "pluginId": "codex",
  "action": "regenerate",
  "payload": { "cardId": "shrine-of-stars" }
}
```

runtime 级：

```json
{
  "kind": "runtime",
  "pluginId": "dashscope-image-gen",
  "runtimeId": "dashscope-image-gen/prompt-generator",
  "payload": { "style": "cinematic" }
}
```

command 级，输入框写法：

```json
{
  "kind": "command",
  "commandId": "dice-check:roll",
  "input": "/roll 2d6"
}
```

command 级，JSON-RENDER 的结构化写法（`args` 与 `input` 互斥）：

```json
{
  "kind": "command",
  "commandId": "dice-check:roll",
  "args": { "notation": "2d6" }
}
```

| 字段                        | 类型    | 必填 | 说明                                                                     |
| --------------------------- | ------- | ---- | ------------------------------------------------------------------------ |
| `kind`                      | string  | 是   | `action` / `runtime` / `command` / `event`。服务端不会根据别的字段猜种类 |
| `pluginId`                  | string  | 否   | action / runtime / event 级的插件 ID。框架默认 handler 写 `framework`    |
| `action`                    | string  | 否   | RPC action 名，kebab-case。与 `runtimeId` / `commandId` 互斥             |
| `runtimeId`                 | string  | 否   | runtime 全名，如 `my-plugin/my-runtime`。与 `action` / `commandId` 互斥  |
| `commandId`                 | string  | 否   | 会话命令目录里的稳定 ID。与 `action` / `runtimeId` 互斥                  |
| `input`                     | string  | 否   | command 级输入框写法：完整的原始输入                                     |
| `args`                      | object  | 否   | command 级 JSON-RENDER 写法：命名参数                                    |
| `topic`                     | string  | 否   | 仅 event 级：本插件声明的事件 topic                                      |
| `payload`                   | unknown | 否   | 传给 handler 的输入数据                                                  |
| `expectsBackgroundFollower` | boolean | 否   | 仅 runtime 级。见下                                                      |
| `retryFromTurnId`           | string  | 否   | 仅 runtime 级。带着原回合的上下文重试，见下                              |

字段的补充规则：

- **必填字段随 `kind` 而定**：action 级要 `pluginId` + `action`；runtime 级要 `pluginId` + `runtimeId`；command 级要 `commandId`，再加 `input` 或 `args` 中的一个；event 级要 `pluginId` + `topic`。
- **command 级**不接受 `pluginId` 和 `payload`。`input` 与 `args` 必须提供一个，且只能提供一个。
  - `input`：服务端按命令声明重新分词、转换类型、校验。
  - `args`：未知字段、类型、`choices`、`required`、variadic 都按服务端的命令声明校验。
- **event 级**只接受 `pluginId`、`topic`、`payload`，其中 `payload` 必须是对象。
- **`payload`** 在 action 级是 handler 的输入；在 agent runtime 里是 manualPayload；在 function runtime 里是 `ctx.manualPayload`。
- **`expectsBackgroundFollower`**：一个 sync 的入口 runtime 如果只负责生成 prompt，并且预计会触发后台 follower，可以设为 `true`。框架会立即排入一条持久后台任务并返回 `202`，由 worker 执行入口 runtime 并排入 follower。这样界面不用等 prompt 的 LLM 调用结束就能显示任务。
- **`retryFromTurnId`**：服务端读取该回合已持久化的 `turn_results`，把里面记录的 runtime 输出当作本次执行的上游结果。目标 runtime 的 `io.inputs` / `schedule.needs` 因此按原回合的叙事解析（普通手动运行时这些都解析为空）。
  - 这些结果只当上下文用，不会被本次执行重复保存。
  - 找不到该回合：`404 retry_turn_not_found`。
  - 该回合没有提交成功（`commitStatus` 不是 `committed`，即已回滚或还没结算）：`409 retry_source_not_committed`。没提交的回合里的成功结果不能满足下游的 `needs` 条件。

**解析顺序(action 级):**

1. 插件在 `entry` 里注册的 action（按 `pluginId` 隔离）
2. 框架默认 action（全局）：`/debug` 用的 `slash-debug` 和 `/plugins` 用的 `slash-plugins`

**框架默认 action:**

| Action          | 说明                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| `slash-debug`   | 读取 `/debug` 声明的 session / runtime / model 上下文，并让客户端打开当前会话的调试页 |
| `slash-plugins` | 只接受 `framework:plugins` 命令上下文，打开当前会话的插件诊断视图，可带 `pluginId`    |

##### 响应

**响应 200 — action 级:**

```json
{
  "status": "ok",
  "result": {/* 取决于 handler */}
}
```

command 成功时用同一个结构，另外有这些约定：

- 命令声明了 `context` 时，响应顶层多一个 `environment`：action 完成后重新采集的最新环境，按 scope 裁剪过。
- handler 在 `ctx.environment` 里拿到的是执行前的快照。
- handler 在 `ctx.command` 和 payload 里拿到同一个对象：`{ invocationId, commandId, command, canonical, raw, argv, args, source }`。
- `source` 是 `"composer"`（输入框）或 `"plugin-ui"`（JSON-RENDER）。两个入口共用 `commandId`、类型化的 `args`、审批和 handler。

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
      "output": {/* materialized runtime output */}
    }
  ],
  "durationMs": 3480
}
```

- 声明了 `io.concealed` 的 runtime，在这里和失败响应的 `details.runtimeResults` 里，`output` 都是 `null`。
- 回合被中止时多一个 `abortReason`。
- 有后台 follower 被排入时多一个 `deferredJobs: [{ jobId, runtimeId }]`。

##### 维度编辑与待结算恢复

改维度的值、处理待结算的来源，都用上面的 runtime 级 RPC，没有专用的 REST 写入端点。

> [!IMPORTANT]
> 客户端要从会话视图（`GET /api/sessions/:id/view`）的 `dimensionProviderPluginId` 和 `dimensionRecovery` 取插件 ID 和 runtime ID。下面例子里的 `world-init` 只是示例，通用客户端不能把它写死。

**普通改值**（不会自动解除任何待结算义务）：

```json
{
  "kind": "runtime",
  "pluginId": "world-init",
  "runtimeId": "world-init/edit-dimensions",
  "payload": {
    "updates": [{ "id": "reputation", "expectedVersion": 2, "value": 10 }]
  }
}
```

编辑器的 payload 是 `{ updates, resultId?, resolution? }`：

- `updates` 最多 64 项，`id` 不能重复，值按同一份 schema 校验。
- 不带来源（没有 `resultId` / `resolution`）时只改值，`updates` 至少要有一项。玩家不能在这里新建维度定义或修改 schema。
- 处理一个已有的待结算来源时，`resultId` 和 `resolution` 必须成对出现。`resolution` 取值：
  - `manual`：确认已经人工处理。可以同时提交修正，也可以用 `updates: []` 明确确认。
  - `skipped`：必须 `updates: []`。保留当前值并记录终态，这个来源以后不再补算。

**明确跳过**一个来源（`resultId` 取自 `dimensionSettlements[].source.resultId`）：

```json
{
  "kind": "runtime",
  "pluginId": "world-init",
  "runtimeId": "world-init/edit-dimensions",
  "payload": {
    "updates": [],
    "resultId": "narrative-result-1",
    "resolution": "skipped"
  }
}
```

**重试**：直接调用 `trackerRuntimeId`，带上该回执的 **`sourceTurnId`**（不是 `resultId`）：

```json
{
  "kind": "runtime",
  "pluginId": "world-init",
  "runtimeId": "world-init/dimension-tracker",
  "payload": {},
  "retryFromTurnId": "source-turn-1"
}
```

重试的规则：

- 服务端从已保存的原回合记录里取叙事和上游结果，不信任客户端提交的正文或来源号。这些结果只当上下文用，不重复提交。
- 普通的手动运行拿不到叙事输入。编辑器不会递归调用 tracker。已经终结的来源不会再次结算。
- 旧计划或读到的版本已过期时，回执保持 pending。必须明确人工处理、跳过，或做一次符合来源边界的重试；服务端不会自动 rebase。

**版本冲突**不按“最后写入获胜”处理：

- 编辑器的前置检查发现冲突时，在 runtime 的 `output` 里返回 `{ applied: false, code: "dimension-version-conflict", currentVersions }`。
- 提交阶段发现冲突时，RPC 返回 `409 { error, code: "dimension-version-conflict", details: { currentVersions } }`。
- 客户端要重新读取 `GET /api/sessions/:id/view`，核对值和回执后再提交。`status: "ok"` 或 `submitted: true` 都不能证明修改已经落库。
- 自动维护的结算被拒绝时，已提交的叙事可以保留，回执停在 `pending-settlement`，同样要检查回执。

**与回合的关系**：有待结算回执时，`POST /api/actions` 在开始回合前先自动重试一次（见[动态维度](./dynamic-dimensions.md)）。仍然没有结算的话，该回合以 `abortReason` 结束，文字里说明玩家可以做什么。回执的五种状态见 [World Model](./world-model.md#回合时序与结算回执)。

**图像/媒体生成输出:**

function handler 通过 `HandlerResult.success.effects.assetGenerations[]` 返回媒体产出。API 的 runtime `output` 里会带上这个数组。每一项会作为一条 `asset.generate` proposal 提交，并以 MediaRef 的形式进入 trace、SSE 和视图层。

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

provider 返回的原始内容只是 handler 的临时输入，例如 OpenAI 的 `b64_json`、SDK 的 `base64`、会过期的远程图片 URL。handler 在返回前必须把它们存进媒体库：

- 字节或 base64：调用 `ctx.media.put()`。
- 远程 URL：调用 `ctx.media.ingestUrl()`。

然后只通过 `assetGenerations[].ref` 和只含 ref 的业务记录暴露生成的媒体。

`ctx.media.ingestUrl()` 的出站规则：

- **重定向**
  - 底层的 `utils.fetchWithRetry` 从不自动跟随重定向。
  - `ingestUrl` 显式传 `redirect: "manual"`，拿到原始的 3xx 响应，然后对每一个 `Location` 重新做一遍 `validateBaseUrl`（SSRF 策略）和 `permissions.http` 判定。跳转超过 `maxRedirects`（默认 5）就失败。
  - 插件自己调用 `ctx.utils.fetchWithRetry` 时，默认（或 `redirect: "follow"` / `"error"`）遇到 3xx 会直接抛错。只有显式传 `redirect: "manual"` 才会把 3xx 交回调用方，由调用方负责校验每一跳。
- **权限**
  - `ctx.media` 和 `ctx.utils` 共用同一套 `permissions.http` 检查。
  - 社区 runtime 通过 `ingestUrl` 访问没有声明的 origin 会被拒绝（`http permission denied: …`）。`ctx.images.generate` / `ctx.speech.*` 返回的远程 URL 落库时也走这条路。即使这个 URL 只出现在 provider 的响应里也一样，所以图片 CDN 之类的 origin 必须写进 `permissions.http`。
  - 内置（受信任）runtime 不强制这份白名单。SSRF 策略对两者始终生效。

当前生效的 `media.image-flow@1` 扩展声明的素材 runtime 还有额外要求：

- 成功完成的 runtime 必须在 `HandlerResult.success.effects` 里返回至少一条有效的 `assetGenerations[]`。
- 扩展的提供方返回 `{ entryRuntimeId, assetRuntimeIds }`。宿主绑定 `providerPluginId`，并校验这些 runtime 确实属于它。
- `images` 命名空间里的 `pluginData` 记录必须保存 `ref`。已完成的输出里如果还带着 `url`、`base64` 或 `dataUrl` 图片字段，会报成 runtime 错误。

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

`phase: "prompt"` 只在请求带了 `expectsBackgroundFollower: true`、而目标 runtime 本身是 sync 时出现。这时入口 runtime 作为后台任务执行：

- 排入了后台 follower：任务状态为 `succeeded`，`result.deferredJobs` 列出 follower 任务。
- 没有触发任何后台 follower：任务状态为 `failed`，`reason: "follower-not-emitted"`。

**后台任务记录（`_runtime_jobs`）:**

手动运行的后台任务、事件触发的后台 follower、调度器的 detached stage 共用同一个持久队列，每个任务一行。

- 插件**禁止**写入这个命名空间。
- 读取方式：SSE、`GET /api/sessions/:id/runtime-jobs`，或 plugin-data 查询。
- 读到的是公开投影：不含 `payload`，`error` 只给固定的诊断文案。

```
sessionId     : <session>
pluginId      : <所属插件>
namespace     : "_runtime_jobs"
key           : <jobId>
value         : {
  status: "queued" | "claimed" | "running" | "committing"
        | "succeeded" | "failed" | "timed_out" | "cancelled" | "stale" | "orphaned",
  runtimeId: string,
  origin: { activation: "stage" | "manual" | "event", sourceTurnId: string, sourceRuntimeId?: string },
  enqueuedAt: ISO8601,
  finishedAt?: ISO8601,
  result?: {                                  // 手动/事件激活提交后
    turnId: string,                           // 本次执行的 turnId（手动激活与 202 响应一致）
    durationMs: number,
    runtimeResults: RuntimeResultSummary[],
    deferredJobs?: { jobId: string; runtimeId: string }[]
  },
  reason?: "runtime-reported-failure" | "follower-not-emitted" | "execution-failed" | …,
  error?: string                              // 公开诊断文案
}
```

任务怎么结束：

| 情况                                                                                | 任务状态                                       | 写入                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| runtime 在自己的结果里报告失败（`status: "failed"`、`error` 或失败的 runtime 结果） | `failed`，`reason: "runtime-reported-failure"` | 照常提交，handler 可以借此记录自己的失败状态 |
| proposal 提交失败                                                                   | `failed`，`reason: "execution-failed"`         | 整次执行回滚，不排入任何 follower            |
| 执行期间会话被暂停、结束或撤销授权                                                  | `stale`                                        | 不提交                                       |

runtime 报告失败时，它的原始错误保留在 `result.runtimeResults` 里。

**重启与凭证**：

- 任务行是持久化的。服务重启后仍为 `queued` 的任务，会在凭证可用时继续执行：下一次带 provider key 的请求会重新交出凭证，或者服务端自己的凭证满足就绪检查。
- 服务正常关闭时，执行到一半的任务放回队列，重启后重跑。它停下前调用过的服务商会再被调用一次，所以作业要能安全地重跑。
- 进程崩溃时执行到一半的任务，在租约过期后标为 `orphaned`。框架不会自动重跑，避免图像或语音被二次计费。
- 失败或取消的任务可以用 `POST /api/sessions/:id/runtime-jobs/:jobId/retry` 重试，重试使用新的 `turnId`。

##### 错误

**错误响应:**

| 状态码 | `code` / 触发条件                                                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `kind` 缺失或非法；该 kind 的必填字段缺失；字段跨 kind 混用；`RpcValidationError`；command 参数校验失败；`plugin_mismatch`；`event_payload_invalid`                                    |
| 404    | `session_not_found` / `plugin_not_active` / `unknown_action` / `runtime_not_active` / `command_not_active` / `event_not_declared` / `retry_turn_not_found`                             |
| 409    | `session_not_active` / `session_deleting` / `session_incarnation_changed` / `approval_scope_changed` / `command_changed` / `retry_source_not_committed` / `dimension-version-conflict` |
| 429    | `queue_full`（社区插件的待批准队列已满）/ `background_queue_full`（会话排队中的后台任务达到上限，默认 256）                                                                            |
| 500    | `turn_commit_failed`；handler 抛出未处理的异常；handler 模块加载失败                                                                                                                   |
| 504    | `handler_timeout`（action 级：handler 超过 30 秒没有结束）                                                                                                                             |
| 503    | `event_directory_unavailable`（event 级：事件目录不可用）                                                                                                                              |

几个要点：

- `plugin_mismatch`：runtime 级请求里的 `runtimeId` 不属于 `pluginId`。
- `command_changed`：请求等待期间，这个命令的声明变了。
- `turn_commit_failed` 以外的未知异常交给全局错误处理器，返回通用的 `500`，没有专门的 `code`。

> [!NOTE]
> background 模式下，runtime 内部的异常**不会**变成 5xx 状态码。`202` 已经发出，失败记录在那条后台任务上，前端通过 SSE 得知。

> [!IMPORTANT]
> **以提交结果为准。** runtime 可能返回 `success`，但它的 proposal 提交失败。这时：
>
> - 同步 RPC 返回 `500 turn_commit_failed`，诊断信息在通用错误信封的 `details` 里（`turnId`、`runtimeResults`）。
> - 后台任务标为 `failed`（`reason: "execution-failed"`），并且**不会**排入该回合的后台 follower，因为后续任务不应该建立在已回滚的状态上。
> - 主回合路径（`POST /api/actions`）遵循同一条规则。

社区插件的两步授权：

- **action（`entry` 注册的 action）**：第一次调用时 action 还没有注册。
  1. 服务端先返回一个审批，`action` 固定为 `covel:plugin-server-code`，表示“加载这个插件的服务端代码”。固定名称是为了防止调用方伪造 action 名来诱导加载代码。
  2. 玩家按会话范围批准后，服务端加载 entry 并检查 action 是否存在。不存在立即返回 404；存在则再返回一个针对真实 action 的独立审批。
  - 客户端要能处理这两个连续的 `approval-required` 响应。同一个请求反复索要同一个 `(pluginId, action)` 的授权时，应停止重试。
  - `demo` / `commercial` 部署层级下，两步都需要运维 token。
  - 内置插件的 entry 在服务启动时已经运行，未知 action 直接返回 404。
- **runtime（`runtimeId`）**：同样分两步。
  1. 缺少服务端代码授权时，第一次调用返回 `covel:plugin-server-code` 审批。
  2. 批准后重试，返回 `runtime:<runtimeId>` 审批。
  - 两个授权都**精确**存在时，runtime 才会加载执行。加载 entry 也只认精确的 `covel:plugin-server-code` 授权，别的 action 授权解锁不了模块加载。
  - 撤销时按 `(session, plugin)` 一起清除这两类授权。

### RPC Approval 流程

第三方插件（来源为 `community`）的 RPC action 在执行前需要玩家明确批准。这样没有审计过的代码不能自己操作会话。

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
              builtin                         community
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

用文字说：

1. 客户端调用 `plugin-rpc`。
2. 内置插件直接执行，返回 `200`。
3. 社区插件如果没有已缓存的授权，服务端创建一条待批准记录，返回 `202 approval-required`。
4. 客户端弹出对话框，玩家选择“允许一次”“本会话允许”或“拒绝”，客户端把决定发到 `POST /api/approvals/:approvalId/decision`。
5. 允许后，客户端重新发起同一个 `plugin-rpc` 请求，这次返回 `200`。

#### `POST /api/sessions/:id/plugin-rpc` 的额外响应状态

| 状态码 | 含义                             |
| ------ | -------------------------------- |
| 202    | 社区插件需要玩家批准。响应体见下 |

其余 4xx/5xx 使用本文开头的 `{ error, code?, details? }` 通用错误信封，不返回 `status: "error"`。

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

列出这个会话当前所有等待批准的请求。前端在页面刷新后用它重建对话框队列。

**响应 200:**

```json
{
  "items": [
    { "approvalId": "9d8c-...", "pluginId": "...", "action": "...", ... }
  ]
}
```

#### `POST /api/approvals/:approvalId/decision`

提交玩家对一条待批准请求的决定。

调用方必须是这条请求所属会话的 owner。社区插件的审批在 `demo` / `commercial` 部署层级下还需要运维 token。鉴权失败不会消费这条待批准记录。

**请求体:**

```json
{
  "decision": "allow",
  "scope": "once"
}
```

| 字段       | 类型                    | 必需        | 说明                            |
| ---------- | ----------------------- | ----------- | ------------------------------- |
| `decision` | `"allow"` \| `"deny"`   | 是          | 玩家的选择                      |
| `scope`    | `"once"` \| `"session"` | 仅 allow 时 | 授权范围，默认 `once`。限制见下 |

`scope` 的限制：

- 普通 action 可以选 `once`（默认）或 `session`。
- `covel:plugin-server-code` 和 `runtime:*` 会加载长期存在的模块，只接受 `session`。

**响应 200:**

```json
{
  "ok": true,
  "decision": "allow",
  "scope": "once",
  "pending": {/* 原始 pending 数据,已从队列移除 */}
}
```

`allow` 之后，服务端立即为这个会话加载该插件已获授权的 runtime。有 runtime 加载不了（handler 或 guard 模块导入失败）时，响应多一个 `runtimeLoadErrors: [{ runtimeId, error }]`：

- 批准的是 `runtime:<id>`：只包含这一个 runtime。
- 批准的是 `covel:plugin-server-code`：包含此前已获授权的全部 runtime。

授权本身仍然生效。加载不了的 runtime 在回合里按单个任务失败处理，不影响其他任务。

**错误响应:**

| 状态码 | 触发条件                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| 400    | `decision` 缺失，或不是 `allow` / `deny`；`scope` 非法；服务端代码或 runtime 的审批用了非 `session` 的范围 |
| 404    | `approvalId` 不存在或已被消费（`approval_not_found`）；所属会话不存在（`session_not_found`）               |
| 409    | 这条审批所属的会话授权已被撤销、插件已被禁用、会话已删除，或同 ID 的会话已重建（`approval_scope_changed`） |

#### `DELETE /api/sessions/:id/approvals`

撤销这个会话的授权：已缓存的会话授权、一次性授权和还在等待的请求都会清除。用于玩家中途收回对社区插件的信任。

**查询参数:**

| 参数       | 必需 | 说明                                       |
| ---------- | ---- | ------------------------------------------ |
| `pluginId` | 否   | 只撤销这一个插件的授权；省略则撤销整个会话 |

**响应 200:**

```json
{ "ok": true, "cleared": 2 }
```

`cleared` 是清除的授权条数（会话授权与一次性授权合计）。

其他规则：

- 带 `pluginId` 时只更换这个插件的授权代次；省略时更换整个会话的授权代次。代次是持久化的，所以撤销对共用 PostgreSQL 的其他实例同样生效。
- 等待中的请求按 `(会话授权代次, 插件, action, payload)` 去重。同一个 action 带不同参数，算不同的待批准请求。
- 禁用插件、因冲突移除插件时也会撤销。旧的 `approvalId` 之后不能再用来重新激活代码。

#### 插件来源与 approval 行为

| 插件来源    | 来源                        | Approval 行为                            |
| ----------- | --------------------------- | ---------------------------------------- |
| `builtin`   | 框架自带 / 框架默认 handler | 永远直接执行                             |
| `community` | 第三方，默认级别            | 每次都需要玩家批准，除非已有本会话的授权 |

> [!NOTE]
> 一次性授权的有效期是 60 秒，并且只能被一个 payload **结构完全相同**的请求消费一次（对象 key 的顺序不影响比较）。改了参数再重试不会复用旧授权，会重新走审批。玩家批准后 60 秒内没有发起对应请求，授权就过期。

> [!WARNING]
> 待批准的请求和授权内容只存在**当前进程的内存**里：
>
> - 服务器重启后全部清空。
> - 一个实例上批准的授权不会复制到另一个实例。
> - 持久化的只有会话和插件的撤销代次。它保证旧授权在其他实例上只会失效，不会误授权给删除后同 ID 重建的会话。
>
> 负载均衡下想避免重复弹窗，需要另外实现共享的持久化审批存储。

### 插件管理

#### `GET /api/framework/authoring`

返回“写一个世界可以填哪些内容”的清单，供世界创建界面和开发 Agent 使用。它反映服务端当前已加载的插件。

- 内容全部来自插件清单的 `contributes.data.*.authoring` 声明，没有写死的插件列表。
- `pnpm describe:authoring` 输出的是同一份数据。
- 示例无法读取、不是 JSON，或可生成契约的 schema 缺失、无效或冲突时，只略过对应契约。可选的 `diagnostics` 数组逐项返回 `{ pluginId, namespace, message }`，服务端也记录警告；其他契约和插件仍可用。
- 查询参数 `locale` 决定 `title` 等展示文本的语言，省略时用服务端默认语言。

**响应节选:**

```json
{
  "files": [
    {
      "path": "world.yaml",
      "purpose": "World manifest: identity, locales, plugin selection, character schema.",
      "reference": "docs/reference/schema/world-manifest.md"
    }
  ],
  "destinations": [
    {
      "title": "Characters",
      "description": "Character records of the session's world model.",
      "source": {
        "id": "characters",
        "entry": {
          "kind": "json",
          "path": "characters/characters.json",
          "to": "characters",
          "key": "id"
        }
      }
    }
  ],
  "contracts": [
    {
      "contract": "memory.blocks@1",
      "pluginId": "memory",
      "namespace": "definitions",
      "title": "题材记忆块",
      "hint": "Write one object with `id: world` and a `blocks` list. …",
      "schema": "./schemas/block-definitions.schema.json",
      "source": {
        "id": "definitions",
        "entry": {
          "kind": "json",
          "path": "data/memory-blocks.json",
          "schema": "contract:memory.blocks@1",
          "to": "contract:memory.blocks@1",
          "key": "id"
        }
      },
      "example": { "id": "world", "blocks": [] },
      "generate": "default"
    }
  ],
  "plugins": [
    {
      "id": "memory",
      "displayName": "记忆",
      "description": "…",
      "tags": [],
      "provides": [],
      "requires": [],
      "settings": []
    }
  ]
}
```

| 字段           | 说明                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| `files`        | 世界包里有哪些文件，各自的字段表在哪里                                                        |
| `destinations` | 内核拥有的数据目标（维度、角色），不依赖任何插件                                              |
| `contracts`    | 每个有插件接收的数据契约：接收插件、标题、写作提示、可直接写进 `world.data.yaml` 的条目、示例 |
| `generate`     | 只在应用内生成器能生成这份内容时出现：`offer` 表示列为可选项，`default` 表示列出并默认选中    |
| `plugins`      | 插件目录：ID、名称、简介、提供和依赖的契约、可以用 `pluginSettings` 预置的设置项              |

#### `GET /api/framework/capabilities`

返回框架能力的索引。第三方开发者、外部工具和 AI Agent 可以用它在程序里判断“Covel 当前支持哪些字段、URI、工具和事件”。它描述的是框架本身，不依赖某个具体插件。

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
      "turnCompletionModes": ["await", "detached"],
      "inputInjectKinds": [
        "runtime",
        "plugin-data",
        "runtime-export",
        "kernel"
      ],
      "uiSlots": ["right", "message", "left"]
    },
    "scheduling": {
      "effectsPolicy": "warn"
    },
    "pluginData": {
      "scope": "(sessionId, pluginId, namespace, key)",
      "reservedNamespaces": ["_runtime_jobs", "_logs"],
      "writePaths": [
        "builtin-tool:plugin-data-set",
        "function-output:pluginData[]"
      ]
    },
    "worldData": {
      "effects": ["characters", "projections"],
      "targetUris": [
        "world:metadata.<path>",
        "contract:<contractId>",
        "contract:<contractId>+lorebook"
      ],
      "schemaUris": [
        "covel://world/dimensions",
        "contract:<contractId>",
        "<local-json-schema-path>"
      ],
      "schemas": {}
    }
  }
}
```

> [!NOTE]
> **`triggerTypes` 的取值范围**：可用的触发类型只有 `auto` / `manual` / `scheduled` / `event` 四种，`triggerTypes` 把它们全部列出。详见 [reference/plugins.md → Runtime 分组字段](./plugins.md#runtime-分组字段)。

#### `GET /api/plugins`

列出服务端发现的全部插件，返回 `{ items: PluginSummary[] }`。

`PluginSummary` 的字段：

| 字段                                                        | 含义                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `id`, `displayName`, `description`                          | 包的身份和可本地化的描述                                            |
| `kind`, `source`                                            | `core \| plugin` 与 `builtin \| community`                          |
| `hostState`, `error?`                                       | 宿主状态 `discovered \| installed \| loaded \| error`，以及加载错误 |
| `provides`, `requires`, `optional`, `conflicts`             | 包级 contract 声明                                                  |
| `extensions`                                                | 声明的扩展点、ID、顺序和监听信息                                    |
| `eventTopics`                                               | `contributes.events` 声明的 topic                                   |
| `runtimeCount`, `runtimes`, `tools`, `userSettings`, `tags` | runtime 摘要、工具和用户设置                                        |
| `languages`                                                 | `{ text: string[], instructions: string[] }`，见下                  |
| `version?`, `author?`, `license?`, `homepage?`              | 清单里的版本和[作者信息](./plugins.md#作者信息)，只用于展示         |

字段说明：

- `eventTopics`：会话解析插件集合时用它保证一个 topic 只有一个声明者。
- `languages.text`：插件有文字的语言，包括标签、界面文字、代码里的文字，以及翻译目录里的译文。`languages.instructions`：有指令（prompt 正文）的语言。两者都至少包含 `en`。
- `author.about` 和链接的 `label` 可能是按语言分的 map。
- 每个 runtime 摘要包含 `id`、`runtimeType`、`trigger`、`execution`、生效的 `turnCompletion`、`outputKind`、可选的 `outputContract` 等字段。

`hostState` 说的是服务端有没有加载这个插件，不是某个会话有没有启用它。这是两种状态，列表不会把前者写成某个会话的 active。

- `loaded` 取自当前 entry 的实际发布状态，与 runtime 缓存无关。
- 第一次发布失败是 `error`。
- 重新加载失败、但旧的一版仍然可用时，仍是 `loaded`，并可以带 `error`。
- 只有声明、或只有 entry 的包可以没有 runtime。

界面应当按公开的 contract 和扩展点来发现行为，不能根据具体的插件 ID 推断能力。

#### `GET /api/plugins/:id`

返回一个插件的完整描述 `PluginDetail`。插件不存在时返回 `404`（`code: "plugin_not_found"`）。

`PluginDetail` 包含 `PluginSummary` 的全部字段，并增加：

| 字段                            | 说明                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `dataSchemas`                   | 来自 `contributes.data`                                                                   |
| `worldProjections`              | 公开来源 contract 和输出的 namespace / key；不公开宿主路径和可执行的 handler              |
| `declaredPluginDataNamespaces`  | 声明的 plugin-data 命名空间，还包含各 runtime 注入自身数据（`io.selfData`）用到的命名空间 |
| `ui.right` / `message` / `left` | 聚合的 UI slot。每项保留 `path`；只有属于某个 runtime 时才带 `runtimeId`                  |
| `runtimes[]`                    | 完整的 runtime 开发契约                                                                   |

注意：

- `runtimes[].after` / `needs` / `inputs` / `effects` / `turnCompletion` 是编译后的执行描述，用来解释执行顺序、输入条件和 detached 行为。作者写的是另一种格式：在 `PLUGIN.md` 里声明包级 `contributes`，在 `RUNTIME.md` 的 `schedule` / `io` / `agent` / `function` 分组里声明执行配置。不要把这里的内部结构当作清单提交。
- 动态 key 不在清单里列举。用当前会话的 plugin-data 查询或 `_index` 端点读取。
- 服务、工具、action、slash command 和 extension 是不同的注册种类，必须分别声明。

### 会话插件管理

#### `GET /api/sessions/:id/plugins`

列出这个会话能看到的插件，以及会话当前可执行的命令。

- `items[]`：每项在 `PluginSummary` 的基础上增加 `active`、`locked`、`sessionState`、`serverCodeApproved`，以及可选的 `approvalRequired`、`autoAdded`、`rejection`。
- `items[].runtimes` 与 `GET /api/plugins` 的形状完全相同。
- `commands[]`：唯一的可执行命令目录。它按当前启用的插件过滤，再加上框架命令。命令只在顶层列一次，不按插件重复返回。
- `unavailable[]`：玩家确认的插件里现在不能运行的那些，每项是一个 `rejection`（`pluginId`、`code`、`reason`）。原因可能是没有安装（`unknown-plugin`）、加载失败，或者当前版本缺少提供者、和别的成员冲突。游戏照常进行。
- 列表、命令和执行器读的是同一个集合：会话保存的 `activePlugins` 按当前安装的版本检查后的结果，不补入新插件。规则见[会话插件选择](./plugins.md#会话插件选择)。这个接口只读，不改写会话。

**响应:**

```json
{
  "commands": [
    {
      "id": "framework:plugins",
      "pluginId": "framework",
      "source": "framework",
      "name": "plugins",
      "description": { "zh": "查看插件注册能力与最近的服务调用" },
      "arguments": [{ "name": "pluginId", "type": "string" }],
      "action": "slash-plugins"
    },
    {
      "id": "framework:debug",
      "pluginId": "framework",
      "source": "framework",
      "name": "debug",
      "aliases": ["trace"],
      "description": { "zh": "打开当前会话的调试与执行跟踪视图" },
      "action": "slash-debug",
      "context": ["session", "active-runtimes", "models"]
    }
  ],
  "items": [
    {
      "id": "narrator",
      "displayName": "核心叙事者",
      "description": "主要叙事生成插件",
      "kind": "core",
      "hostState": "loaded",
      "active": true,
      "locked": false,
      "provides": ["narrative-engine@1"],
      "requires": [],
      "optional": [],
      "conflicts": [],
      "extensions": [],
      "eventTopics": [],
      "sessionState": "active",
      "serverCodeApproved": true,
      "tags": ["mode:traditional-story", "cost:llm"]
    }
  ]
}
```

#### `PUT /api/sessions/:id/plugins/:pluginId`

在这个会话里启用一个插件。服务端会重新计算会话的启用集合（按 contract 依赖求解）。

**响应:**

```json
{ "ok": true, "activePluginIds": ["pregame", "narrator", "codex"] }
```

响应里还有 `resolution`：本次求解的完整结果。

规则（启用和禁用相同）：

- 启用、禁用与同一会话的其他写入共用会话锁，拿到锁后重新读取 `activePlugins`。先持久化成功，再更新进程内的注册表。这样并发请求不会互相覆盖，持久化失败也不会让内存和存储不一致。
- 会话已绑定的维度 provider 必须保持启用。它持有这个会话的 `_dimensions` 数据，回合、快照和浏览器 checkpoint 都需要它。重新求解后的启用集合如果不再包含它，请求以 `409 { "code": "dimension_provider_required" }` 拒绝，会话的插件选择不变。

#### `DELETE /api/sessions/:id/plugins/:pluginId`

在这个会话里禁用一个插件。

- 插件会从用户的 requested 集合移除，并加入 excluded 集合，然后重新求解 contract 依赖。
- 依赖它的插件可能因此被拒绝，或者改用其他可用的提供者。
- `kind: core` 不代表强制启用；目前 `locked` 始终为 `false`。
- 这个会话对该插件的授权会一并撤销。

**响应:** `{ ok: true, activePluginIds, resolution }`。`activePluginIds` 是求解后的启用集合，`resolution` 是求解的完整结果。

**错误:**

| 状态码 | `code`                        | 什么时候                                                      |
| ------ | ----------------------------- | ------------------------------------------------------------- |
| 409    | `session_not_active` 等       | 会话不是 active、已进入删除流程，或等待期间被同 ID 的会话替换 |
| 409    | `dimension_provider_required` | 禁用的是会话已绑定的维度 provider，或禁用后求解会连带移除它   |

出错时会话不被改动。

### 状态查询

状态系统用结构化的表保存游戏世界的各种事实，例如角色属性、世界状态、任务进度。插件通过 `state.patch` proposal 提交状态变更；这里的端点只读。

#### `GET /api/sessions/:id/state`

返回这个会话的全部状态表和表里的数据。表名和数据的键按原名保留，包括 `__proto__` 这类合法的 JSON 键。

限流：同一客户端对同一路径每分钟最多 120 次，超出返回 `429`（`code: "rate_limit_exceeded"`，带 `Retry-After`）。

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

### 消息历史

#### `GET /api/sessions/:id/messages`

返回会话的**完整**消息列表，按时间升序。长会话请优先用 `/page`；这个端点留给没有快照时的兜底读取和批量同步。

限流与 `/page` 相同：同一客户端对同一路径每分钟最多 120 次，超出返回 `429`（`code: "rate_limit_exceeded"`，带 `Retry-After`）。

**参数:**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**响应:** `{ items }`。每项是一条扁平的消息对象：存储里 `metadata` 下的 `turnId`、`runtimeId`、`kind`、`block` 被提到了顶层。

```json
{
  "items": [
    {
      "id": "msg-001",
      "sessionId": "mistport-a1b2c3d4",
      "role": "user",
      "content": "我环顾四周",
      "turnId": "turn-1",
      "createdAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

#### `GET /api/sessions/:id/messages/page`

分页读取消息，每页内**按时间正序（旧的在前）**。聊天界面向上滚动时用它一页一页加载历史。

- 不传 `cursor`：返回最新的一页。
- 传 `cursor`：返回它之前（更旧）的一页。

**参数:**

| 参数     | 位置 | 说明                                            |
| -------- | ---- | ----------------------------------------------- |
| `id`     | 路径 | 会话 ID                                         |
| `limit`  | 查询 | 每页条数，默认 80，上限 500                     |
| `cursor` | 查询 | 上一页响应里的 `nextCursor`，客户端必须原样回传 |

`cursor` 是不透明的字符串，客户端不要解析它。服务端在里面编码了带版本的 `(createdAt, id)` 位置，所以同一毫秒的记录不会漏也不会重复。非法或不支持的 cursor 返回 `400 invalid_cursor`。

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
  "nextCursor": "<opaque string>"
}
```

`nextCursor` 指向本页最旧的一条，用来取下一页（更旧的）。返回条数少于 `limit` 时，说明已经到了历史开头，`nextCursor` 为 `null`。

#### `POST /api/sessions/:id/messages/sync`

向服务端会话追加一批消息。内置 Web 客户端不调用它：浏览器私有会话改用 `PUT /api/sessions/:id/browser-checkpoint` 上传完整的 checkpoint。

**请求体:** `{ "messages": [...] }`，每条消息：

| 字段        | 类型   | 必填 | 说明                                     |
| ----------- | ------ | ---- | ---------------------------------------- |
| `role`      | string | 是   | `user` / `assistant` / `system` / `tool` |
| `content`   | string | 是   | 消息正文                                 |
| `id`        | string | 否   | 稳定的消息 ID。省略时由服务端生成        |
| `createdAt` | string | 否   | 创建时间。省略时用服务端当前时间         |
| `turnId`    | —      | 否   | 存进消息的 metadata                      |
| `runtimeId` | —      | 否   | 存进消息的 metadata                      |
| `block`     | —      | 否   | 存进消息的 metadata                      |

**响应:** `{ "ok": true }`

规则：

- 同一个会话里，重复提交相同的 `id` 会被跳过。所以恢复存档或网络重试不会把整段历史再追加一遍。
- 不带 `id` 的消息每次都会得到新 ID，重复提交就会重复追加。
- 整批写入在会话锁和一个存储事务内执行。任何一条新消息写入失败，整批回滚。
- 会话必须是 `active` 状态。
- 限流：同一客户端对同一路径每分钟最多 60 次，超出返回 `429`（`code: "rate_limit_exceeded"`）。

### 插件数据（Plugin Data）

每个插件在每个会话里有一块自己的键值存储。一条数据由 `(sessionId, pluginId, namespace, key)` 四项定位，不同会话、不同插件之间互不可见。

> [!NOTE]
> 内置 Web UI 只用这里的读取端点（右侧面板、消息内 UI、插件数据缓存）。`PUT` / `DELETE` 是给管理工具和脚本用的写入口，内置 Web UI 不调用。插件自己的 runtime 请通过插件数据工具、插件 RPC 或 proposal 写数据。

读取端点的共同规则：

- 隐藏的世界数据（`_hidden.*` 命名空间）和内核记账数据不会返回。
- `pluginId` 不是已加载的插件时返回 `404`（`Unknown plugin: <id>`）。

写入端点（`PUT` / `DELETE`）的共同规则：

| 状态码 | `code`               | 什么时候                                         |
| ------ | -------------------- | ------------------------------------------------ |
| 403    | —                    | `namespace` 是内核保留的命名空间                 |
| 403    | —                    | 目标是核心插件（它的数据只能经它自己的工具修改） |
| 403    | —                    | 插件没有在这个会话里启用                         |
| 404    | —                    | `pluginId` 不是已加载的插件                      |
| 409    | `session_not_active` | 会话不是 `active` 状态                           |

#### `GET /api/sessions/:id/plugin-data/:pluginId/:namespace`

列出某个插件在某个命名空间下的全部数据。

**请求**

| 参数        | 位置 | 说明                               |
| ----------- | ---- | ---------------------------------- |
| `id`        | 路径 | 会话 ID                            |
| `pluginId`  | 路径 | 插件 ID（如 `world-init`）         |
| `namespace` | 路径 | 命名空间（如 `schema`、`entries`） |

**响应**

```json
{
  "items": [
    { "namespace": "schema", "key": "attributes", "value": { ... }, "updatedAt": "..." },
    { "namespace": "schema", "key": "skills", "value": { ... }, "updatedAt": "..." }
  ]
}
```

#### `GET /api/sessions/:id/plugin-data/:pluginId/_index`

列出某个插件在这个会话里已有的命名空间和 key，不返回 `value`。

适合三种用途：调试；让 AI Agent 自己发现当前会话的数据长什么样；让 UI 建一份轻量索引。

**响应**

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

读取一条插件数据。这条数据不存在时返回 `404`。

**响应**

```json
{ "namespace": "schema", "key": "attributes", "value": { ... }, "updatedAt": "..." }
```

#### `PUT /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`

写入或覆盖一条插件数据。

**请求**

```json
{ "value": { "dimensions": ["strength", "agility", "wisdom"] } }
```

| 字段    | 类型 | 必填 | 说明                                                   |
| ------- | ---- | ---- | ------------------------------------------------------ |
| `value` | 任意 | 是   | 要保存的值。序列化成 JSON 后最大 256 KiB（UTF-8 字节） |

256 KiB 的上限与 proposal、handler 写入共用，见 [tools.md](./tools.md)。

**响应**

```json
{ "ok": true, "namespace": "schema", "key": "attributes" }
```

**错误**

| 状态码 | `code` | 什么时候                       |
| ------ | ------ | ------------------------------ |
| 400    | —      | 请求体里没有 `value`           |
| 413    | —      | `value` 超过 256 KiB，不会写入 |

其余错误见本节开头的写入规则。

#### `DELETE /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`

删除一条插件数据。

**响应**

```json
{ "ok": true }
```

### Suspend / Resume

runtime 可以中途停下来等玩家提供数据，这叫挂起。本节的端点用来查看挂起项、提交数据让它继续，或者放弃它。

> [!NOTE]
> **过期清理**：恢复请求和 `GET /api/sessions/:id/suspensions` 在处理前，会顺带做一次全局的过期清理。清理有时间间隔限制，失败也不影响本次请求。过期的挂起项按[放弃](#delete-apisessionsidsuspensionssuspensionid)的方式处理，见[挂起与回合计数](#挂起与回合计数)。
>
> 进程在恢复途中退出时，会留下一个“正在恢复”的占用标记。这次清理和服务启动时都会释放它，之后这个挂起项可以再次恢复或放弃。已经发出去的外部调用不会撤销，这一点与恢复失败后重试相同。相关环境变量见 [`env-registry.md`](./env-registry.md)。

#### `POST /api/sessions/:id/suspensions/:suspensionId/resume`

用玩家提交的数据让一个挂起的 runtime 继续运行。

- **agent runtime**：从保存下来的工具调用记录接着跑。
- **function runtime**：重新调用 handler，本次数据通过 `ctx.resumeData` 和 `ctx.resumedFromSuspensionId` 传入，不会进入模型循环。

**请求**

```json
{
  "data": {/* shape 必须匹配 suspension.resumeSchema */}
}
```

| 字段   | 类型   | 必填 | 说明                                            |
| ------ | ------ | ---- | ----------------------------------------------- |
| `data` | object | 是   | 玩家提交的数据，必须符合挂起项的 `resumeSchema` |

- 缺少社区插件的运行授权时，先返回 `202 approval-required`，依次请求 `covel:plugin-server-code` 和 `runtime:<runtimeId>`。授权只针对这次恢复的 runtime；持有会话锁后还会重查。客户端逐项审批并重试原请求，拒绝审批则保留挂起项。托管部署还要求运营者凭据。
- 服务端用 `resumeSchema` 对 `data` 做完整的 JSON Schema 校验（Ajv）：`enum`、嵌套对象、`min` / `max`、`minLength` / `maxLength`、`pattern`、数组 `items`、`oneOf` / `anyOf` 等都会检查。不符合返回 `400 resume_data_invalid`。schema 不是对象或无法编译时，返回 `400 resume_schema_invalid`；不会占用挂起项或运行插件，作者需修正插件产生的 schema，再发起新的挂起请求；玩家可以放弃原挂起项。
- 浏览器客户端可以带 `X-Provider-Keys` 请求头，为这次请求提供模型密钥。桌面版和自部署客户端可以省略，沿用服务端启动时配置的密钥。服务端不会通过这个接口回传密钥。

**响应**

```json
{ "result": <ResumeResult>, "events": [ /* 本次 resume 产生的事件 */ ] }
```

**错误**

| 状态码 | `code`                    | 什么时候                                                                                     |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------- |
| 400    | —                         | 请求体不是合法 JSON 或结构不对                                                               |
| 400    | `resume_data_invalid`     | `data` 没通过 `resumeSchema` 校验                                                            |
| 400    | `resume_schema_invalid`   | `resumeSchema` 不是对象或无法编译；挂起项保持未处理                                          |
| 401    | `operator_token_required` | 托管部署缺少运行社区插件所需的运营者凭据                                                     |
| 429    | `approval_queue_full`     | 待审批队列已满，先处理已有审批                                                               |
| 404    | —                         | 会话或挂起项不存在，或找不到对应的 runtime                                                   |
| 409    | —                         | 挂起项已经处理过（两个请求同时恢复时，后到的一方也是这个结果）                               |
| 409    | `suspension_outdated`     | 挂起项已经过时，服务端把它作废了，见下面的“过时的挂起项”                                     |
| 500    | —                         | runtime 执行失败或提交失败（`error` 说明原因）；未知异常在生产环境是 `Internal server error` |
| 503    | `session_busy`            | 等会话锁超时，固定消息 `Session is busy, please retry`                                       |

失败响应的规则：

- 失败时只返回通用错误信封，不带 runtime 结果。
- runtime 自己执行失败时，`error` 是 `Resume failed: <原因>`，与回合事件流里 `runtime.failed` 给玩家看的文字相同。
- 提交失败时，`error` 是 `Resume commit failed: <原因>. The suspension remains unresolved and can be retried.`
- 失败后，这次请求对挂起项的占用会被释放（前提是会话没有被删除重建），所以可以重试。内部原因只写进服务端日志。

##### 过时的挂起项

挂起时会记下两样东西：这时历史里有几个玩家回合，以及提出它的插件是哪个版本。恢复前，服务端先检查挂起项是否已经过时。过时的挂起项不会再运行，因为它保存的写入可能盖掉更新的状态。

| `details.reason`   | 什么时候                                                       |
| ------------------ | -------------------------------------------------------------- |
| `session-moved-on` | 挂起之后历史里的玩家回合数变了（玩家又玩了一回合，或回退过）   |
| `plugin-updated`   | 提出它的插件换了版本                                           |
| `superseded`       | 同一个 runtime 之后又挂起过；一个 runtime 只有最新的那条能恢复 |

服务端按[放弃](#delete-apisessionsidsuspensionssuspensionid)的方式作废它，然后返回 `409`，`code` 是 `suspension_outdated`，`error` 是给玩家看的说明。网页端收到后把它从等待列表里移除，并提示玩家这个请求已经过时。

后台作业或手动运行在挂起之后写入的内容不算会话前进，不会让挂起项过时。

##### 挂起与回合计数

- 挂起本身不算完成一个玩家回合。
- 挂起时，“从哪里继续”的记录与本次的 proposal、日志和会话时钟在同一个事务里保存。提交成功后才广播 `turn.suspended`。所以提交回滚时，不会留下能恢复却没有来历的挂起项，也不会发出多余的事件。
- 原执行的 `logicalTurnId` 和 `countPolicy` 随挂起项一起保存。恢复成功时，在提交 proposal 的同一个事务里给玩家回合数加一次。
- 同一个逻辑回合有多个并行挂起项时，等最后一个恢复完才计数。重试不会重复计数。
- 挂起项被放弃、过期或作废时，按回合正常结束的方式收尾：它是这个逻辑回合最后一个还在等待的挂起项时，玩家回合数加一，回合扣下的后台作业（`schedule.completion.mode: detached`）照常入队。这些和删除记录在同一个事务里完成。正在被另一个请求恢复的挂起项也算“还在等待”。
- 挂起的执行上报过的进度作业（`ctx.progress`）停在 `waiting-input`。恢复成功提交后，它们以 `succeeded` 结束；挂起项被放弃、过期或作废时，以 `cancelled` 结束。恢复失败可以重试时，它们继续等待。

##### 恢复 setup runtime

被恢复的是 setup runtime 时，完成信号的处理与普通 setup 执行相同：

- “已完成”的标记写在恢复的提交事务里。它完成的是最后一个 setup 时，`phase` 也在同一个事务里切换。提交回滚则两者都不写。
- 尝试次数沿用挂起时的那一次，不另算一次。
- 恢复不做开场接力：由它完成最后一个 setup 时，主循环从玩家的下一个动作开始。

#### `GET /api/sessions/:id/suspensions`

列出这个会话当前所有的挂起项，按 `createdAt` 从早到晚排序。

**响应**

```json
{
  "items": [
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
      "createdAt": "2026-04-12T00:00:00.000Z"
    }
  ]
}
```

每一项是 `SuspensionSummary`，只包含恢复交互需要的公开信息。续接上下文（`pendingContinuation`）和占用、处理状态是服务端内部数据，不会从这里返回。

#### `DELETE /api/sessions/:id/suspensions/:suspensionId`

放弃一个挂起项，把它删除。用于玩家放弃当前选择，或管理界面清理。挂起项不存在时返回 `404`。

它是所在回合最后一个还在等待的挂起项时，这个回合算完成，回合扣下的后台作业照常入队，见[挂起与回合计数](#挂起与回合计数)。请求可以带 `X-Plugin-User-Settings`，作用与恢复请求相同。

**响应**

```json
{ "ok": true, "suspensionId": "susp_abc123" }
```

### Snapshot / Fork

快照把一个回合结束时的完整会话状态存成一份 `payload`。它是存档、读档和时间线分叉的基础。分叉（fork）从一份快照造出一个新会话，从那个时间点继续玩。

- 快照保存在 `state_snapshots` 表。
- `kind` 有三种：`auto`（自动）、`manual`（手动）、`fork`（分叉时写入子会话）。

> [!NOTE]
> 这些服务端能力都已实现并有测试覆盖。内置 Web UI 用 `GET /api/sessions/:id/view` 做恢复和重连，目前没有手动快照列表或分叉的界面。

#### `POST /api/sessions/:id/snapshots`

把会话当前的状态存成一份 `kind="manual"` 的快照。

**快照里有什么**

- 会话的生命周期和运行配置：`status`、`phase`、`completedPlayerTurns`、`setupRuntimes`、`locale`、`activePlugins`、`runtimeModelOverrides`
- `characters`、`stateEntries`、`pluginData`、`characterSchema`、`lorebookEntries`
- `sessionSummaries`：截至消息游标实际引用到的压缩摘要
- `compactedMessageSummaryIds`：快照时刻“消息 → 摘要”的对应关系
- `suspensions`：还没处理的挂起项
- `messagesCursor`：最后一条 `turn_message.id`

**创建时的保证**

- 读取和保存全程持有这个会话的执行锁，不会拍到一个回合提交到一半的状态。
- 消息上的压缩标签指向不存在的摘要时，拒绝创建快照。否则恢复时会有历史被藏起来。
- PostgreSQL 部署下，锁被执行中的回合占用超过 30 秒时返回 `503 { code: 'session_busy' }`，稍后重试即可。

**快照格式（v3）**

- `stateSchemas`、`runtimeExports`、`sessionSummaries`、`compactedMessageSummaryIds` 和 `displayMessagesBoundary` 必须全部存在。
- 空数组、空映射和值为 `null` 的聊天边界都有明确含义，不等于“缺失”。
- 缺字段的开发期旧快照必须重建。服务端不迁移它，也不用父会话的当前状态去补。
- 存储写入、SQL 读取和浏览器 checkpoint 用同一套 payload 校验。摘要映射必须指向快照里实际存在的摘要，否则拒绝。

**响应**

返回 `201 Created`。正文是 `SnapshotRecord` 的玩家可见视图，过滤规则与下面的[单个快照读取](#get-apisessionsidsnapshotssnapshotid)相同。

```json
{
  "id": "<uuid>",
  "sessionId": "mistport-a1b2c3d4",
  "turnId": "turn-42",
  "kind": "manual",
  "payload": {
    "schemaVersion": 3,
    "turnId": "turn-42",
    "session": {
      "status": "active",
      "phase": "playing",
      "completedPlayerTurns": 42,
      "setupRuntimes": {
        "world-init": {
          "state": "done",
          "resolution": "completed",
          "generation": 1,
          "attempts": 1,
          "pluginVersion": "1.0.0",
          "completedAt": "2026-04-13T00:00:00.000Z"
        }
      },
      "locale": "zh-CN",
      "activePlugins": ["world-init", "narrator"],
      "runtimeModelOverrides": { "narrator": "story" },
      "loreOverride": "The session's captured world lore."
    },
    "characters": [/* ... */],
    "stateSchemas": [/* StateSchemaRecord[] */],
    "stateEntries": [/* ... */],
    "runtimeExports": [/* RuntimeExportRecord[] */],
    "pluginData": [/* ... */],
    "characterSchema": null,
    "sessionSummaries": [/* 当前消息前缀引用的 SessionSummaryRecord[] */],
    "compactedMessageSummaryIds": { "tm_abc": "summary_xyz" },
    "lorebookEntries": [],
    "suspensions": [/* 未解决的 SuspensionRecord[] */],
    "messagesCursor": "tm_abc",
    "displayMessagesBoundary": null
  },
  "createdAt": "2026-04-13T00:00:00.000Z"
}
```

关于 `payload.session.loreOverride`：

- 它保存会话里对世界背景的覆盖文本。空字符串表示玩家明确清空了背景。
- 会话没有覆盖时不带这个字段，继续用世界自己的背景。
- 它随 checkpoint 导出和传输一起保留。
- 快照不复制会话的其他 metadata。owner token、审批范围和会话实例身份由新会话自己生成。

**错误**

| 状态码 | `code`                        | 什么时候                                                              |
| ------ | ----------------------------- | --------------------------------------------------------------------- |
| 404    | `session_not_found`           | 会话不存在                                                            |
| 500    | —                             | 构建快照时的未知错误。生产环境只返回通用 500，不带内部诊断            |
| 500    | `fork_media_reference_failed` | 分叉时写媒体引用失败，正文固定为 `Failed to reference media for fork` |
| 503    | `session_busy`                | 等会话锁超时                                                          |

快照构建和分叉的未知错误都这样处理：底层原因只写进日志。已识别的业务冲突保持各自的 `code` 和状态码。媒体引用失败时，先回滚事务并撤掉已经加上的引用，再返回错误。

#### `GET /api/sessions/:id/snapshots`

分页列出这个会话的快照（`auto` / `manual` / `fork`）。只返回元数据，**不返回 `payload`**：一份 payload 就是整个会话的状态，全部返回会无限变大。需要完整内容时按 id 单独读取（见下一节）。

**请求**

| 参数     | 位置  | 必填 | 说明                                |
| -------- | ----- | ---- | ----------------------------------- |
| `limit`  | query | 否   | 每页条数，默认 50，最大 500         |
| `cursor` | query | 否   | 上一页返回的 `nextCursor`，原样传回 |

- 不带 `cursor`：返回最新的一批。
- 带 `cursor`：返回紧挨着的更早一页。
- 每页内按 `createdAt` 升序排列（最早的在前）。
- 分页约定与 `/messages/page`、trace 分页相同。

**响应**

```json
{
  "items": [
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
  "nextCursor": "<opaque-cursor>"
}
```

- `nextCursor` 是一个不透明字符串，代表本页最早一条快照的位置，用来取更早的一页。返回条数少于 `limit`（已经到最早一份）时为 `null`。
- `payloadSize` 由数据库直接算出，列表不会加载 payload 本身。
- `kind="fork"` 的快照，`parentId` 是来源快照的 id；其余 `kind` 为 `null`。

**错误**

| 状态码 | `code`              | 什么时候        |
| ------ | ------------------- | --------------- |
| 400    | `invalid_cursor`    | `cursor` 不合法 |
| 404    | `session_not_found` | 会话不存在      |

#### `GET /api/sessions/:id/snapshots/:snapshotId`

按 id 读取一份快照，含完整 `payload`，直接返回 `SnapshotRecord`。快照不存在或不属于这个会话时返回 `404`（`code: "not_found"`）。

返回的是快照的玩家可见视图，规则与其他读取接口相同：

- `payload.pluginData` 不含隐藏命名空间（`_hidden.*`）和内核记账行，其余行按插件数据 API 的公开形态给出。
- `payload.runtimeExports` 不含声明了 `io.concealed` 的 runtime 的导出。
- `payload.suspensions` 只给出与 `GET /suspensions` 相同的摘要字段，不含续接上下文（提示词）。

存储里的快照保持完整。分叉和恢复直接读存储，不受这层过滤影响。

#### `POST /api/sessions/:id/fork`

从一份快照造出一个新会话。

**请求**

```json
{ "fromSnapshotId": "<snapshot-uuid>" }
```

| 字段             | 类型   | 必填 | 说明                       |
| ---------------- | ------ | ---- | -------------------------- |
| `fromSnapshotId` | string | 是   | 来源快照，必须属于这个会话 |

**响应**

返回 `201 Created`。

```json
{
  "sessionId": "mistport-<new-uuid8>",
  "parentSessionId": "mistport-a1b2c3d4",
  "fromSnapshotId": "<parent-snapshot-id>",
  "forkSnapshotId": "<child-fork-snapshot-id>",
  "missingMediaCount": 0
}
```

`missingMediaCount` 是分叉用到、但已经不在媒体存储里的文件数，同一个文件只算一次。界面在这些位置显示“媒体不可用”的占位。

**服务端做了什么**

1. 创建新的 `sessionId`（`{worldId}-{uuid8}`）。
2. 从快照恢复会话设置。
3. 把数据拷贝到新会话。
4. 拷贝消息、压缩摘要和界面聊天记录。
5. 在子会话里写一份 `kind="fork"` 的快照，`parentId` 指向来源快照，用来追溯来历。
6. 广播 `session.forked`（SSE topic 为 `session`）。

各步的细节如下。

**第 2 步：恢复会话设置**

- 从 v3 快照恢复 `locale`、`activePlugins`、`status`、`phase`、`completedPlayerTurns`、`setupRuntimes`、`runtimeModelOverrides`。
- 快照带 `loreOverride` 时，把它恢复到子会话。之后父会话或世界背景再怎么改，都不影响这个已保存的值。子快照也保留它，所以可以连续分叉。
- 快照不带 `loreOverride` 表示使用世界背景。服务端不会拿父会话当前的设置去猜当时的值。
- 快照里的 `status: 'ended'` 会改成 `paused`。`ended` 是终态，没有“取消结束”的接口，而分叉就是为了继续玩。

**第 3 步：拷贝数据**

- 拷贝的内容：角色、状态记录、插件数据、角色 schema、状态表结构，以及还没处理的挂起项。
- 快照用必需的 `stateSchemas` 固定了表结构，空数组表示当时没有表。分叉会重建表 ID，并把子会话的表结构写进子快照。父会话之后的修改不影响再次分叉。
- 任何一条状态记录找不到对应的表结构时，返回 `409 snapshot_schema_missing` 并回滚，不会返回一个状态不完整的分支。
- 后台任务和日志这类控制用的命名空间（`_runtime_jobs`、`_runtime_job_control`、`_logs`、`_jobs`）不进子会话，也不进子快照。
- 角色按 `(sessionId, id)` 隔离，拷贝时保留角色 ID，这样插件数据里对角色的引用仍然有效。
- 向量和摄取游标是派生数据，不直接拷贝。提交之后会在后台为子会话重建索引。

**第 4 步：拷贝消息和摘要**

- 从 `turn_messages` 按顺序拷贝消息，直到 `payload.messagesCursor`（含这一条）。游标之后的消息不拷贝。
- 按 `compactedMessageSummaryIds`，拷贝 `payload.sessionSummaries` 里快照时刻实际引用的压缩摘要。子会话的摘要 ID 会重建，消息上的 `compactedAtTurnId` 相应改写。所以父会话之后合并摘要、重新标记历史消息，都不会改变这份旧快照的分叉结果。
- 这些字段是必需的。服务端不会读父会话消息当前的标签去猜历史。
- 游标指向的消息在父会话里已经没有了（被压缩或删除）时，返回 `409 { code: 'cursor_missing' }`。

界面上的聊天记录另外按 `payload.displayMessagesBoundary` 拷贝：

- 保留正文、角色、元数据和显示顺序，重建消息 ID。
- 边界记录的是最新消息的时间戳，以及那一毫秒内已有的全部消息 ID。这样不会混进快照之后同一毫秒的新消息。
- 边界为 `null` 表示没有聊天记录。边界里的消息 ID 找不到时，同样返回 `409 cursor_missing`。
- 子快照写入新的边界，支持继续分叉。

媒体的处理：

- 为拷贝过来的消息里的媒体建立子会话自己的引用。
- 消息、状态和 runtime 导出里用到的、还存在的媒体，都必须已经授权给父会话，否则整个分叉以 `403 media_reference_forbidden` 失败。只知道媒体 ID 不能获得访问权。
- 已经不存在的媒体（例如在媒体库里删掉了）不阻止分叉。子会话照常创建，保留原来的消息和数据，但不得到这个文件的引用。它在子会话里和在父会话里一样显示占位，并计入 `missingMediaCount`。

runtime 导出的处理：

- 快照用必需的 `runtimeExports` 固定了每个“生产者 + 名称”在拍摄时能看到的最新一版导出和它的值。空数组表示没有导出。
- 分叉、连续分叉和 checkpoint 传输都用这份记录，之后同一毫秒内的提交不会混进来。
- 自动快照的时间是全部 proposal 提交完成后实际拍摄的时间。

**错误**

| 状态码 | `code`                        | 什么时候                                            |
| ------ | ----------------------------- | --------------------------------------------------- |
| 400    | —                             | 缺少 `fromSnapshotId`                               |
| 403    | `media_reference_forbidden`   | 用到的媒体没有授权给父会话                          |
| 404    | `session_not_found`           | 父会话不存在                                        |
| 404    | `not_found`                   | 快照不存在，或不属于这个会话                        |
| 404    | `world_not_found`             | 会话关联的世界已经不存在                            |
| 409    | `cursor_missing`              | `messagesCursor` 或聊天边界指向的消息已不在父会话里 |
| 409    | `snapshot_schema_missing`     | 有状态记录找不到对应的表结构                        |
| 409    | `dimension_provider_required` | 快照的维度数据属于某个社区插件，而子会话无法启用它  |
| 409    | `world_deleting`              | 会话关联的世界正在删除                              |
| 429    | `rate_limit_exceeded`         | 超过分叉频率上限，带 `Retry-After`                  |
| 500    | `fork_media_reference_failed` | 写媒体引用失败                                      |
| 500    | `fork_failed`                 | 无法为子会话生成合法的 ID，不创建子会话             |
| 500    | —                             | 其他内部写入失败                                    |
| 503    | `session_busy`                | PostgreSQL 部署下等会话锁超时                       |

其他规则：

- **频率上限**：同一个父会话、同一个客户端地址，每分钟最多 10 次分叉请求。计数发生在校验请求体之前，所有部署层级相同。
- **要么全成，要么全不成**：分叉在父会话的执行锁内读取来源数据，在一个事务里写入。中途任何一步失败都会回滚，不会留下半成品的子会话。
- **世界检查**：提交前检查关联的世界仍然存在而且没在删除。没有关联世界的会话照样可以分叉。

### 角色数据

> [!NOTE]
> 内置 Web UI 主要通过 `GET /api/sessions/:id/view` 拿角色视图。本节的端点是轻量的读取和管理接口。
>
> 插件里写角色请用工具：一批一批追踪角色的 runtime 推荐 `sync-characters`；其他插件可以按需用 `create-character` / `update-character`，读取用 `list-characters` / `get-character`。

#### `GET /api/sessions/:id/characters`

返回会话里的所有角色。角色在游戏过程中被创建和修改。

**请求**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

**响应**

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

角色有别名时，每一项还带 `aliases`。

#### `POST /api/sessions/:id/characters`

创建或更新一个角色：`id` 已存在就更新，不存在就创建。

这个管理端点在内部提交一条 `character.upsert` proposal，所以它和插件写角色走同一条提交流程，相关的 hook 照常运行。会话必须是 `active` 状态。

**请求**

| 参数 | 位置 | 说明    |
| ---- | ---- | ------- |
| `id` | 路径 | 会话 ID |

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

| 字段          | 类型   | 必填 | 说明                                             |
| ------------- | ------ | ---- | ------------------------------------------------ |
| `id`          | string | 是   | 角色 ID，最多 160 字符                           |
| `name`        | string | 是   | 角色名称，最多 256 字符                          |
| `aliases`     | array  | 否   | 别名的完整列表（最多 32 个），写入时替换已有别名 |
| `type`        | string | 否   | 角色类型（如 `player`、`npc`），省略时为 `npc`   |
| `description` | string | 否   | 角色描述，最多 65536 字符                        |
| `fields`      | object | 否   | 自定义属性（JSON）                               |
| `version`     | number | 否   | 版本号，省略时为 `1`                             |
| `createdAt`   | string | 否   | 创建时间，省略时为当前时间                       |

关于别名：

- 别名与另一个角色的名字或别名相同时返回 `400`，见[别名与按名字解析](./world-model.md#别名与按名字解析)。
- 角色有别名时，`GET` 的每个角色、会话视图的 `characters[]` 和 `character.upserted` 事件都带 `aliases`。

**响应**

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

**错误**

| 状态码 | `code`               | 什么时候                                                 |
| ------ | -------------------- | -------------------------------------------------------- |
| 400    | —                    | 请求体不合法，或角色 proposal 被拒绝（`error` 说明原因） |
| 409    | `session_not_active` | 会话不是 `active` 状态                                   |
| 500    | —                    | 意外的存储失败。原因写进日志，响应不带内部细节           |

会话的聚合状态视图也遵守同样的原则：必需的角色或插件数据查询失败时返回 `500`，不会返回一份看起来成功却不完整的视图。

### 事件系统

服务端内部用一条事件总线（EventBus）传递事件。本节有两个端点：一个用 SSE（Server-Sent Events）把事件实时推给客户端，一个从外部往总线里注入事件。

#### `GET /api/events/stream?sessionId=xxx`

订阅一个会话的实时事件流。这是一条 SSE 长连接，可以按 topic 过滤，断线后可以从上次的位置补发。

**请求**

| 参数          | 类型   | 必填 | 说明                                                      |
| ------------- | ------ | ---- | --------------------------------------------------------- |
| `sessionId`   | string | 是   | 会话 ID                                                   |
| `topics`      | string | 否   | 逗号分隔的 topic 过滤（如 `runtime,state`）。省略表示全部 |
| `lastEventId` | string | 否   | 补发这个 ID 之后的事件，用于断线重连                      |

重连也接受标准 `Last-Event-ID` 请求头；同时传入时，`lastEventId` 查询参数优先。游标格式和重置行为见 [订阅流协议](./protocol.md)。

```bash
curl -N "http://localhost:3001/api/events/stream?sessionId=<sessionId>"
```

**响应**

连接成功后收到的第一条消息：

```
event: system.connected
data: {"sessionId":"mistport-a1b2c3d4","topics":"all","cursor":"...","timestamp":"2025-01-15T10:00:00.000Z"}
```

之后是事件。`event:` 一行就是事件类型（`CovelEventType`）本身，服务端不做任何改写。完整清单见 [protocol.md](./protocol.md)。

```
event: execution.completed
data: {"runtimeCount":4,"resultCount":4,"durationMs":2500}
id: example-epoch:1

event: state.changed
data: {"table":"character_stats","field":"hp","value":85}
id: example-epoch:2
```

使用说明：

- 用 `curl -N`（关闭缓冲）才能看到实时输出。
- 连接一直保持，直到客户端断开。
- 服务端每 30 秒发一次心跳（`system.heartbeat`）。
- 只会收到 `sessionId` 匹配的事件。

**错误**

| 状态码 | `code`                             | 什么时候                                           |
| ------ | ---------------------------------- | -------------------------------------------------- |
| 400    | —                                  | 缺少 `sessionId`（`sessionId required`）           |
| 400    | —                                  | `topics` 里有未知的 topic（`Invalid topics: ...`） |
| 404    | —                                  | 会话不存在                                         |
| 429    | `connection_limit_exceeded`        | 这个会话的并发连接太多                             |
| 429    | `global_connection_limit_exceeded` | 整个服务的事件流连接太多                           |

```json
{
  "error": "sessionId required"
}
```

这个端点还按客户端地址限制请求频率（`RATE_LIMIT_RPM`，默认每分钟 60 次）。

#### `POST /api/events/emit`

从外部往事件总线里注入一个事件。可以用来触发某个 runtime，或者模拟游戏事件。

> [!IMPORTANT]
> 这是调试用的端点。`NODE_ENV=production` 时，只有设置了 `ENABLE_DEBUG_PAGE` 才可用，否则返回 `403`。

**请求**

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
| `payload`       | object | 否   | 事件负载，必须是对象   |
| `sessionId`     | string | 是   | 目标会话 ID            |
| `targetRuntime` | string | 否   | 指定接收事件的 runtime |

**响应**

```json
{
  "ok": true,
  "id": "evt-a1b2c3d4"
}
```

**错误**

| 状态码 | `code`               | 什么时候                                                            |
| ------ | -------------------- | ------------------------------------------------------------------- |
| 400    | —                    | 缺少 `topic` 或 `sessionId`，或 `payload` 不是对象                  |
| 403    | —                    | 生产环境没有开启调试（`Event injection is disabled in production`） |
| 404    | `session_not_found`  | 会话不存在                                                          |
| 409    | `session_not_active` | 会话不是 `active` 状态                                              |

### Actions（SSE 桥接）

#### `POST /api/actions`

玩家的每一个游戏动作都从这里进来：发消息、执行命令、回答交互、开局、重试。服务端把动作变成一次回合执行，用 SSE 把结果一段一段地返回。内置前端主要用的就是这个端点。

**请求**

```json
{
  "requestId": "req-001",
  "type": "send_message",
  "sessionId": "mistport-a1b2c3d4",
  "payload": {
    "content": "我拔出剑，准备迎战"
  }
}
```

顶层字段：

| 字段        | 类型   | 必填 | 说明                                |
| ----------- | ------ | ---- | ----------------------------------- |
| `requestId` | string | 是   | 请求关联 ID，会原样出现在每个事件里 |
| `type`      | string | 是   | 动作类型，见下                      |
| `sessionId` | string | 是   | 会话 ID                             |
| `model`     | string | 否   | 这次请求的模型覆盖                  |
| `payload`   | object | 是   | 与 `type` 对应的内容                |

校验规则：

- 顶层只接受上面五个字段。每种动作的 `payload` 也拒绝没有声明的字段。
- 支持的 `type` 共七种：`send_message`、`execute_command`、`submit_interaction`、`start_session`、`retry_turn`、`retry_runtime`、`retry_failed_runtimes`。没列出的 `type` 一律返回 `400`。
- 七种请求都必须带与 `type` 对应的 `payload`，即使它是空对象。
- 请求不能带 `locale`。回合一律使用会话创建时确定的内容语言（`session.locale`），带 `locale` 的请求会被拒绝。
- `requestId`、`sessionId` 和 runtime / 回合 ID 必须是长度有限的安全标识符。
- 不合法的请求在创建回合或写入消息之前就返回 `400`。

各 `type` 的 `payload`：

| `payload` 字段          | 适用 `type`             | 必填 | 说明                                            |
| ----------------------- | ----------------------- | ---- | ----------------------------------------------- |
| `content`               | `send_message`          | 是   | 玩家的自然语言输入                              |
| `command`               | `execute_command`       | 是   | 以 `/` 开头的命令（如 `/look`）                 |
| `turnId`, `submissions` | `submit_interaction`    | 是   | 回答某个回合提出的交互，见[玩家交互](#玩家交互) |
| `loreOverride`          | `start_session`         | 否   | 覆盖世界背景的文本，最多 500000 字符            |
| —                       | `retry_turn`            | —    | `payload` 为空对象                              |
| `runtimeId`             | `retry_runtime`         | 是   | 只重跑这一个 runtime                            |
| `retryFromTurnId`       | `retry_runtime`         | 否   | 指明要修复的是哪个回合里的失败                  |
| `runtimeIds`            | `retry_failed_runtimes` | 是   | 1–20 个不重复的、已启用的 runtime ID            |
| `retryFromTurnId`       | `retry_failed_runtimes` | 是   | 这些 runtime 失败时所在的、已提交的原回合       |

> [!NOTE]
> 玩家输入只有两个字段名：`send_message` 用 `payload.content`，`execute_command` 用 `payload.command`，没有别名。插件里要发事件，请用内置的 `emit-event` 工具。

各类型的补充说明：

- **`start_session` 的 `loreOverride`**：服务端把它保存在会话里。setup、开场接力和之后回合的 `world.lore` 都优先用它。空字符串表示明确清空；省略则保留会话里已经保存的值。Web 的准备页在创建会话时就传入背景，“开始冒险”不再发送世界草稿。
- **`retry_turn`**：用空的玩家输入开始一个新的主循环回合，使用当前已提交的上下文。提交成功后玩家回合数加一。它不会恢复或重新生成历史回合。
- **`retry_runtime`**：按手动触发的方式只重跑指定的 runtime，不推进玩家回合数。
  - 带 `retryFromTurnId` 时：这个回合必须是当前故事里已提交的原回合，而且目标 runtime 现在仍然是失败的。回合不存在时直接拒绝，不会改用别的回合。
  - 不带时：按普通的手动调用处理，使用最近一个已提交的玩家回合的结果（如果有）。
- **`retry_failed_runtimes`**：服务端把 `runtimeIds` 排序，在同一次执行里按阶段和依赖顺序重跑。
  - 在会话锁内核对：所选目标必须全部仍然失败（已提交的重试结果算在内）。
  - 原回合之后已经有已提交的玩家回合或开场接力回合时，拒绝这个旧回合。

##### 批量恢复的边界

`retry_failed_runtimes` 是一次动作、一次会话锁、一次事务提交。它：

- 不追加玩家输入，不推进玩家回合数，不触发开场接力。
- 只把原回合和相关已提交重试里**成功的、非目标**的结果当作上下文。这些结果不会重复提交，也不会重发事件。
- 在目标之间保持正常的输入校验、依赖顺序和相互独立任务的并行。
- 因为依赖失败而被跳过（skipped）的任务，不会被标成“已修复”。
- 保持在前台执行。批量恢复和带明确来源回合的单任务恢复，都不会通过事件订阅、递归调用或后台分发扩大范围。

带来源回合的单任务重试同样核对来源和最新的失败状态。不带来源的普通手动调用和插件 RPC 调用，保留原有的事件链、递归和分发行为。

##### 重试的事件与状态

- 重试产生的 trace 和 SSE 事件的 payload 带 `sourceTurnId`（原回合）和 `runtimeIds`（本次范围）。信封里的 `turnId` 是这次新尝试的 ID。
- 原回合的审计记录不会被修改。
- 只有这次尝试**已提交**，才能把成功的任务算作已恢复。已提交的标志是 `turn.completed` / `execution.completed` 带 `committed: true`，或者有已提交的结果。
- 回滚或中断之后，不能只凭一条 `runtime.completed` 就认为已经恢复。
- 刷新接口只能查看状态，不能重新生成。

服务端确认来源回合已提交后，事件的范围信息里还带两个字段：

| 字段                     | 说明                                    |
| ------------------------ | --------------------------------------- |
| `sourceCommitted`        | 固定为 `true`，证明来源回合已提交       |
| `sourceFailedRuntimeIds` | 来源回合里目前仍然失败的全部 runtime ID |

`sourceFailedRuntimeIds` 的规则：

- 它是完整列表：包括已经停用的 runtime，也不受“一次最多选 20 个”的限制。
- 执行中的事件带的是开始前的失败全集。
- 成功提交后的终态事件里，去掉本次成功的任务，保留失败的和因依赖被跳过的。
- 回滚或中断时保持原样。
- 列表为空时也会显式传一个空数组。

客户端的用法：

- 用最新的列表替换旧的。同一次尝试里，已提交的终态优先于执行中的事件。
- 这样即使原回合的日志或较早的任务事件已经被 trace 窗口裁掉，客户端仍然知道来源回合已提交，以及还剩哪些失败。
- 列表里没有某个 ID，只说明它不在失败集合里了。不能据此显示一个并不存在的成功步骤。

##### 社区插件授权

会话里的社区插件还没有得到授权时，服务端在开始 SSE 和写入回合**之前**返回 HTTP `202` 和一段 JSON：

```json
{ "status": "approval-required", "approvalId": "...", "pending": { ... } }
```

- 客户端通过审批接口给当前会话授权，然后用**同一个 `requestId`** 重发原请求。
- 可能要连续问几次：先是 `covel:plugin-server-code`，再是每个 `runtime:<name>`。
- 普通动作检查的范围：已选插件里参与自动执行的 runtime（按契约依赖解析后的结果）。明确的重试只检查选定的目标。
- 手动 runtime 的普通调用仍然走插件 RPC 的授权。
- 审批被拒绝时不会执行回合。
- `demo` / `commercial` 部署层级还要求运维 token。执行时真正加载代码之前，还会再检查一次授权。
- Web 客户端支持连续审批，并拒绝重复的或属于其他会话的审批响应。

##### `start_session` 的前置条件

会话必须已经有非空的 `activePlugins`，否则返回 `400`（`Session has no active plugins. …`）。

- 插件集合由创建会话时的 `plugins` 数组决定。`start_session` 只负责启用这份已保存的集合。
- 空集合不会变成“启用全部已加载的插件”。那样会把玩家从没选过的社区插件和互相冲突的叙事引擎一起拉进会话，并一直留到会话结束。
- Web 的准备页先读 `GET /api/worlds/:id/plugin-plan` 得到服务端算好的默认集合，再把玩家的最终选择传给创建接口。
- `plugin-plan.defaultPluginIds` 的计算规则与会话相同：`requires`、`conflicts`，以及用可信内置核心插件替换的规则。准备页照这个结果显示，不会把已经被替换掉的核心插件重新锁定。
- 创建会话的接口不再读世界的插件策略。它只补上内置核心插件和 `requires` 关系，并处理 `conflicts`。

##### 开场接力（opening continuation）

玩家提交完开局表单后，不用再手动发一条消息，开场叙事会自动出现。

- **什么时候发生**：一次玩家动作（`send_message` / `execute_command` / `submit_interaction` / `start_session`）完成了**最后一个** setup runtime。setup 执行单独提交，`phase` 切换到 `playing`。
- **发生什么**：同一个请求在同一条 SSE 流上自动接着跑一个主循环回合。这个回合有全新的 `turnId` 和独立的事务，读取刚刚提交的 setup 状态，让叙事 runtime 写出开场。
- **计数**：接力回合以 `origin: continuation` 执行，不增加 `completedPlayerTurns`。
- **事件**：整条流仍然只发**一个** `execution.completed`，用的是接力回合的数据。
- **不接力的情况**：
  - 动作是 `retry_turn` / `retry_runtime` / `retry_failed_runtimes`；
  - 执行被中止（`abortReason`）；
  - 提交失败；
  - setup 还有没完成的项（后面还有开局交互）。

##### 请求头（可选）

| Header                   | 说明                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| `X-Provider-Keys`        | base64(JSON) 的模型服务商密钥。不入库，每次请求都要带                 |
| `X-Plugin-User-Settings` | base64(JSON) 的玩家插件设置 `{ [pluginId]: { [settingKey]: value } }` |

`X-Plugin-User-Settings` 的处理：

- 只发玩家明确改过的值。
- 服务端把它与世界的默认设置（`WorldRecord.metadata.pluginSettings`）合并，玩家的值优先。
- 仍然缺的 key 用插件 manifest 里的默认值补齐。
- 结果进入这次回合，所以玩家在设置里改的插件配置对主回合循环生效。

##### 响应

响应是一条 SSE 事件流。它用**只有 `data:` 的帧**（没有 `event:` 一行），每条 `data:` 是一个 `SseEnvelope` 对象（不是 `ProtocolEvent`）：

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

> [!IMPORTANT]
> 客户端要用 `fetch()` + `ReadableStream` 解析这条流（参考 `apps/web/src/services/api/actions.ts` 的 `sendAction`）。不能用 `EventSource.addEventListener('<type>', …)`，因为帧里没有事件名。带事件名的是 `/api/events/stream`。

### AI 生成

#### `POST /api/ai/ping`

用一次最小的请求测试某个模型能不能用，返回实际用到的服务商、模型和延迟。

**请求**

请求体只能选一种目标：

| 请求体                              | 测试什么                                            |
| ----------------------------------- | --------------------------------------------------- |
| `{ "presetId": "server-preset" }`   | 服务端的一个模型预设                                |
| `{ "modelRef": "local-model-ref" }` | 本地引用，须在 `X-Slot-Config.customPresets` 里声明 |
| `{ "slot": "story" }`               | 某个用途（slot）当前解析出的模型                    |
| `{}`                                | 默认用途                                            |

规则：

- 用途的覆盖放在 `X-Slot-Config.slotBindings` 里，保留 `modelRef` / `presetId` 类型。
- 明确指定的模型不存在时返回 `ok: false`，不会改测别的模型。模型 ID 里的 `slot-` 没有别名含义。
- 没指定目标时测试默认用途。用途没有配置时，允许服务端回退。
- 解析完成后只测选中的那一个模型。即使配置了备用模型，选中的模型失败也返回 `ok: false`，不会拿备用模型的成功来代替。
- 测试用途时保留这个 slot 自己的参数和能力覆盖。slot 名与别的预设 ID 同名时，仍然调用这个用途解析出的模型。
- 模型目录接口不公开其他请求临时注册的模型配置，连接测试也不会从这些配置里暗中挑选目标。

测试方式：

- 文本模型：发一次流式请求，测首字延迟（`ttfbMs`）。
- 评估模型：发一次评估请求，没有 `ttfbMs`。
- embedding 模型：发一次向量请求，没有 `ttfbMs`。
- 每次测试只发一个 HTTP 请求，不做传输层重试。

**响应**

```json
{
  "ok": true,
  "latencyMs": 250,
  "ttfbMs": 180,
  "text": "Hello!",
  "testedTarget": {
    "presetId": "server-preset",
    "provider": "example-provider",
    "model": "example-model",
    "resolvedVia": "direct"
  }
}
```

`resolvedVia` 的取值是 `direct`、`slot`、`tag-fallback` 或 `any`。

失败时除了 `error` 还返回 `errorKind`，取值见[连接测试与失败原因](./slots.md#连接测试与失败原因)：

```json
{
  "ok": false,
  "latencyMs": 12,
  "error": "connect ECONNREFUSED 127.0.0.1:11434",
  "errorKind": "unreachable",
  "testedTarget": { "presetId": "…", "provider": "ollama", "model": "…" }
}
```

**错误**

| 状态码 | `code`                      | 什么时候                                        |
| ------ | --------------------------- | ----------------------------------------------- |
| 400    | `invalid_llm_configuration` | 路由请求头（`X-Slot-Config`）不合法             |
| 400    | —                           | JSON 无效、有未知字段，或同时给了多个互斥的目标 |

请求体或路由校验失败时，不会向模型服务商发请求。

#### `POST /api/ai/models`

读取一个服务商端点提供的模型 ID 列表。设置页在添加服务商或模型时用它来让玩家勾选。

**请求**

```json
{
  "provider": "ollama",
  "baseUrl": "http://localhost:11434/v1",
  "protocol": "openai-chat-v1"
}
```

| 字段       | 类型   | 必填 | 说明                                           |
| ---------- | ------ | ---- | ---------------------------------------------- |
| `provider` | string | 是   | 服务商 ID                                      |
| `baseUrl`  | string | 否   | 端点地址。省略时用内置服务商或已注册服务商的值 |
| `protocol` | string | 否   | 协议。省略时同上                               |

- 密钥取自 `X-Provider-Keys` 请求头。
- 目标按这一次请求处理。服务端环境里的密钥只发往该服务商的可信同源地址。
- 未知字段、未知协议返回 `400`。

**响应**

```json
{
  "ok": true,
  "models": ["codex/gpt-6-luna", "qwen3:8b"],
  "baseUrl": "http://localhost:11434/v1",
  "protocol": "openai-chat-v1"
}
```

- 读取失败时状态码仍然是 `200`：`{ "ok": false, "models": [], "error": "…", "errorKind": "auth" }`。
- 评估协议没有模型列表，返回 `errorKind: "config"`。
- 请求 15 秒超时，最多返回 2000 个 ID。

#### `GET /api/ai/protocols`

返回模型可以配置的全部协议。设置页的协议下拉框用它。

内置协议排在前面，后面是已加载的插件用 `covel.registerWires({ text })` 注册的文本协议，它们的 `id` 是 `<pluginId>/<wireId>`。

**响应**

```json
{
  "protocols": [
    { "id": "openai-chat-v1", "label": "OpenAI Chat", "output": "text" },
    { "id": "acme/converse", "label": "Acme Converse", "output": "text" }
  ]
}
```

#### `POST /api/ai/generate-world`

让模型生成一个世界包。模型根据一段概念和可选的创作简报，决定 `id`、`name`、`tags`、`dimensions` 和 `lore`，还可以同时写出主要角色、资料库、世界规则、题材记忆和开局配置。

响应是 SSE：先是进度，最后是生成好的世界。客户端用 `fetch()` + `ReadableStream` 解析 `data: {...}\n\n` 帧。

**请求**

```json
{
  "concept": "一个被永恒暴风雪笼罩的冰封大陆",
  "locale": "zh-CN",
  "model": "deepseek-v4-flash",
  "saveTarget": "server-file",
  "idleTimeoutMs": 300000,
  "brief": {
    "experienceMode": "traditional-story",
    "content": ["characters", "lorebook", "rules", "opening-kit"],
    "contracts": ["memory.blocks@1"],
    "additionalInstructions": "让三个主要角色共同隐瞒一次失败的远征。"
  }
}
```

| 字段            | 类型   | 必填 | 说明                                                                |
| --------------- | ------ | ---- | ------------------------------------------------------------------- |
| `concept`       | string | 是   | 世界概念描述（最多 4000 字符）。也接受同义键 `prompt`               |
| `locale`        | string | 否   | 语言区域，默认 `zh-CN`                                              |
| `model`         | string | 否   | 覆盖 LLM 模型                                                       |
| `saveTarget`    | string | 否   | 保存目标，默认 `server-file`。可选值见下表                          |
| `brief`         | object | 否   | 结构化的创作简报。省略时只做基础生成                                |
| `idleTimeoutMs` | number | 否   | 等模型下一段输出的最长时间（毫秒）。整数，1000–1800000，默认 120000 |

`idleTimeoutMs` 超出范围返回 `400`。应用自己的设置项从 15 秒起；接口允许低到 1 秒，方便测试超时路径。

`brief` 的字段：

| 字段                     | 类型     | 说明                                                                          |
| ------------------------ | -------- | ----------------------------------------------------------------------------- |
| `experienceMode`         | string   | `traditional-story` 或 `dialogue-mode`；后者同时生成 `defaultViewMode: stage` |
| `content`                | string[] | 内核内容：可选 `characters`、`lorebook`、`rules`、`opening-kit`               |
| `contracts`              | string[] | 插件内容，写数据契约 ID                                                       |
| `additionalInstructions` | string   | 对世界包的补充要求（最多 2000 字符），如角色关系、禁忌、节奏或要避开的内容    |

`contracts` 的可选值来自 `GET /api/framework/authoring` 里带 `generate` 的契约，传其他值返回 `400`。准备失败的契约不会出现在可选列表里；生成和修订继续处理其余内容，`done.warnings` 说明略过了哪个插件、namespace 和契约。

`saveTarget` 的取值：

| `saveTarget`   | 保存位置                              | 持久性来源                     | 适用场景                                                       |
| -------------- | ------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `server-file`  | 服务端 `COVEL_USER_WORLDS_DIR` 世界包 | 服务端文件系统                 | Electron、本机开发、可信私有服务                               |
| `server-store` | 服务端 `DataStore.upsertWorld()`      | `STORE_BACKEND=sqlite` 或 `pg` | 自部署 Web 服务希望复用服务端数据库，并避免长期保留世界包文件  |
| `return-only`  | SSE 响应体                            | 调用方自行保存                 | 浏览器本地 IndexedDB、预览生成结果、公开服务避免写服务端持久层 |

- `server-file` 的目录依次取 `COVEL_USER_WORLDS_DIR`、`$COVEL_HOME/worlds`、`~/.covel/worlds`，与世界包安装入口一致。`COVEL_WORLDS_DIR` 只用于内置世界包。
- `server-store` 和 `return-only` 用生成器校验后的结构化结果组装记录，不写世界包文件。
- 这两个模式保存的 `WorldRecord.metadata`：
  - 去掉文件路径类的 `worldDataPath`、`worldData` 和 `dimensionSources`；
  - 保留已归一化的 `metadata.dimensions`；
  - 用 `metadata.embeddedCharacters` 和 `metadata.embeddedLorebook` 携带校验过的角色、资料和规则文本。
- 创建会话时，文件世界优先读世界包里的数据源；没有世界包目录时用这份随记录携带的内容。这样保存在数据库或浏览器里的世界不会丢掉补充内容。

**谁可以调用**

- `demo` / `commercial` 部署层级：所有 AI 世界生成请求都要求运维 token。
- `self` 部署且生产环境实际使用 MemoryStore 时：`server-file`（包括省略 `saveTarget` 的默认值）和 `server-store` 在生成和写入之前要求运维 token。`return-only` 仍然公开，因为它不改服务端共享的世界。

##### 生成过程

新世界按**部分**逐个生成，每个部分是一次模型请求，顺序是：

1. 世界清单（`manifest`）
2. `WORLD.md`（`lore`）
3. 简报里要求的每一类补充内容（`characters`、`lorebook`、`rules`）
4. 每个插件数据契约（`contract:<契约 ID>`）

后面的部分会拿到前面已经写好的部分作为上下文。

服务端把文本内容写成一个按约定路径布局的世界包：

- `WORLD.md`
- `data/dimensions.yaml`
- `characters/characters.json`
- `data/lorebook.yaml`
- 每个插件数据契约的文件，放在接收它的插件声明的路径上（如 `data/memory-blocks.json`）

文件都在约定路径上时，世界包不需要额外的数据源描述，详见 [World Data](./world-data.md)。

语言和角色：

- 新世界的 `defaultLocale` 和唯一的一项 `supportedLocales`，固定为规范化后的请求 `locale`（缺省 `zh-CN`）。各种保存目标和文件导出都用这一份声明。
- 角色部分按生成出来的清单里的角色 schema 校验整个集合：声明的类型、字段约束、`player` 只能有一个。校验失败按下面的重试和舍弃规则处理。

##### 校验与重试

每个部分一到达就做确定性的结构校验。不合法时只重新请求这一个部分（最多 3 次），已经通过的部分不会重写。

`WORLD.md` 里明显混进了生成过程的痕迹（测试、提示词或模型输出等）时，服务端先请求一次只针对 lore 的定向修复。修复后仍不合法，才重新请求 lore。

- `manifest` 或 `lore` 三次都失败时，整个生成失败。
- 补充内容或契约数据三次都失败时，世界照常创建，只是没有这一部分，`done` 帧的 `warnings` 说明缺了什么；之后可以用 `revise-world` 补上。
- 校验完成前不会写入半成品。

##### 等待时间

模型请求按**无响应时间**限时，不按总时长：

- 模型每输出一段正文或推理，计时重新开始。所以输出慢但一直在输出的模型，可以写完很长的内容。
- 连续 `idleTimeoutMs` 没有任何输出才算超时。
- 不支持流式的适配器一次返回整个回答，这时无响应时间就等于整个请求的时长。
- 单次请求另有 30 分钟的总上限，只用来结束永不停止输出的模型。

无响应超时**不重试**。这个时间是玩家愿意等的上限，重试只会让玩家多等几倍才知道模型没有响应。

- `manifest` 或 `lore` 超时：生成立即失败。
- 补充部分超时：这一部分和它之后的部分都不再请求。世界用已经写好的部分创建，`warnings` 逐条列出缺少的部分。

所以模型不响应时，最多等一个 `idleTimeoutMs` 就有结论。

##### 响应帧

**响应 200:** SSE 帧。

```text
data: {"type":"progress","phase":"generating"}

data: {"type":"progress","phase":"generating","parts":[{"id":"manifest","state":"pending"},{"id":"lore","state":"pending"},{"id":"characters","state":"pending"}]}

data: {"type":"progress","phase":"generating","parts":[{"id":"manifest","state":"done","attempt":1,"chars":1840},{"id":"lore","state":"active","attempt":1,"chars":412},{"id":"characters","state":"pending"}]}

data: {"type":"progress","phase":"validating"}

data: {"type":"progress","phase":"saving"}

data: {"type":"done","world":{"id":"frost-continent","name":"冰封大陆","metadata":{"storage":{"scope":"server","backend":"file","durable":true}}}}
```

`phase: "generating"` 的 `progress` 帧带 `parts`：这次生成的全部部分和各自的进度。每一帧都是完整列表，客户端直接用最新一帧渲染。部分开始、收到新内容（最多每 400 毫秒一帧）、重试和结束时各发一帧。

| `parts[]` 字段 | 类型   | 说明                                                                                             |
| -------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `id`           | string | `manifest`、`lore`、`characters`、`lorebook`、`rules`、`contract:<契约 ID>`；修订时是 `revision` |
| `title`        | string | 插件数据契约的名称；其他部分没有这个字段，由客户端命名                                           |
| `state`        | string | `pending`、`active`、`done` 或 `failed`                                                          |
| `attempt`      | number | 这个部分的第几次请求，从 1 开始                                                                  |
| `chars`        | number | 当前这次请求已经收到的正文字符数                                                                 |

`done` 帧里的 `world.metadata.storage` 标明世界实际保存在哪里：

```json
{
  "scope": "server",
  "backend": "pg",
  "durable": true
}
```

`done` 帧可以带 `warnings`（字符串数组），说明结果与创作简报的差距。这时世界本身是合法的，可以玩：

```text
data: {"type":"done","world":{...},"warnings":["generated 3 lorebook entries; the brief asks for 4","dropped dimension \"discoveries\": schema.properties.visited: Unrecognized key: \"boolean\""]}
```

- 某类内容数量低于目标（角色 3、资料库 4、规则 3、开局资源 2）时接受结果并给出 warning；被请求的内容一条都没有时才判为失败并重试。
- 无法通过校验的维度被单独丢弃并给出 warning，其余维度保留。
- 某个补充部分没能生成时给出 `<部分> could not be generated: <原因>`，世界里没有这一部分；模型停止响应后没有再请求的部分给出 `<部分> was not requested: the model stopped answering`。
- 没有 warning 时不带这个字段。

`done` 帧还带 `usage: { inputTokens, outputTokens, requests }`：

- 它是这次生成里每一次模型回答的 token 之和，包括重新请求的部分、被截断而没有采用的回答和 lore 修复。
- `requests` 是计入的回答数。
- 生成失败时，`error` 帧带同样的字段。
- 模型没有报告用量时不带这个字段。
- 服务端日志同时记录这三个数。`revise-world` 相同。

##### 错误

请求体不合法时，在开始流式响应之前返回 HTTP `400` 和标准错误信封。

**响应 400:** `{ "error": "concept (string) is required" }`、`{ "error": "saveTarget must be \"server-file\", \"server-store\", or \"return-only\"" }` 或 `{ "error": "idleTimeoutMs must be an integer from 1000 to 1800000" }`

生成开始之后的失败（模型、校验或写入）通过 HTTP `200` 的 SSE 帧返回：

```text
data: {"type":"error","message":"..."}
```

- 最后一次请求因为模型在 `idleTimeoutMs` 内没有任何输出而失败时，帧里带 `"code":"model_idle_timeout"`。客户端据此提示用户调大等待时间。
- 内容校验失败、模型没有输出或输出不完整，都会在帧里说明原因。
- 未知的模型请求异常只把详情写进服务端日志，帧里提示检查模型配置或日志。生产环境的其他未知异常返回 `Internal server error`。
- 修订冲突时保留“请重新加载”的提示。发布和恢复同时失败时，错误里保留完整的备份路径，供有权限的操作者恢复。

##### Web 前端如何选择保存目标

Web 前端每次生成前先等 `/api/health` 成功，再根据 `storage.data.frontendMode` 选择保存目标：

| `frontendMode` | `saveTarget`   | 之后                                   |
| -------------- | -------------- | -------------------------------------- |
| `local`        | `return-only`  | 客户端把世界存进用户的浏览器           |
| `remote`       | `server-store` | 服务端通过 `packages/store` 的后端保存 |
| 响应里没有     | `server-file`  | 服务端写世界包文件                     |

- `local` 模式下，客户端通过 `LocalDataService.saveGeneratedWorld()` 在世界锁内确认这个 ID 还没被占用，再保存，并把 `world.metadata.storage` 标为 `{ "scope": "browser", "backend": "indexeddb", "durable": true }`。
- 健康检查失败或还没完成时，不会发起模型调用。失败后保留创作简报，方便重试。等待期间取消，就不再发起生成。
- 浏览器里的生成结果与已有的本地世界同 ID 时（包括生成期间另一个窗口创建的世界），保存失败，原世界保留。要修改已有世界，必须走带请求基线的修订路径。

#### `POST /api/ai/revise-world`

按玩家的一句话修改一个**由生成器创建**的世界，比如“改成三个派系”“加一个对手”。

模型拿到世界当前的完整内容和这条要求，按 `generate-world` 的三段格式返回，但只写它改动的部分。服务端把它写的内容合并到当前世界上：

- 没改的段写 `UNCHANGED`，整段沿用；
- `WORLD_YAML` 里只写改动的字段，`dimensions` 按维度 ID 合并（写 `null` 表示删除这个维度）；
- `WORLD_PACKAGE_YAML` 里只写新增或改动的条目，按 `id` 合并进所在列表（`contractData` 按 `contract` + `key`）；删除一条写 `{ id, remove: true }`。

所以“加一个角色”不会改动其他角色，也不会丢掉模型没有重复写出的设定条目。合并后的结果与新生成的世界走同一套校验，世界的 `id` 不变。

- 角色校验覆盖合并后的完整集合，包括没改动的角色。整包不合法时会重试，最终仍不合法就返回失败。服务端不会靠丢掉现有角色来让修订成功。
- 新建世界时“只声明一种语言”的规范化，不用于修订。

**请求**

```json
{
  "worldId": "frozen-continent",
  "instruction": "加一个与主角争夺同一目标的对手"
}
```

| 字段            | 类型   | 必填 | 说明                                                                   |
| --------------- | ------ | ---- | ---------------------------------------------------------------------- |
| `worldId`       | string | 是   | 要修改的世界                                                           |
| `instruction`   | string | 是   | 修改要求（最多 2000 字符）                                             |
| `world`         | object | 否   | 由浏览器保存的世界，随请求带上它的 `WorldRecord`                       |
| `model`         | string | 否   | 覆盖 LLM 模型                                                          |
| `idleTimeoutMs` | number | 否   | 等模型下一段输出的最长时间（毫秒），含义和范围与 `generate-world` 相同 |

关于 `world`：

- 带了 `world` 时，结果始终只返回，不写服务端。服务端即使有同 ID 的镜像或目录记录也不看。
- 其中按语言分开写的文本，按世界的内容语言取值。
- `world` 不合法时返回 `400`，不会改用服务端同 ID 的世界。

**哪些世界可以修改**

只有带生成标记的世界可以修改：`metadata.generated === true`。

- 生成器写出的世界包里有一个 `.covel-generated.json` 文件，世界记录据此带上这个标记。这个文件列出应用写进包里的每个文件和它内容的哈希。
- 手写的或安装的世界包没有它。这类包里可能有立绘、额外的数据源和语言文件，整包重写会丢掉它们。
- 生成的世界包里，有人手工加入了文件，或者改过应用写的文件时，请求返回 `409 world_package_modified`，包保持原样。`details.added` 是加入的文件，`details.changed` 是改过的文件。检查在调用模型之前做一次，替换包之前再做一次。
- 应用自己翻译出来的语言文件会记进这份列表，所以翻译过的世界仍然可以修改。删掉列表里的文件不算改动。`.DS_Store`、`Thumbs.db` 和 `desktop.ini` 不参与比较。
- 标记文件里没有文件列表时（旧版本写出的包），世界不算生成的世界，返回 `409 world_not_revisable`。

**结果写到哪里**

世界在哪里，结果就写回哪里：

| 世界的位置     | 写回方式                                     |
| -------------- | -------------------------------------------- |
| 磁盘上的世界包 | 整包替换                                     |
| `server-store` | 更新世界记录                                 |
| 浏览器         | 只返回结果，由客户端保存，服务端不写任何东西 |

整包替换的保护：

- 新包就位之前，旧包一直保留。
- 发布失败时恢复旧目录。
- 恢复也失败时，旧包保留在 `.covel-replaced-*/package`。错误会报告这个路径，服务端不删除它。

修订对语言版本和会话的影响：

- 修订会移除这个世界已有的其他语言版本，因为译文不再与内容对应。需要的话重新翻译。
- 修订结果的清单只声明世界自己的语言。模型的回答或修订要求（例如“加一个英文版”）在清单里多写的语言版本会被去掉，因为修订不写任何语言文件。
- 已经开始的会话不受影响，它们在创建时已经导入了世界内容。

**响应**

SSE 事件与 `generate-world` 相同（`progress` → `done` / `error`）。修订是一次模型请求，`parts` 里只有一个 `revision`。

**并发修改**

- 模型运行期间，服务端不持有世界的操作锁。发布时才在锁内核对原记录和文件包的身份。
- 这段时间里世界被编辑、删除或替换时，这次修订失败。已有的编辑和新包都保留，玩家重新加载后可以再发起修订。
- 浏览器保存 `done` 结果时，也在跨窗口的世界锁内，与请求开始时的完整世界做比较。另一个窗口在这期间编辑、删除或替换了世界时，拒绝本地保存，保留当前记录和玩家的修订要求。重新加载世界后可以重试。

**错误**

| 状态码 | `code`                   | 含义                                                                                  |
| ------ | ------------------------ | ------------------------------------------------------------------------------------- |
| 400    | —                        | 缺少 `worldId` 或 `instruction`，`instruction` 过长，或 `idleTimeoutMs` 超出范围      |
| 404    | `world_not_found`        | 服务端没有这个世界，请求里也没有带 `world`                                            |
| 409    | `world_not_revisable`    | 世界没有生成标记（内置、手写或安装的世界包改文件，不走这个接口）                      |
| 409    | `world_package_modified` | 生成的世界包里有手工加入或改过的文件。`details` 是 `{ added, changed }`，包没有被改动 |
| 409    | `world_deleting`         | 世界正在删除                                                                          |

### Trace 调试

Trace 是服务器为每个回合记下的调试事件：哪个 runtime 开始了、调了哪个模型、哪个工具失败了。调试页 `/debug` 读的就是这三个端点。

三个端点共用这些规则：

- 事件按时间从旧到新排列。
- 响应里的 `nextCursor` 是一个不透明字符串。它不为 `null` 时，说明还有更早的事件；把它原样作为 `?cursor` 再请求，就能读到更早的一段。
- 非法的 `cursor` 返回 `400 { "code": "invalid_cursor" }`。
- `discovery` 是这个会话的插件和 runtime 发现快照，调试页用它显示名称。

#### `GET /api/traces/:sessionId`

获取会话最近的 trace 事件。

- 一次最多返回 5000 条。一条 trace 事件可能带着整份提示词，所以长会话的全部事件不会一次读出来。
- 会话的事件多于 5000 条时，`nextCursor` 不为 `null`。把它作为 `?cursor` 再请求本端点或 `/turns/page`，可以读到更早的事件。
- `discovery` 只在不带 `cursor` 的请求里返回。
- `count` 是本次返回的条数。

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
      "id": "trace-event-001",
      "type": "runtime.started",
      "requestId": "",
      "traceId": "8f1c2d3e-…",
      "sessionId": "mistport-a1b2c3d4",
      "turnId": "turn-001",
      "flowId": "8f1c2d3e-…",
      "seq": 0,
      "timestamp": "2025-01-15T10:00:00.000Z",
      "diagnostic": {
        "displayType": "runtime.started",
        "severity": "info",
        "runtimeId": "narrator",
        "pluginId": "story",
        "stage": "narrative"
      },
      "payload": {
        "runtimeId": "narrator",
        "pluginId": "story",
        "stage": "narrative"
      }
    }
  ],
  "nextCursor": null
}
```

事件的字段：

| 字段         | 说明                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `id`         | `trace_events` 表里这一行的 ID。合并分页、选中事件、复制链接都用它。不要假设 `seq` 非零或唯一。                   |
| `eventOrder` | 事件在本次响应里的序号，从 `0` 开始，按记录的时间顺序排。它不是数据库的全局序号：只在一页之内稳定，不能跨页比较。 |
| `flowId`     | 等于这条事件的 `traceId`。                                                                                        |
| `requestId`  | 事件 payload 带 `requestId` 时取它的值，否则是空字符串 `""`。                                                     |
| `timestamp`  | 这条 trace 记录写入的时间。                                                                                       |
| `diagnostic` | 服务器从 payload 里提取的调试摘要，见下。                                                                         |
| `payload`    | 事件的原始内容，不做改动，用于详细检查。                                                                          |

`diagnostic` 的内容：

- 始终包含 `displayType` 和 `severity`。
- 按事件类型提供 `runtimeId`、`pluginId`、`stage`、`operation`、`provider`、`model`、`slot`、`attempt`、`durationMs`、`startedAt`、`error`、`warning`、`tool`、`prompt`。
- 摘要只读取 payload 的顶层字段。
- `severity` 是 `info`、`warning` 或 `error`。同时有错误和慢调用警告时，取 `error`。
- `warning`：成功的 LLM、gateway、utils、tool、runtime 调用或任务，耗时达到 1000ms 时带 `warning: { code: "slow", thresholdMs: 1000 }`。
- `error`：失败详情在 `diagnostic.error.{message,code?,details?}`。
- `prompt`：提示词摘要。`contentAvailable` 表示正文是否已记录，`contentPath` 指向正文所在的 `payload.messages`。
- `tool`：工具名、call ID、参数和结果是否存在、它们在原始 payload 里的路径；能推断时还给出 `success` 和 `durationMs`。参数和结果的正文只在原始 `payload` 里。

`llm.calling` 事件另有 `payload.startedAt` / `diagnostic.startedAt`，是模型请求真正开始的时间。模型调用的耗时以 `llm.responded` 的 `durationMs` 为准。

#### `GET /api/traces/:sessionId/turns`

返回按回合分组的 trace 事件。

读取的范围、`?cursor`、`nextCursor` 和 `discovery` 的规则与 `GET /api/traces/:sessionId` 相同，最多 5000 条事件。5000 条的边界可能把一个回合切成两半：继续读更早的事件后，按 `turnId` 把它们合并。

**响应:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
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
  ],
  "nextCursor": null
}
```

#### `GET /api/traces/:sessionId/turns/page`

只取最近的一小段事件，按回合分组返回。调试时间线用它一页一页地加载：`trace_events` 是增长最快的表，而 `/turns` 一次读取的量是这里单页上限的十倍。

**参数:**

| 参数        | 位置 | 说明                                                       |
| ----------- | ---- | ---------------------------------------------------------- |
| `sessionId` | 路径 | 会话 ID                                                    |
| `limit`     | 查询 | 每页的**事件**数（不是回合数），默认 400，上限 500         |
| `cursor`    | 查询 | 上一页响应的 `nextCursor`；非法值返回 `400 invalid_cursor` |

分页单位是事件，所以一个回合可能被页的边界切开。加载更早的一页后，按 `turnId` 合并边界上的回合。`nextCursor` 指向本页最旧的那条事件。

**响应:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "turns": [
    { "turnId": "turn-008", "startedAt": "…", "completedAt": "…", "eventCount": 6, "events": [...] }
  ],
  "nextCursor": "<opaque>",
  "discovery": {
    /* 与 /turns 相同 */
  }
}
```

`nextCursor` 为 `null` 时，表示已经读到 trace 的起点。

### 媒体管理

媒体指 MediaStore 里保存的图片、音频、视频和其他文件。每个文件的 ID 是它内容的 SHA-256。

#### `GET /api/media/:id?token=<signed>`

下载一个媒体文件。`token` 是一个短时有效的签名，用 `GET /api/sessions/:id/media-token?id=<mediaId>` 申请。

#### `POST /api/media/cleanup`

删除没有被引用的媒体。这是破坏性的维护端点。

它先扫描 `messages`、`plugin_data`、`runtime_outputs`、`trace_events`、`snapshots`、`turn_results`，收集仍被引用的 mediaId，再调用 `MediaStore.cleanup()` 删掉其余的。

每次清理还会释放世界数据导入留下的、创建已满 24 小时的临时引用（`world-data-import:<uuid>`）。演练只在 `expiredRefs` 里列出它们，真正的清理移除它们。更新的临时引用继续保护它的文件。这个时限是固定的，规则见 [媒体存储](./media-store.md#世界数据导入时的临时引用)。

> [!WARNING]
> 这个端点默认禁用，必须设置 `COVEL_MEDIA_CLEANUP_ENABLED` 才能用。真正删除还要带确认头。

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

| 字段              | 类型    | 必填 | 说明                                                                                          |
| ----------------- | ------- | ---- | --------------------------------------------------------------------------------------------- |
| `dryRun`          | boolean | 否   | 默认 `true`，只返回打算删除的清单。`false` 才真正删除，并且要带 `X-Confirm-Cleanup: yes` 头。 |
| `maxBytes`        | 非负数  | 否   | 原样传给 `MediaLifecyclePolicy`。                                                             |
| `maxAgeMs`        | 非负数  | 否   | 同上。                                                                                        |
| `keepRecentBytes` | 非负数  | 否   | 同上。                                                                                        |
| `scanLimit`       | 正整数  | 否   | 单个会话最多扫描多少行，默认 1000。超过就拒绝请求，不会悄悄截断；需要时由运维显式调大。       |

**成功响应（200）:**

```json
{
  "ok": true,
  "policy": {
    "dryRun": true,
    "expireRefs": {
      "sessionIdPrefix": "world-data-import:",
      "maxAgeMs": 86400000
    },
    "maxBytes": 0
  },
  "result": {
    "scanned": 12,
    "protected": 7,
    "retained": 7,
    "deleted": 5,
    "totalBytes": 1048576,
    "bytesDeleted": 524288,
    "bytesRetained": 524288,
    "protectedIds": ["..."],
    "deletedIds": ["..."],
    "expiredRefs": [
      {
        "mediaId": "...",
        "sessionId": "world-data-import:...",
        "pluginId": null,
        "createdAt": "2026-10-01T08:00:00.000Z"
      }
    ]
  }
}
```

**错误:**

| 状态码 | `code`                    | 什么时候                                                                                                                          |
| ------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 503    | `unavailable`             | `DEPLOYMENT_TIER=commercial`。商业部署里这个端点始终不可用。错误消息是 `cleanup endpoint not available in this deployment tier`。 |
| 401    | `operator_token_required` | `DEPLOYMENT_TIER=demo`，并且没有提供正确的运维 token。                                                                            |
| 403    | `forbidden`               | `COVEL_MEDIA_CLEANUP_ENABLED` 没有设为 `true` 或 `1`。错误消息是 `cleanup endpoint disabled`。                                    |
| 400    | `invalid_request`         | `dryRun: false`，但没有 `X-Confirm-Cleanup: yes` 请求头。                                                                         |
| 400    | `limit_exceeded`          | 某个会话的扫描行数超过 `scanLimit`。错误消息以 `scan limit exceeded for session` 开头。                                           |
| 429    | `operation_in_progress`   | 上一次清理还没结束，又来了一次请求。错误消息是 `Operation already in progress`。                                                  |

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

> [!NOTE]
> `COVEL_MEDIA_CLEANUP_ENABLED` 是服务器进程的环境变量，要在启动服务器时设置。
>
> 会话超过 100 个时，扫描按 50 个一批进行，并在服务器日志里输出进度：`[media-scan] scanned X/Y sessions`。

#### `GET /api/media/library`

列出玩家的媒体库：MediaStore 里保存的图片、音频、视频和其他文件，以及每一项被哪些会话使用。设置里的“已存储的媒体”页面读这个接口。它只读，不删除任何内容。

**可用范围：** 只在一个玩家拥有全部数据的部署里可用，也就是 `DEPLOYMENT_TIER=self` 和桌面端。下面两种部署一律返回 503 `{ "code": "unavailable" }`，带运维 token 也一样：

- `demo` / `commercial`；
- 生产环境的浏览器私有档（MemoryStore）。

原因是这些部署里媒体由多个所有者共享，又没有按所有者划分的索引。

**查询参数：**

| 参数        | 说明                                                                |
| ----------- | ------------------------------------------------------------------- |
| `kind`      | `image` / `audio` / `video` / `other`，按 MIME 类型过滤；省略为全部 |
| `usage`     | `unused`（没有任何会话使用）或 `in-use`（其余全部）；省略为全部     |
| `limit`     | 每页条数，默认 60，上限 200                                         |
| `offset`    | 起始位置，默认 0；按创建时间从新到旧                                |
| `refresh`   | `1` 时重新扫描会话，否则复用 30 秒内的上一次扫描                    |
| `scanLimit` | 单个会话最多扫描多少行，默认 200000                                 |

某个会话的行数超过 `scanLimit` 时，扫描算作不完整（见下面的 `scan`）。读不完的会话不会被当作“没有引用”。

`limit`、`scanLimit` 不是正整数，或 `offset` 不是非负整数时，返回 400 `{ "code": "invalid_request" }`。

**响应（200）：**

```json
{
  "items": [
    {
      "id": "<sha256>",
      "mime": "image/png",
      "kind": "image",
      "size": 482113,
      "createdAt": "2026-10-01T10:00:00.000Z",
      "name": "gate.png",
      "usage": "used",
      "usedBy": ["lantern-barrow-1a2b3c4d"],
      "url": "/api/media/<sha256>?token=<signed>"
    }
  ],
  "total": 132,
  "offset": 0,
  "limit": 60,
  "sessions": [
    {
      "id": "lantern-barrow-1a2b3c4d",
      "worldId": "lantern-barrow",
      "status": "active",
      "completedPlayerTurns": 12,
      "createdAt": "2026-09-30T08:00:00.000Z",
      "updatedAt": "2026-10-01T10:00:00.000Z"
    }
  ],
  "totals": {
    "count": 132,
    "bytes": 91234567,
    "unusedCount": 40,
    "unusedBytes": 30123456,
    "byKind": {
      "image": { "count": 120, "bytes": 0, "unusedCount": 38, "unusedBytes": 0 }
    }
  },
  "scan": { "complete": true, "scannedAt": "2026-10-10T09:00:00.000Z" }
}
```

每一项的 `usage` 有四个值：

| `usage`   | 含义                                                                                         |
| --------- | -------------------------------------------------------------------------------------------- |
| `used`    | 至少一个现存会话在使用，`usedBy` 列出这些会话。                                              |
| `unused`  | 完整扫描后，没有任何使用者。                                                                 |
| `held`    | 没有现存会话使用，但还被别的持有者占着：进行中的世界数据导入，或者会话已经不存在的遗留引用。 |
| `unknown` | 扫描不完整，并且没找到使用者。                                                               |

只有 `unused` 计入 `totals.unusedCount` 和 `totals.unusedBytes`。

其他字段：

- **什么算“被会话使用”**：会话是这个文件的所有者；或者持有显式引用（`media_refs`）；或者它的 `messages`、`plugin_data`、`runtime_outputs`、`trace_events`、`snapshots`、`turn_results` 任意一行里出现了这个 mediaId。
- **`scan`**：`complete: false` 时带 `incompleteSessionId`，表示这个会话的行数超过了 `scanLimit`。这时没有任何一项是 `unused`。
- **`totals`**：统计整个媒体库，不受 `kind` / `usage` 过滤影响。
- **`sessions`**：只包含本页条目提到的会话。
- **`url`**：一小时内有效的签名地址，可以直接用于 `<img>` / `<audio>` / `<video>`。服务器没有缩略图，这个地址返回的是原文件。

> [!NOTE]
> 世界包目录里的文件（`worlds/<id>/media`、封面、立绘）不是 MediaStore 的内容，不会出现在这里。

#### `POST /api/media/library/delete`

按玩家的选择删除媒体。可用范围与 `GET /api/media/library` 相同，其他部署返回 503。每次请求都重新扫描会话，不使用列表的缓存。

**请求体（三种之一）：**

```json
{ "ids": ["<sha256>", "<sha256>"] }
```

```json
{ "unused": true }
```

```json
{ "ids": ["<sha256>"], "force": true }
```

| 字段        | 说明                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ids`       | 1 到 1000 个 ID。只删除其中当前为 `unused` 的；其余原样保留，并在 `skipped` 里说明原因。                                             |
| `unused`    | `true` 时删除所有当前为 `unused` 的。                                                                                                |
| `force`     | `true` 时只接受恰好一个 ID。不管它是否还在使用都删除，并一起删掉所有会话对它的引用。之后，用到它的会话在原位置显示“媒体不可用”占位。 |
| `scanLimit` | 可选，含义同列表接口。                                                                                                               |

**响应（200）：**

```json
{
  "deletedIds": ["<sha256>"],
  "bytesDeleted": 482113,
  "skipped": [{ "id": "<sha256>", "reason": "in_use" }]
}
```

`skipped[].reason` 的取值：

- `in_use`：有会话在使用，包括扫描之后才被引用的。
- `held`：被不是现存会话的持有者占着。
- `not_found`：找不到这个 ID。

**错误:**

| 状态码 | `code`            | 什么时候                                                        |
| ------ | ----------------- | --------------------------------------------------------------- |
| 503    | `unavailable`     | 这个部署不提供媒体库                                            |
| 400    | `invalid_request` | 请求体不是上面三种之一                                          |
| 409    | `scan_incomplete` | 非 `force` 请求，并且有会话的行数超过上限。这时不删除任何内容。 |

## SSE 协议

SSE 是服务器向客户端持续推送事件的方式。Covel 有两条独立的 SSE 流，它们的帧格式和信封格式都不一样：

| 端点                     | 帧形态                                     | 信封                | 用途             |
| ------------------------ | ------------------------------------------ | ------------------- | ---------------- |
| `POST /api/actions`      | data-only（`data: {...}`，无 `event:` 头） | `SseEnvelope`       | 回合内的主流     |
| `GET /api/events/stream` | 命名事件（`event: <type>\ndata: {...}`）   | `SubscriptionEvent` | 回合外的辅助通道 |

- **`POST /api/actions`**：信封带 `requestId` / `traceId` / `flowId` / `seq`。它承载一个回合里的叙事文本、runtime 生命周期、工具调用 trace 等。
- **`GET /api/events/stream`**：信封带 `id` / `topic` / `type`，事件由 EventBus 广播。它承载跨会话通知、持久订阅和断线重连后的补发。
- 两条流在 Web 客户端里都用 `fetch()` + `ReadableStream` 读取（`api.ts` 的 `sendAction` 和 `subscription.ts`）。

> [!IMPORTANT]
> `/api/actions` 用的是 data-only 帧，所以**不能**用 `EventSource.addEventListener` 订阅。只有 `/api/events/stream` 是命名事件。

**客户端怎样解析流**

- 支持 LF、CRLF 和 CR 三种换行。
- 只在空行处提交一个完整事件。流结束时，没有结束的帧不会补发。
- 取消，或者事件处理失败时，释放 reader 并取消没结束的响应。
- 已经关闭的订阅，不会因为迟到的响应而恢复连接状态。
- GET 重试的等待同样响应取消。带自定义 abort reason 的取消不会继续重试，也不会弹出网络错误。

**Web 客户端什么时候暂停辅助订阅**

标签页被隐藏，或者本页正持有一条 `/api/actions` 执行流时，Web 客户端暂停 `/api/events/stream`，把浏览器的同源 HTTP 连接让出来。执行流继续运行。

页面可见，并且所有行动流都结束后，客户端这样恢复：

1. 用保存的事件游标重连。
2. 重新读取服务器上的会话状态，补齐暂停期间的插件数据、消息和后台任务。

另外：

- 第一次就在后台打开的页面，也执行这套恢复。
- 暂停或关闭之前发出的请求，响应迟到时不会重建旧连接。
- 恢复消息时，按回合和内容把玩家本地回显换成服务器的记录，避免因为消息 ID 不同而显示两遍。

**浏览器 local 存储模式下收到 404**

辅助订阅收到 404 时，客户端按下面的顺序恢复：

1. 通过 workspace 的同会话队列上传本地 checkpoint，恢复服务器上的镜像。
2. 清空事件游标。
3. 重连。

细节：

- 暂停与恢复会复用还没结束的上传。
- 已经关闭或切换了会话的订阅不会重新连接。还没进入队列临界区的旧上传会被取消。
- remote 模式不触发这套恢复，401 / 403 也不触发。
- 连续的客户端错误仍有重试上限。

### 事件类型枚举（`CovelEventType`）

完整定义在 `packages/shared/src/types/protocol.ts`。所有从服务器发往客户端的事件，都属于同一个联合类型 `CovelEvent`，事件名的类型就是 `CovelEventType`。

一个事件是否转发到 `/api/actions` 流，由 `COVEL_EVENT_META[type].forwardToActionStream` 决定。转发白名单 `FORWARDED_EVENT_TYPES` 完全由这份元数据生成。

完整的分类表见 [protocol.md § 一、事件类型](./protocol.md#一事件类型covelevent)。

| 类型                            | 分类         | 说明                                                                              |
| ------------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `narrative.delta`               | 叙事         | 叙事文本增量（逐 token 流式）                                                     |
| `narrative.completed`           | 叙事         | 叙事文本完成                                                                      |
| `interaction.requested`         | 交互         | 请求玩家输入（表单/选择/确认）                                                    |
| `ui.rendered`                   | UI           | `ui.render` proposal 提交后发出                                                   |
| `ui.part.update`                | UI           | UI part 状态更新（每个 part 一条）                                                |
| `state.changed`                 | 状态         | 游戏状态变更                                                                      |
| `state.snapshot.created`        | 状态         | 自动、手动或 fork 写入快照后发出                                                  |
| `session.forked`                | 会话         | `POST /api/sessions/:id/fork` 建好子会话后发出                                    |
| `execution.started`             | 执行生命周期 | 回合开始执行                                                                      |
| `runtime.started`               | 执行生命周期 | 单个 runtime 开始执行                                                             |
| `runtime.deferred`              | 执行生命周期 | staged runtime 已随原回合提交并转入后台；payload 含 `jobId/sourceTurnId`          |
| `runtime.completed`             | 执行生命周期 | 单个 runtime 执行完成                                                             |
| `runtime.failed`                | 执行生命周期 | runtime 执行失败                                                                  |
| `execution.completed`           | 执行生命周期 | 回合执行完成                                                                      |
| `event.emitted`                 | 会话生命周期 | 事件发射                                                                          |
| `asset.progress`                | 资产         | 多模态生成进度（`0..100`）                                                        |
| `asset.generated`               | 资产         | `asset.generate` proposal 提交后发出                                              |
| `world.dimensions.changed`      | 世界         | 作者的维度声明变了（热更新），不重置会话的当前值                                  |
| `dimensions.changed`            | 状态         | 已提交的当前值变了；payload 含提供者、公共 snapshot 子集和可选的 settlement 摘要  |
| `dimensions.settlement.changed` | 状态         | pending 或没有数值变化的回执变更；payload 不含规则和初值                          |
| `plugin-data.changed`           | 插件数据     | 所有写路径都会发出：`plugin-data-set`、DELETE、batch 等                           |
| `turn.suspended`                | 流程控制     | `finalizeExecution` 成功提交挂起记录后发出                                        |
| `turn.resumed`                  | 流程控制     | `POST /api/sessions/:id/suspensions/:suspensionId/resume` 重启 runtime 时发出     |
| `proposal.failed`               | 流程控制     | 单条 proposal 提交失败。明确上报，不悄悄丢弃；由提交方直接写入 action stream      |
| `job-status.updated`            | 流程控制     | 后台 function runtime 通过 `ctx.progress` 汇报进度；只追加，转发到 action stream  |
| `context.pruned`                | 系统         | 提示词超出 slot 预算，历史被硬裁剪；只进 trace（`/debug` 用），不进 action stream |
| `context.compaction.failed`     | 系统         | 历史压缩失败和原因；只进 trace（`/debug` 用）                                     |
| `commit.fanout.failed`          | 系统         | 回合已提交，但部分提交后的事件没能发布；只进 trace，订阅流同时收到 `system.reset` |
| `error.occurred`                | 系统         | 执行错误                                                                          |

### 转发的运行时内部事件（已纳入 `CovelEventType`）

下面这些事件也是 `CovelEvent` 的正式成员。`COVEL_EVENT_META` 标明了每一种是否 `forwardToActionStream`。前端的穷尽检查要求每一种都被处理，或者被明确忽略。

| 事件                                                                   | 来源                              | 转发到 `/api/actions` | 说明                                                                                                                      |
| ---------------------------------------------------------------------- | --------------------------------- | :-------------------: | ------------------------------------------------------------------------------------------------------------------------- |
| `runtime.skipped`                                                      | `actions.ts`                      |          否           | runtime 因 cooldown / startTurn / maxTriggerCount 被跳过                                                                  |
| `character.upserted`                                                   | `session-commit-emitter.ts`       |          是           | `character.upsert` proposal 提交后发出                                                                                    |
| `tool.calling` / `tool.completed` / `tool.failed`                      | TurnEmitter                       |          是           | 工具调用 trace（调试时间线用）                                                                                            |
| `llm.calling` / `llm.responded` / `message.completed`                  | TurnEmitter                       |          是           | LLM 调用 trace                                                                                                            |
| `block.emitted` / `state.patch.applied`                                | TurnEmitter                       |          是           | 块发出 / state patch 应用的 trace                                                                                         |
| `hook.fired` / `hook.rewrote` / `hook.aborted`                         | TurnEmitter                       |          是           | Hook 行为 trace                                                                                                           |
| `gateway.calling` / `gateway.responded` / `gateway.failed`             | TurnEmitter（`withGatewayTrace`） |          是           | function runtime 和扩展点提供方通过 `ctx.gateway` 调 provider 的 trace（与 `llm.*` 对等）；失败时带服务商已报告的 `usage` |
| `function.executing` / `function.completed`                            | TurnEmitter                       |          否           | function runtime handler 的起止 trace；只走订阅通道和 `trace_events`                                                      |
| `recursive.calling` / `recursive.completed` / `recursive.failed`       | TurnEmitter                       |          否           | 递归 runtime 的 trace；只走订阅通道（topic `trace`）                                                                      |
| `utils.fetch.calling` / `utils.fetch.responded` / `utils.fetch.failed` | `withUtilsTrace`                  |          否           | 插件自带 wire 调 provider HTTP 的 trace（`ctx.utils.fetchWithRetry`）                                                     |

详见 [protocol.md § 转发的运行时内部事件](./protocol.md#转发的运行时内部事件apiactions-转发已纳入-covelevent)。

### 信封格式

信封是包在每个事件外面的那层固定字段。两条流各用一种：

```typescript
// /api/actions data-only 帧每条 data: 的形态
interface SseEnvelope {
  type: string; // 见上方两张事件表（CovelEventType 的成员）
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string; // = traceId
  seq: number; // 该流内自增
  timestamp: string;
  payload: Record<string, unknown>;
}

// /api/events/stream 命名事件帧的 data 形态
interface SubscriptionEvent {
  id: string; // `${epoch}:${seq}`，重连时作为游标
  topic: SubscriptionTopic;
  type: string;
  sessionId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
```

`SseEnvelope` 定义在 `packages/shared/src/types/api-contract.ts`，`SubscriptionEvent` 定义在 `packages/shared/src/types/subscription-events.ts`。事件类型和各自的 payload 见 `packages/shared/src/types/protocol.ts`；同一文件里的 `ProtocolEvent`（`id`、`type`、`sessionId`、可选 `turnId` 和 `source: { pluginId, runtimeId }`、`payload`、`timestamp`）是服务器内部事件的形态。

## 存储模式说明

Covel 有三种部署层级（Deployment Tier），每种层级的存储方式不同。

浏览器里还可以切换存储模式：

- `local`：数据保存在玩家浏览器的 IndexedDB。
- `remote`：通过服务器 API，保存到 `STORE_BACKEND` 指定的后端。

### T1: 自部署 (Self-Deploy)

- **服务器存储**: SQLite（默认，`./data/covel.db`）。可以显式切换到 Memory，只用于一次性测试。
- **前端存储**: 默认是 remote，使用服务器的 SQLite；local 模式使用浏览器 IndexedDB。
- **数据流**:
  - remote 模式：前端通过 API 读写服务器的 store。
  - local 模式：业务记录以带版本的 checkpoint 保存在 Dexie `covel-browser-vault` 里。执行前上传到临时的 MemoryStore，执行后原子地应用 `SessionCommit`。
  - 生成世界等服务器能力，通过 `return-only` 响应把结果交给前端保存。
- **API 密钥**: 用户自己管理，保存在浏览器 localStorage。
- **认证**: 无

```bash
# 启动方式
pnpm dev:server                       # SQLite 后端（默认）
STORE_BACKEND=memory pnpm dev:server  # 临时 Memory 后端（重启即丢失）
```

### T2: 演示托管 (Demo Host)

- **服务器存储**: Memory 或 SQLite
- **前端存储**: 允许公开写入的演示可以用 local IndexedDB；私有演示也可以用 remote 服务器存储。
- **API 密钥**: 用户自己管理，必须用 HTTPS 传输。
- **认证**: **必需**。
  - 会话作用域的端点强制 session owner token。
  - 全局端点和管理端点强制运维 token（`COVEL_DESKTOP_REST_TOKEN`）。
  - 没有配置运维 token 时，`validateSecurityPosture` 直接拒绝启动。
  - 详见上方[鉴权章节](#鉴权session-owner-token)。

### T3: 商业部署 (Commercial)

- **服务器存储**: PostgreSQL（需要配置 `DATABASE_URL`）
- **前端存储**: 游戏数据的增删改查都交给服务器 API。浏览器只留显示缓存：表单提交标记和历史时间线，按会话身份校验。
- **API 密钥**: 平台和用户两层管理
- **认证**: 必需

```bash
# 启动方式
STORE_BACKEND=pg DATABASE_URL=postgresql://covel:pass@localhost:5432/covel pnpm dev:server
```

### 存储后端对比

| 能力     | Memory                 | SQLite                                     | PostgreSQL                                            |
| -------- | ---------------------- | ------------------------------------------ | ----------------------------------------------------- |
| 持久化   | 否 (重启丢失)          | 是 (本地文件)                              | 是 (远程数据库)                                       |
| 并发     | 单进程                 | 单进程                                     | 多进程（`pg_advisory_lock` 让同一会话跨进程串行执行） |
| 适用场景 | 测试 / 一次性 demo     | 单机部署（默认）                           | 生产环境                                              |
| 配置     | `STORE_BACKEND=memory` | 默认（`STORE_BACKEND=sqlite`，可显式指定） | `STORE_BACKEND=pg` + `DATABASE_URL`                   |

> [!NOTE]
> **多进程部署的会话锁**
>
> - `STORE_BACKEND=pg` 时，服务器启动日志会输出 `session lock: pg-advisory`。
> - 会话作用域的修改、回合、resume、detached commit 等，在专用的 PG 连接上取 advisory lock，保证同一个 key 在多个 Pod 之间串行执行。
> - 同一个异步分支里嵌套的或成批的 key 共用一条保留连接，避免连接池 `max=1` 或一次处理多个 key 时把连接用光。
> - Memory / SQLite 后端使用进程内的锁，只覆盖单进程。

### 服务生命周期

这一节说明服务器怎样启动和关闭。把 API 嵌进自己宿主的开发者需要它；只调用 HTTP 接口的读者，记住关闭期间新请求返回 `503 / server_shutting_down` 即可。

**启动**

- 服务器启动时，逐项登记 DataStore、MediaStore、PG 锁池、API 服务和文件监听器各自归谁关闭。
- 后面的启动步骤失败时，走与正常退出相同的排空流程。这个流程可以重复执行，并且保留原始的启动错误。
- API 装配失败时，它自己释放已经创建的事件传输和插件注册。从外部注入的存储仍由调用方关闭。
- 启动扫描不阻塞 API 就绪，通过 `ApiBootstrapResult.startupMaintenance` 跟踪。

**关闭的顺序**

1. 同时停止接收新请求、文件监听和两个后台队列。同时通知这些生产者停止，可以让后台任务释放前台请求正在等待的会话锁。
2. 等待它们和启动扫描结束。
3. 排空记忆任务。
4. 调用 `closePluginEntries()`。
5. 关闭事件总线、底层存储和连接池。

每个排空阶段都有时限。已跟踪的工作没结束时，保留它依赖的资源，交给进程最终退出处理。

**什么算“工作完成”**

`ApiBootstrapResult.applicationWork.close()` 跟踪的是业务是否完成。HTTP 连接关闭，或者 Response 已经创建，都不算完成。

- 普通请求：覆盖完整的 middleware 和 handler。
- 也纳入跟踪：action、世界生成、长期订阅的 SSE 回调和它们的读写队列、请求触发的挂起扫描。

**关闭期间各类工作怎样处理**

- 新请求返回 `503 / server_shutting_down`。
- 玩家回合、手动 runtime、resume 和世界生成会收到宿主的取消信号。
- 排队中的 action / resume 在拿到锁之后再检查一次。
- 被取消的提交会回滚；已经成功提交的状态不撤销。
- 长期订阅停止读写，并释放注册。

**几条边界**

- 客户端断开 action SSE 不等于取消回合。刷新后继续使用 execution 恢复协议。
- 宿主的取消不会被当成玩家主动 abort。
- 世界生成收到调用方的取消后，不再重试 provider。迟到的模型输出不算有效结果。
- 普通的 RPC handler，或者插件自己启动的、不配合取消的代码，在同一个进程里无法强制终止。任务跟踪不能代替插件能力限制，也不能代替外部副作用自己的恢复协议。

**嵌入式调用方**

- 同样要遵守上面的顺序。不能只调用 `worker.close()` 就马上关闭存储。
- 外层的 Hono 宿主可以向 `bootstrapApi` 注入自己的 `applicationWork`，并把它的 middleware 放在宿主路由之前。这样 API 与配置、模型等其他路由共用同一个关闭边界。

### 关键环境变量

完整的清单见 [`env-registry.md`](./env-registry.md)。

| 变量                | 说明                  | 默认值            |
| ------------------- | --------------------- | ----------------- |
| `STORE_BACKEND`     | 存储后端类型          | `sqlite`          |
| `SQLITE_PATH`       | SQLite 数据库路径     | `./data/covel.db` |
| `DATABASE_URL`      | PostgreSQL 连接字符串 | -                 |
| `SERVER_PORT`       | 服务器端口            | `3001`            |
| `DEPLOYMENT_TIER`   | 部署层级              | `self`            |
| `CORS_ORIGIN`       | CORS 允许的源         | -                 |
| `ENABLE_DEBUG_PAGE` | 启用调试页面          | `false`           |
| `RATE_LIMIT_RPM`    | 速率限制 (请求/分钟)  | `60`              |

### Opening the effective configuration

`POST /api/config/open-folder` 用系统的文件管理器打开一个配置文件。请求体是 `{ "target": "llm.toml" }`。

目标解析到哪里：

| `target`   | 打开的位置                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `llm.toml` | 配置了 `COVEL_LLM_TOML` 时打开它（相对路径从服务器的工作目录算起）；否则打开 `<covelHome>/llm.toml` |
| `keys.env` | 始终在 `covelHome` 下                                                                               |

文件不存在时：

- 桌面模式下缺少 `llm.toml`：先用内置默认配置创建它，再打开。内置默认配置与当前生效的后备配置有相同的 slot，所以在你编辑之前什么都不会变。响应是 `{ "ok": true, "created": true }`。
- 其他目标不存在，或者非桌面模式下缺少 `llm.toml`：返回 `400`，`code` 为 `open_target_unavailable`。

成功时响应是 `{ "ok": true, "created": <boolean> }`。

> [!NOTE]
> 打开文件不会让运行中的网关重新加载。编辑后调用 `POST /api/llm-config/reload`，模型配置才生效。

### Editing a configuration file as text

这三个端点让应用把配置文件当作文本来读和改。

**`GET /api/config/raw`** 列出服务器允许应用编辑的文件：

- `llm.toml`：服务器实际加载的那个路径，也就是 `GET /api/llm-config` 的 `source.path`。
- `config.toml`：只在桌面模式下。
- `keys.env` 永远不在列表里。

**`GET /api/config/raw/:name`** 返回 `{ name, path, exists, applies, content, digest }`：

- `applies`：`llm.toml` 是 `reload`（保存后立即生效），`config.toml` 是 `restart`（重启后生效）。
- 文件还不存在时，`content` 是一份起始文本，`digest` 是空文件的摘要。

**`PUT /api/config/raw/:name`** 的请求体是 `{ content, baseDigest }`。服务器按这个顺序处理：

1. 用它加载这个文件时用的解析器检查文本。
2. 核对 `baseDigest`：它必须是磁盘上当前文件的摘要。
3. 把原文件复制为 `<name>.bak`，再原子地替换。
4. `llm.toml` 立即生效。

响应是读取时的那组字段，再加上 `backup`（备份文件的路径）和 `reload`（`{ ok, slots, error? }`）。

错误：

| 状态码 | `code`                        | 什么时候                                           |
| ------ | ----------------------------- | -------------------------------------------------- |
| 404    | `config_file_unknown`         | 文件名不在允许的列表里                             |
| 400    | `config_file_request_invalid` | `content` 或 `baseDigest` 不是字符串               |
| 413    | `config_file_too_large`       | 文本超过 256 KiB                                   |
| 400    | `config_file_invalid`         | 文本没通过解析。响应带解析器的消息，什么都不写入。 |
| 409    | `config_file_changed`         | 文件在读取之后被改过                               |

三个端点的门禁与安装端点相同：

- 托管层级（`demo` / `commercial`）要运维 token；
- 桌面壳下要桌面 token；
- 生产环境要 `COVEL_INSTALL_API_ENABLED=1`。

### Installed resource storage and vector configuration

**安装世界（`POST /api/install/world`）**

- 返回之前，已经把装好的包加载进 DataStore。响应是 `201`，带 `restartRequired: false`。
- 世界马上能在 `GET /api/worlds` 里看到。宿主没有递归文件监听也一样。
- 激活失败时，只删除这次新建的包目录，可以重试安装。
- 上传的世界带 `source: "generated-file"`，并绑定到用户世界目录，所以 DELETE 立即可用。
- 世界 ID 已存在时返回 409，不覆盖原有记录。
- 安装插件仍然返回 `restartRequired: true`。

**ZIP 激活前的校验**

- worldData 有 error 级诊断时，在创建记录之前返回 400。这包括：缺少 descriptor 或 source、source 格式错误、source 不符合它自己的 schema。
- warning 级诊断仍然允许。
- 校验的是包里原样的内容：不套用本地覆盖，也不执行社区代码。
- 启动时 seed 的容错规则不变。

**目标目录已存在**

- 两个 ZIP 安装端点遇到已存在的目标目录，都返回 `409 { error: "target already exists: <id>" }`。Windows 上以 `EPERM` 报告的重命名冲突也算。
- `EPERM` 但找不到目标目录时，保留原始错误。
- 发布失败时删除暂存目录，保留现有的安装。

**安装后的重启和刷新**

- Electron 里，`covel:restart-server` 负责两件事：重启 sidecar；健康检查通过后，让原生窗口导航到新端口。
- Web 客户端保持它的重新加载遮罩，不要自己重新加载旧 URL，也不要尝试跨源跳转。
- 开发模式下重新加载外部的 Vite 页面。
- 卸载插件仍然需要重启，才能卸掉已发现的代码。卸载不会删除插件已保存的会话数据。

**生成的世界文件**

- 生成、修订和翻译的世界文件先写进隐藏的暂存目录。完整副本通过与 ZIP 安装相同的包预检后才发布：清单和世界数据读回不得有错误，且不读取本地覆盖。
- 这项包预检不要求玩家启用接收插件；会话数据的契约检查仍由会话预检负责。
- 已有的包和数据库里的身份都保留。ID 冲突或激活失败通过一条 SSE error 事件报告。
- 激活失败时，只删除这次请求创建的包。

**桌面端的目录导入**

- 同样先校验暂存副本，再发布。
- 清单是链接、复制失败，或者目标在源目录里面，都会被拒绝，不会留下装了一半的包。
- 世界和插件的发现会跳过隐藏的暂存目录。

**安装目录**

- 安装和发现共用 `COVEL_USER_WORLDS_DIR` 和 `COVEL_USER_PLUGINS_DIR`。
- 默认是 `COVEL_HOME`（没有设置时是 `~/.covel`）下的 `worlds/` 和 `plugins/`。
- Docker Compose 把这两个目录保存在 `appdata` 卷里。桌面端的路径仍由桌面壳决定。

**向量配置**

`VECTOR_BACKEND=none` 会关闭：

- 自动的 embedding 模型锁定；
- 语义记忆的写入；
- 向量召回和归档搜索。

关键词记忆仍然可用，已有的 embedding 会保留。记忆子系统之外，显式发起的 provider embedding 请求不受影响。

### 社区插件待授权状态

创建会话时，玩家选择的社区插件 ID 会保留下来。

`GET /api/sessions/:id/plugins` 的条目有一个可选字段 `approvalRequired`：

- 插件已被选择，但当前会话还没有执行授权时，它是 `true`，同时 `active` 仍是 `false`。
- 前端应该明确显示“已暂停”，并调用现有的启用和审批接口重新授权。不要把它当成玩家取消了选择。
- 授权不会在服务器进程重启后保留。

### GET /api/sessions/:id/plugin-diagnostics

返回插件注册情况的只读快照，以及当前会话最近的服务调用。读取它不会激活 entry，也不会执行插件代码。

- 鉴权与其他会话端点相同，响应阶段还会再核对一次会话实例。
- 查询参数 `pluginId` 可选，按精确的包 ID 筛选插件。结果包含它作为调用方或提供方的调用记录。
- 响应带 `Cache-Control: no-store`。

| 状态码 | 什么时候              |
| ------ | --------------------- |
| 404    | `pluginId` 是未知插件 |
| 400    | 查询参数非法          |

**响应**

返回 `PluginDiagnosticsSnapshot`（`@covel/shared`）：

| 字段               | 说明                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `sessionId`        | 所属会话                                                            |
| `capturedAt`       | 快照时间                                                            |
| `plugins[]`        | 每个插件的状态和注册项，见下                                        |
| `calls[]`          | 最近的服务调用，见下                                                |
| `extensionCalls[]` | 按扩展点和提供方汇总的调用数，见下                                  |
| `history`          | `{ "scope": "process", "limit": 100 }`，说明 `calls[]` 的范围，见下 |

**`plugins[]`**

每一项有 `pluginId`、`source`、`active`、`hostState`、`sessionState`、`serverCodeApproved`、`runtimeIds`、`registrations`、`commands`，以及可选的 `autoAdded`、`rejection`、`approvalRequired`、`error`、`registrationError`。状态和依赖结果与会话插件列表用的是同一套只读解析。

- `hostState`：entry 在整个进程里的发布状态。
- `sessionState`：`active | inactive | approval-required | rejected`。
- `serverCodeApproved`：按当前会话的实时授权算出。
- 进程里已加载，不代表这个会话获准运行它。撤销授权也不会销毁其他会话共用的 entry。
- `error`：只给固定的说明文字。
- `registrationError`：`{ code: "plugin_registration_invalid", registration }`。只来自宿主能识别的注册错误类型，不从错误字符串推断，也不带原始异常。

`registrations` 列出实际注册的内容：

| 字段           | 内容                           |
| -------------- | ------------------------------ |
| `tools[]`      | 工具名                         |
| `hooks[]`      | `{ id, event }`                |
| `actions[]`    | RPC action 名                  |
| `services[]`   | `{ name, contract }`           |
| `extensions[]` | `{ point, id, order?, slot? }` |

只有在当前会话里活跃、已获批准、并且宿主状态不是 error 的包，才返回实际注册项。其余的包这里是空的。

`commands[]` 是声明的命令 `{ name, action, registered }`。`registered` 表示这个 action 是否在上面的注册表里。它不代替执行时的权限检查。

**`calls[]`**

每条记录有：

- `callId`，可选的 `parentCallId` / `turnId` / `runtimeId`；
- `callerPluginId`、`providerPluginId`、`name`、`contract`；
- `completedAt`、`durationMs`；
- `outcome`：`success` / `timeout` / `cancelled` / `error`；
- 可选的 `errorCode`，取自一组固定分类。最终输出校验失败和归属校验失败都是 `output-validation`；
- 扩展调用另带 `extension: { point, id, slot? }`，来自注册项。

**`extensionCalls[]`**

按 `point` 和 `providerPluginId` 汇总，含 `total / success / error / timeout / cancelled`。

- 汇总的是本次返回的同一批 `calls`，不是整个生命周期的累计值。
- 缓存命中不增加计数。
- 没有找到可用的提供者时，没有调用记录。
- skip 和 fail-turn 都只把实际的失败记一次。

**`history` 和调用记录的范围**

- 整个进程最多保留 500 条已完成的调用。
- 按当前会话实例筛选后，倒序返回最多 100 条。
- 记录不在进程之间共享，也不持久化。
- 调用方通过准入之前的失败，不写入这个会话的历史。
- 记录里没有输入、输出、原始错误、凭据或私有的会话范围。
- 用同一个 ID 重建的会话，看不到旧会话的历史。
- 请求没有匹配到已注册的描述符时，服务标识显示为 `<unavailable>`，避免把任意请求内容复制进来。
- 可显示的诊断字符串最多 256 个 UTF-16 单元，截断时以 `...[truncated]` 结尾。内部匹配会话时仍用完整的身份。

> [!NOTE]
> 这个窗口用于开发诊断，不是完整的审计日志。

**与持久 trace 的关系**

- 有实际回合 emitter 的扩展调用、压缩和 function service 调用，另外通过 `plugin.service.completed` 写入持久 trace。
- 这条 trace 复用 callId、父调用、traceId 和回合关联。服务器等 trace 写入尝试完成后才返回。
- trace 存储失败不改变调用结果。provider 的耗时不含 trace 的读写时间。
- 没有回合 emitter 的 UI 后台投影只进入进程内的窗口，不会伪造一个回合。

**`/plugins` 命令**

框架的命令目录里有 `/plugins [pluginId]`，用来打开这份诊断：

| 项目   | 值                                                                    |
| ------ | --------------------------------------------------------------------- |
| ID     | `framework:plugins`                                                   |
| action | `slash-plugins`                                                       |
| 参数   | 可选字符串 `pluginId`；不带参数时查看全部安装包                       |
| 执行   | `POST /api/sessions/:id/plugin-rpc`，`kind: "command"`                |
| 返回   | `result.clientAction: { type: "open-plugin-diagnostics", pluginId? }` |

- 普通的 action 请求不能代替这个命令上下文。
- 命令不触发玩家回合，也不调用模型。
- Web 客户端收到后打开 `/debug` 的 `view=plugins`，保留当前的 `sid` 和可选的 `pluginId`。
- 调试页的 `view` 支持 `traces` / `data` / `cost` / `plugins`，缺省是 `traces`。插件筛选只在 `plugins` 视图里生效。

### Session UI projections

**`GET /api/sessions/:id/ui-slots`** 返回 `{ items: UiSlotSnapshot[] }`，是界面各个 slot 当前要显示的值。

可选的查询参数：

| 参数     | 说明                                               |
| -------- | -------------------------------------------------- |
| `prefix` | slot 名的前缀，例如 `stage.`                       |
| `slot`   | 一个确切的、受支持的 slot 名；未知的名字返回 `400` |
| `key`    | 确切的角色 ID，用于 `character.visual@1`           |

每个快照是 `{ slot, key?, value, revision }`：

- `revision` 用来标识这个值。客户端不能把它当成先后顺序的计数器。
- 缓存不存在时，按需从已提交的数据算出来。
- 带 key 的值被移除后，表示为 `value: null`。

**`GET /api/sessions/:id/media/image-flow`** 返回 `{ flow: null | { pluginId, entryRuntimeId, assetRuntimeIds } }`，告诉界面当前由哪个插件的哪些 runtime 负责生成图片。

- `media.image-flow@1` 扩展给每个提供者 500 ms 的时间，失败的提供者被跳过。
- 提供者返回的 runtime ID 必须属于它自己的插件。

**AI 世界生成**

- 写完 manifest 后，如果 ID 已经存在，就给它分配一个可用的后缀。
- 局部校验失败时，修正请求带上一份答案和校验错误。
- 输出被截断，或者模型流缺少完成事件时，立即报告错误。残缺的内容不会被当成完整的包继续重写。
- 最终保存时仍有原子的冲突检查，防止生成期间新出现的同名世界被覆盖。
- 同一服务端的生成、修订和翻译共用一个互斥标记，覆盖整个 SSE 生命周期和清理阶段。忙时新请求立即返回 `429 operation_in_progress`，不调用模型；结束或失败后释放。
- 这个标记不阻止编辑和删除。保存仍须取得世界操作锁并重新核对：生成不能覆盖已有 ID，修订不能覆盖模型等待期间的修改，翻译不能写进已删除或替换的包。

**世界数据的语言覆盖**

- 翻译嵌套的对象列表时，世界数据的语言覆盖遵守每个 source 的 `localeArrayKeys`。
- preflight、导入、同步和翻译端点共用这套按 key 匹配的规则。主列表重新排序，不会把带 key 的翻译配给别的条目。

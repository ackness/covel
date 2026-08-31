# 环境变量 Registry

Covel 的环境变量清单由 `packages/shared/src/env/registry.ts` 维护。代码读取环境变量时优先使用 `@covel/shared` 暴露的 helper：

- `readRuntimeEnv()`：读取 server / storage / desktop 常用配置。
- `isEnvEnabled()`：读取严格 feature flag，只有字符串 `1` 表示开启。
- `isEnvDefaultOn()`：读取默认开启的开关，`0` / `false` 表示关闭。
- `readEnvString()` / `readEnvInt()` / `readEnvChoice()`：读取单个变量。
- `providerApiKeysFromEnv()`：扫描所有 `*_API_KEY` 并映射成 provider id。

## 分组

| group       | 用途                                                      |
| ----------- | --------------------------------------------------------- |
| `storage`   | `STORE_BACKEND`、`DATABASE_URL`、SQLite / PostgreSQL 配置 |
| `server`    | 端口、CORS、静态资源、部署层级、限流                      |
| `desktop`   | Electron 注入给 server sidecar 的路径与桌面模式配置       |
| `ai`        | LLM 配置、provider keys、模型数据库、prompt 根目录        |
| `feature`   | 运行期功能开关                                            |
| `web`       | Vite dev proxy 与浏览器侧公开变量                         |
| `test`      | Playwright、live provider tests、e2e harness、开发脚本    |
| `packaging` | Electron 签名、公证、updater 密钥                         |

## 状态

| status       | 含义                                     |
| ------------ | ---------------------------------------- |
| `active`     | 代码已读取，属于当前运行契约             |
| `documented` | 文档或示例已有，源码读取接入排期中       |
| `planned`    | 设计文档中的未来开关                     |
| `packaging`  | 打包工具链读取，应用运行时代码通常只透传 |

## 文件职责

| 文件                   | 职责                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| `.env`                 | 基础设施、server、storage、feature flag、本地开发辅助配置            |
| `.env.llm`             | provider API key 与 provider base URL                                |
| `llm.toml`             | slot、provider、model、protocol、capability 配置；支持 `${VAR}` 插值 |
| `~/.covel/keys.env`    | 桌面端持久化 provider API key                                        |
| `~/.covel/config.toml` | 桌面端数据目录与日志轮转配置                                         |

## Registry 中的其他运行变量

以下变量同样属于当前 `registry.ts` 契约，但不需要在上面的运行说明中展开：

| 变量                                                  | 默认值 / 状态                   | 用途                                                   |
| ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| `NODE_ENV`                                            | `development`                   | Node 运行模式（`development` / `production` / `test`） |
| `SERVE_STATIC` / `STATIC_DIR`                         | `false` / `./web-dist`          | 让 server 托管指定目录中的 SPA                         |
| `CORS_ORIGIN`                                         | —                               | 允许的 HTTP origin 列表                                |
| `ENABLE_DEBUG_PAGE`                                   | `false`                         | 开启生产环境 debug/internal 路由                       |
| `RATE_LIMIT_RPM`                                      | `60`                            | 默认每 IP 每分钟限流额度                               |
| `TRUSTED_PROXY_IPS`                                   | —                               | 允许信任转发 IP 头的代理地址列表                       |
| `COVEL_MEDIA_TOKEN_SECRET`                            | 生产环境必填                    | 签发媒体短期访问 token 的 HMAC secret                  |
| `COVEL_INSTALL_API_ENABLED`                           | `false`                         | 无桌面 bearer token 时显式开启插件/世界文件变更接口    |
| `COVEL_LOG_QUIET_PATHS`                               | `/api/health`                   | 逗号分隔的静默请求路径                                 |
| `MEDIA_BACKEND` / `MEDIA_ROOT`                        | `mirror` / —                    | 媒体存储后端及文件根目录                               |
| `VECTOR_BACKEND`                                      | `embedded`                      | 向量能力（`embedded` / `none` / `external`）           |
| `COVEL_LLM_RETRY_DISABLED`                            | `false`                         | 设为 `1` 时关闭 provider HTTP 重试                     |
| `COVEL_TRACE_TRUNCATE`                                | `false` / `planned`             | 计划中的 trace payload 截断开关，当前不可依赖          |
| `E2E_BASE_URL` / `E2E_MODEL_SLOT`                     | `http://127.0.0.1:5181` / `e2e` | Playwright 外部环境覆盖地址及插件验证脚本 slot         |
| `COVEL_PG_PREFLIGHT_HOST` / `COVEL_PG_PREFLIGHT_PORT` | `127.0.0.1` / `5432`            | `dev:pg` 启动前的 TCP 检查目标                         |
| `COVEL_PG_PREFLIGHT_SKIP`                             | `false`                         | 设为 `1` 跳过 `dev:pg` TCP 检查                        |
| `RUNTIME_HOST` / `RUNTIME_PORT`                       | `127.0.0.1` / `3001`            | Vite 开发代理的 server 目标                            |
| `VITE_ROUTER_DEVTOOLS`                                | `true`                          | 开启 Vite 路由开发工具                                 |

`LIVE_LLM_ENABLED`、`LIVE_IMAGE_ENABLED`、`BASE_URL`、`SESSION_ID` 属于测试或
截图脚本专用变量；`CSC_LINK`、`CSC_KEY_PASSWORD`、`WIN_CSC_TIMESTAMP_SERVER`、
`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 只由 Electron
打包工具读取，详见 [`desktop-packaging.md`](./desktop-packaging.md)。

> Registry 元数据仍有一处待代码侧收敛：`COVEL_PG_PREFLIGHT_SKIP` 已由 `scripts/dev-pg-preflight.mjs` 读取，但 registry 状态仍标为 `documented`。本页按实际运行行为列值。

## 迁移规则

1. 新增环境变量时，先在 `COVEL_ENV_REGISTRY` 加 definition。
2. 运行时代码读取 env 时使用 helper，保留 `process.env` 给动态枚举场景。
3. 新增 provider 只需要遵守 `${PROVIDER}_API_KEY` 命名，registry 只记录常用示例。
4. 新增 feature flag 使用清晰的能力名，避免用版本号表达开发阶段。
5. 默认关闭的运行期开关用 `isEnvEnabled()`；默认开启的开关用 `isEnvDefaultOn()` 并在 registry 里写清楚关闭值。
6. `.env.example` 和 `.env.llm.example` 只放可公开示例值。

## Runtime Contract

- `STORE_BACKEND` 的代码默认值为 `sqlite`。
- `DEPLOYMENT_TIER=self` 对应本地自部署；localhost 请求可以读取 server 注入的 provider key 元数据。`demo` / `commercial` 会硬性强制 session owner token 鉴权（见 [`docs/reference/api.md`](../reference/api.md) 鉴权章节）。未知值会被规范化并 fail-closed 到最严格的 `commercial`。
- `COVEL_DESKTOP_REST_TOKEN` 是运维 master / operator 凭证：以该值作为 Bearer token 可通过任意会话的 owner 校验（管理工具 / e2e harness 用），并且是 hosted（`demo` / `commercial`）层级创建/列出会话、世界写入与维度导入、AI 世界生成、模型探测/刷新以及 community server-code 激活的必需凭证。`DEPLOYMENT_TIER=demo|commercial` 启动时若未配置该 token，`validateSecurityPosture` 会直接拒绝启动（fail-closed）。`self` / 桌面 / dev 层级不要求也不校验它。这是当前单运维方信任模型，不提供多租户身份或代码沙箱（见 [`docs/reference/api.md`](../reference/api.md) 鉴权章节）。
- Electron 桌面端选择 `system` 时，sidecar 会针对每个目标 URL 通过 IPC 调用 Chromium 系统代理解析，并按系统返回的代理列表顺序处理连接级 fallback。Electron 会注入内部 capability `COVEL_DESKTOP_SYSTEM_PROXY_IPC=1`，因此普通 Node IPC/cluster 进程不会误启用该协议。`COVEL_SYSTEM_PROXY_URL` 仅作为不支持动态 IPC 的旧 shell 兼容入口；该配置只用于核心 provider 与模型数据库请求，不应用到第三方插件的 `fetchWithRetry`。
- `COVEL_LLM_MAX_CONCURRENT` 为 `active`（`packages/runtime/src/retry/llm-slots.ts` 消费）：进程内 LLM 调用并发上限，默认 `4`，`0` 或负数关闭闸门。排队时间顺延 runtime deadline。多会话托管部署可按 provider 吞吐调整。
- `COVEL_BIND_HOST` 默认 `127.0.0.1`：本地 / 桌面部署只监听回环接口，网络上不可达。容器或多 pod 部署需显式设置 `COVEL_BIND_HOST=0.0.0.0`（`docker/docker-compose.yml` 已内置）——这是一次显式的部署决策，公开监听前请确认 `DEPLOYMENT_TIER` 与鉴权配置。
- `COVEL_LLM_REPLAY`、`COVEL_LLM_REPLAY_DIR` 标记为 `documented`，源码不读取这两个变量，当前部署不得依赖 replay cache。`TRUSTED_PROXY_IPS` 已是 `active`（由 `middleware/rate-limit.ts` 的 X-Forwarded-For 信任检查消费）。SSRF guard 设计上即 open-by-default，因此没有 LLM host 白名单变量。
- `COVEL_COMPACTOR_CONTEXT_WINDOW` 为**可选的显式覆盖**：未设置时，压缩阈值与 prompt 硬裁剪预算按所有已启用 text slot 中最保守的模型 capability（最小 `contextWindow` 与最小 `maxOutputTokens`）动态解析，避免同一回合的 story / plugin / fast slot 窗口不一致时按较大窗口误放行；llm.toml 热重载即时生效，capability 也缺失时回退 `32768` / `4000`。请求级 story slot overlay 会与基础预算再次取较小值。设置 `COVEL_COMPACTOR_CONTEXT_WINDOW` 后固定覆盖 window，输出 reserve 仍取保守 capability。
- `COVEL_SNAPSHOT_INTERVAL_TURNS` 默认 `5`，控制 `kind=auto` 快照的 checkpoint 节奏：`completedPlayerTurns <= 1` 时总是写入，其后每 N 个已完成玩家回合写一份；`1` 表示每回合。resume 路径无视该节流强制写入。构建快照 payload 需要全量读取消息历史与全部 session-scoped 集合，逐回合写入会导致 O(T²) 成本与存储膨胀。
- `COVEL_MEDIA_CLEANUP_ENABLED` 默认 `false`，控制 `POST /api/media/cleanup` 的可用性。即使设为 `true`，`DEPLOYMENT_TIER=commercial` 时该端点也固定返回 503。详见 [`docs/reference/api.md`](../reference/api.md) 媒体管理章节。
- `COVEL_PG_LOCK_POOL_MAX` 默认 `16`，控制 PG advisory session-lock 专用连接池的 `max`。每个进行中的 turn 占用一条 reserved 连接；多并发 pod 可按峰值并发会话数调大。锁获取超时（30s）覆盖连接池排队 + advisory lock 轮询全程。
- `COVEL_PG_INGEST_LOCK_POOL_MAX` 默认 `4`，控制语义记忆摄取的独立 PG advisory-lock 连接池。完整的 cursor/hash 读取、embedding 与向量写入都在 `memory-ingest` 命名空间锁内，同 session 跨 pod 串行、不同 session 仍可并行；独立小池避免后台 provider I/O 占满玩家 turn 的锁连接。
- `COVEL_SUSPENSION_TTL_MS` 默认 `604800000`（7 天），控制未解决（unresolved）挂起项的过期清理。清理无独立调度器：服务启动时执行一次性 force sweep，之后由 `GET /api/sessions/:id/suspensions` 与 `POST /api/sessions/:id/resume` 机会式触发、最多每小时一次的时间门控 sweep。设为 `0`（或负数）关闭清理。**claimed（恢复进行中）/ 已成功解决的记录永不清理**。属于框架基础设施开关（非插件 per-session 设置）。详见 [`docs/reference/api.md`](../reference/api.md) Suspend / Resume 章节。
- `COVEL_EFFECTS_POLICY` 默认 `warn`，控制同层 effects 读写 hazard 的处置策略。`warn`（缺省）：对同一并行层内存在读写冲突且无依赖边的 runtime 对产出稳定诊断，但保持并行执行。`strict`：在产出诊断的同时，按稳定 runtime id 顺序把冲突对拆分到串行子层（不添加语义依赖边、不制造环），未冲突的 runtime 仍并行。任何非 `strict` 值都归一为 `warn`。属于框架运行期开关（feature 组），非插件 per-session 设置。
- 插件自带的运行期开关——如 story-guard 的 `STORY_GUARD_REDACT_TERMS` / `STORY_GUARD_REDACT_MARK` / `STORY_GUARD_BLOCKED_TOOLS`——由插件自身经 `process.env` 读取，并在各自 `PLUGIN.md` / `README.md` 文档化。它们不经框架 env helper，也不在本 registry 的分组表内：这是「插件作者可读自己 env」的既定边界，与框架运行期开关分离管理。
- cost-gate 的 `COST_GATE_SOFT_TOKENS` / `COST_GATE_HARD_TOKENS` 现已降级为**兜底**：阈值优先取 per-session `userSettings`（hook 经 `HookContext.getOwnSettings()` 读取本插件解析后的设置），回退链为 **per-session `userSettings` → env → 硬编码默认（400000 / 600000）**。只设 env 的旧部署照常工作；详见 `plugins/cost-gate/PLUGIN.md`。

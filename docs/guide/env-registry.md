# 环境变量 Registry

Covel 的环境变量清单由 `packages/shared/src/env/registry.ts` 维护。代码读取环境变量时优先使用 `@covel/shared` 暴露的 helper：

- `readRuntimeEnv()`：读取 server / storage / desktop 常用配置。
- `isEnvEnabled()`：读取严格 feature flag，只有字符串 `1` 表示开启。
- `isEnvDefaultOn()`：读取默认开启的开关，`0` / `false` 表示关闭。
- `readEnvString()` / `readEnvInt()` / `readEnvChoice()`：读取单个变量。
- `providerApiKeysFromEnv()`：扫描所有 `*_API_KEY` 并映射成 provider id。

## 分组

| group       | 用途                                                         |
| ----------- | ------------------------------------------------------------ |
| `storage`   | `STORE_BACKEND`、`DATABASE_URL`、SQLite / PostgreSQL 配置    |
| `server`    | 端口、CORS、静态资源、部署层级、限流                         |
| `desktop`   | Electron 注入给 server sidecar 的路径与桌面模式配置          |
| `ai`        | LLM 配置、provider keys、Langfuse、模型数据库、prompt 根目录 |
| `feature`   | 运行期功能开关                                               |
| `web`       | Vite dev proxy 与浏览器侧公开变量                            |
| `test`      | Playwright、live provider tests、e2e harness、开发脚本       |
| `packaging` | Electron 签名、公证、updater 密钥                            |

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

## 迁移规则

1. 新增环境变量时，先在 `COVEL_ENV_REGISTRY` 加 definition。
2. 运行时代码读取 env 时使用 helper，保留 `process.env` 给动态枚举场景。
3. 新增 provider 只需要遵守 `${PROVIDER}_API_KEY` 命名，registry 只记录常用示例。
4. 新增 feature flag 使用清晰的能力名，避免用版本号表达开发阶段。
5. 默认关闭的运行期开关用 `isEnvEnabled()`；默认开启的开关用 `isEnvDefaultOn()` 并在 registry 里写清楚关闭值。
6. `.env.example` 和 `.env.llm.example` 只放可公开示例值。

## 当前整理结论

- `STORE_BACKEND` 的代码默认值为 `sqlite`。
- `DEPLOYMENT_TIER=self` 对应本地自部署；localhost 请求可以读取 server 注入的 provider key 元数据。`demo` / `commercial` 会硬性强制 session owner token 鉴权（见 [`docs/reference/api.md`](../reference/api.md) 鉴权章节）。未知值会被规范化并 fail-closed 到最严格的 `commercial`。
- `COVEL_DESKTOP_REST_TOKEN` 是运维 master / operator 凭证：以该值作为 Bearer token 可通过任意会话的 owner 校验（管理工具 / e2e harness 用），并且是 hosted（`demo` / `commercial`）层级创建/列出会话、世界写入与维度导入、AI 世界生成、模型探测/刷新以及 community server-code 激活的必需凭证。`DEPLOYMENT_TIER=demo|commercial` 启动时若未配置该 token，`validateSecurityPosture` 会直接拒绝启动（fail-closed）。`self` / 桌面 / dev 层级不要求也不校验它。这是当前单运维方信任模型，不提供多租户身份或代码沙箱（见 [`docs/reference/api.md`](../reference/api.md) 鉴权章节）。
- `COVEL_BIND_HOST` 默认 `127.0.0.1`（audit S-02）：本地 / 桌面部署只监听回环接口，网络上不可达。容器或多 pod 部署需显式设置 `COVEL_BIND_HOST=0.0.0.0`（`docker/docker-compose.yml` 已内置）——这是一次显式的部署决策，公开监听前请确认 `DEPLOYMENT_TIER` 与鉴权配置。
- `TRUSTED_PROXY_IPS`、`COVEL_LLM_REPLAY`、`COVEL_LLM_REPLAY_DIR`、`COVEL_ALLOWED_LLM_HOSTS` 目前标记为 `documented`，后续实现可以直接提升为 `active`。
- `COVEL_TRACE_TRUNCATE` 标记为 `planned`，对应 debug trace 设计文档中的未来开关。
- `COVEL_SNAPSHOT_INTERVAL_TURNS` 默认 `5`，控制 `kind=auto` 快照的 checkpoint 节奏：`turnCount <= 1`（pre-game 与首个正式回合）总是写入，其后每 N 回合写一份；`1` 表示每回合。resume 路径无视该节流强制写入。构建快照 payload 需要全量读取消息历史与全部 session-scoped 集合，逐回合写入会导致 O(T²) 成本与存储膨胀（audit 2026-07-11 R-04）。
- `COVEL_MEDIA_CLEANUP_ENABLED` 默认 `false`，控制 `POST /api/media/cleanup` 的可用性。即使设为 `true`，`DEPLOYMENT_TIER=commercial` 时该端点仍强制 503，等待管理员鉴权中间件接入。详见 [`docs/reference/api.md`](../reference/api.md) 媒体管理章节。
- `COVEL_PG_LOCK_POOL_MAX` 默认 `16`，控制 PG advisory session-lock 专用连接池的 `max`。每个进行中的 turn 占用一条 reserved 连接；多并发 pod 可按峰值并发会话数调大。锁获取超时（30s）覆盖连接池排队 + advisory lock 轮询全程。
- `COVEL_SUSPENSION_TTL_MS` 默认 `604800000`（7 天），控制未解决（unresolved）挂起项的过期清理（TODO S4-T4.c）。清理无独立调度器：服务启动时执行一次性 force sweep，之后由 `GET /api/sessions/:id/suspensions` 与 `POST /api/sessions/:id/resume` 机会式触发、最多每小时一次的时间门控 sweep。设为 `0`（或负数）关闭清理。**claimed（恢复进行中）/ 已成功解决的记录永不清理**。属于框架基础设施开关（非插件 per-session 设置）。详见 [`docs/reference/api.md`](../reference/api.md) Suspend / Resume 章节。
- 插件自带的运行期开关——如 story-guard 的 `STORY_GUARD_REDACT_TERMS` / `STORY_GUARD_REDACT_MARK` / `STORY_GUARD_BLOCKED_TOOLS`——由插件自身经 `process.env` 读取，并在各自 `PLUGIN.md` / `README.md` 文档化。它们不经框架 env helper，也不在本 registry 的分组表内：这是「插件作者可读自己 env」的既定边界，与框架运行期开关分离管理。
- cost-gate 的 `COST_GATE_SOFT_TOKENS` / `COST_GATE_HARD_TOKENS` 现已降级为**兜底**：阈值优先取 per-session `userSettings`（hook 经 `HookContext.getOwnSettings()` 读取本插件解析后的设置），回退链为 **per-session `userSettings` → env → 硬编码默认（150000 / 200000）**。只设 env 的旧部署照常工作；详见 `plugins/cost-gate/PLUGIN.md`。

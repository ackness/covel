# 环境变量 Registry

Covel 的环境变量清单由 `packages/shared/src/env/registry.ts` 维护。代码读取环境变量时优先使用 `@covel/shared` 暴露的 helper：

- `readRuntimeEnv()`：读取 server / storage / desktop 常用配置。
- `isEnvEnabled()`：读取严格 feature flag，只有字符串 `1` 表示开启。
- `isEnvDefaultOn()`：读取默认开启的开关，`0` / `false` 表示关闭。
- `readEnvString()` / `readEnvInt()` / `readEnvChoice()`：读取单个变量。
- `providerApiKeysFromEnv()`：扫描所有 `*_API_KEY` 并映射成 provider id。

## 分组

| group | 用途 |
| --- | --- |
| `storage` | `STORE_BACKEND`、`DATABASE_URL`、SQLite / PostgreSQL 配置 |
| `server` | 端口、CORS、静态资源、部署层级、限流 |
| `desktop` | Electron / Tauri 注入给 server sidecar 的路径与桌面模式配置 |
| `ai` | LLM 配置、provider keys、Langfuse、模型数据库、prompt 根目录 |
| `feature` | 运行期功能开关 |
| `web` | Vite dev proxy 与浏览器侧公开变量 |
| `test` | Playwright、live provider tests、e2e harness、开发脚本 |
| `packaging` | Electron / Tauri 签名、公证、updater 密钥 |

## 状态

| status | 含义 |
| --- | --- |
| `active` | 代码已读取，属于当前运行契约 |
| `documented` | 文档或示例已有，源码读取接入排期中 |
| `planned` | 设计文档中的未来开关 |
| `packaging` | 打包工具链读取，应用运行时代码通常只透传 |

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `.env` | 基础设施、server、storage、feature flag、本地开发辅助配置 |
| `.env.llm` | provider API key 与 provider base URL |
| `llm.toml` | slot、provider、model、protocol、capability 配置；支持 `${VAR}` 插值 |
| `~/.covel/keys.env` | 桌面端持久化 provider API key |
| `~/.covel/config.toml` | 桌面端数据目录与日志轮转配置 |

## 迁移规则

1. 新增环境变量时，先在 `COVEL_ENV_REGISTRY` 加 definition。
2. 运行时代码读取 env 时使用 helper，保留 `process.env` 给动态枚举场景。
3. 新增 provider 只需要遵守 `${PROVIDER}_API_KEY` 命名，registry 只记录常用示例。
4. 新增 feature flag 使用 `COVEL_*_V1` 命名，默认关闭时用 `isEnvEnabled()`。
5. 默认开启的兼容开关使用 `isEnvDefaultOn()`，当前代表是 `COVEL_COMMIT_TXN_V1`。
6. `.env.example` 和 `.env.llm.example` 只放可公开示例值。

## 当前整理结论

- `STORE_BACKEND` 的代码默认值为 `sqlite`。
- `DEPLOYMENT_TIER=self` 对应本地自部署；localhost 请求可以读取 server 注入的 provider key 元数据。
- `TRUSTED_PROXY_IPS`、`COVEL_LLM_REPLAY`、`COVEL_LLM_REPLAY_DIR`、`COVEL_ALLOWED_LLM_HOSTS` 目前标记为 `documented`，后续实现可以直接提升为 `active`。
- `COVEL_TRACE_TRUNCATE` 标记为 `planned`，对应 debug trace 设计文档中的未来开关。

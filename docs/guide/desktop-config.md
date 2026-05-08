# 桌面版配置与数据目录

适用于 [`apps/desktop/`](../../apps/desktop/)（Electron）与 [`apps/desktop-tauri/`](../../apps/desktop-tauri/)（Tauri）两种桌面壳。两者启动同一个 Node sidecar bundle，并按下文统一的目录契约喂入环境变量；两个 launcher 各自维护一份等价实现，必须保持一致。

> **当前推荐入口：Electron**。Tauri 壳已经按相同契约对齐，但与现有 plugin / sidecar 生态在 macOS 多窗口、code signing、`tauri-plugin-log` 切换等场景下仍有兼容性问题，**暂不作为官方支持的发行入口**，仅供想自行折腾的开发者。生产分发请使用 `pnpm build:electron` 产物。

## 目录结构

桌面版首次启动会自动创建 `~/.covel/`。配置小文件与用户插件放这里；占空间的 SQLite、日志与用户世界默认放 `~/.covel/data/`，可通过 `config.toml` 一起重定向到外置硬盘。

```
~/.covel/                    ← 配置根（小文件，随应用版本稳定）
  config.toml                ← 数据位置指针 + 日志轮转参数（见下文）
  llm.toml                   ← LLM slot 配置（provider / model / baseUrl）
  keys.env                   ← provider API key，KEY=VALUE 纯文本
  plugins/                   ← 用户插件（和 app bundle 内的核心插件合并）

<data_root>/                 ← 默认 ~/.covel/data；可改到任意路径
  covel.db                   ← SQLite 数据库
  worlds/                    ← 用户创建的世界
  logs/                      ← 应用日志（按尺寸轮转，NDJSON 一行一记录）
    desktop.log              ← Electron 主进程事件（窗口 / IPC / sidecar 监督 / 启动失败）
    server.log               ← Node sidecar 的 stdout/stderr（bootstrap 输出 + Hono 请求日志）
    desktop.log.1 … .N       ← 轮转副本，超过 max_files 丢弃最旧
    server.log.1 … .N
    tauri-main*.log          ← Tauri 主进程（Tauri 壳专用，pino-roll）
  server.port                ← 最近一次启动的端口（诊断用）
```

**日志写入约定**：

- `/api/health` 心跳被 Hono logger 显式跳过，不再刷屏；通过 `COVEL_LOG_QUIET_PATHS=/api/foo,/api/bar` 可追加要静默的路径
- 业务级 trace（LLM 调用、proposal、tool 调用）**不写文件**，留在 DB `trace_events` 表，通过 `/debug` 页面或 JSON 导出查看
- `pnpm dev:server` 单跑时，server 自身会把 stdout/stderr 同时落到 `server.log`（终端仍可见原文）；`COVEL_SERVER_LOG_FILE=""` 可禁用，`COVEL_SERVER_LOG_FILE=/path/foo.log` 可改路径
- 老版本写入的 `electron.log` 会随轮转自然过期，不会被自动迁移

## `~/.covel/config.toml`

首次启动自带注释模板。字段：

```toml
[paths]
# 数据目录。相对路径相对于本文件所在目录；绝对路径直接使用。
# 默认：~/.covel/data
# data_root = "/Volumes/External/covel-data"

[logging]
# 单个日志文件上限（MB），超过后轮转
max_size_mb = 10
# 保留的轮转文件数，超出后丢弃最旧一份。总磁盘占用 ≈ max_size_mb × max_files
max_files   = 10
```

改完要重启 Covel 生效。**改 `data_root` 不会搬旧数据** —— 新位置是空的，老数据与用户世界留在原处你自己处理。

## `~/.covel/keys.env`

```env
# 一行一个 KEY=VALUE，# 开头是注释
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

server 会按 `*_API_KEY` 扫描所有条目注入 provider 运行时。Key 名 = provider 名全大写 + `_API_KEY`。文件权限默认 `0600`，app 保存时会重置；手动编辑后注意别改得太宽。

## `~/.covel/llm.toml`

见仓库根 [`llm.toml.example`](../../llm.toml.example) 示例；每个 slot 对应一个 provider / 模型组合。app 自带兜底 `story` slot 指向 DeepSeek —— 填好 `keys.env` 的 `DEEPSEEK_API_KEY` 就能跑。

## 前端入口

**Settings → Desktop** tab 暴露所有路径、一键打开目录、切换 `data_root`。不想改文件就在 UI 里点。

## 桌面 REST 写接口的 token 门

桌面版 sidecar 会在每次启动时生成一个一次性 bearer token，并以 `COVEL_DESKTOP_REST_TOKEN` 注入子进程环境。所有写接口（`PUT /api/config/keys`、`PUT /api/config/settings`、`PUT /api/config/data-root`、`POST /api/config/open-folder`）会校验请求头 `Authorization: Bearer <token>`，缺失或不匹配返回 `401`。读接口（`GET /api/config/info`、`GET /api/config/keys`（仅返回 provider 列表）、`GET /api/config/settings`）保持开放。

`GET /api/config/info` 的响应里增加了 `requiresAuth` 字段，前端据此决定是否需要附带 Authorization 头。Electron 渲染进程通过 `covel:get-info` IPC 拿到 `restToken` 字段，自动注入到所有写请求。开发模式下若未设置该 env，token 门不启用，纯 web tier 与 `pnpm dev:web` 流程保持原样。

## 相关文档

- [README · 快速开始](../../README.md#-快速开始) — 下载与首次启动
- [apps/desktop/PACKAGING.md](../../apps/desktop/PACKAGING.md) — 桌面版本地构建、签名、公证
- [reference/api.md](../reference/api.md) — 后端 API 参考

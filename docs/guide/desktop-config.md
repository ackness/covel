# 桌面版配置与数据目录

适用于 [`apps/desktop/`](../../apps/desktop/)（Electron）。桌面壳启动同一个 Node sidecar bundle，并按下文的目录契约喂入环境变量。

## 目录结构

桌面版首次启动会自动创建 `~/.covel/`。配置小文件与用户插件放这里；占空间的 SQLite、日志与用户世界默认放 `~/.covel/data/`，可通过 `config.toml` 一起重定向到外置硬盘。

```
~/.covel/                    ← 配置根（小文件，随应用版本稳定）
  config.toml                ← 数据位置指针 + 日志轮转参数（见下文）
  llm.toml                   ← LLM slot 配置（provider / model / baseUrl）
  keys.env                   ← provider API key，KEY=VALUE 纯文本
  settings.json              ← 前端用户偏好（unified SettingsStore：locale / 外观 / slot 覆盖 / 每插件设置）
  plugins/                   ← 用户插件（和 app bundle 内的核心插件合并）

<data_root>/                 ← 默认 ~/.covel/data；可改到任意路径
  covel.db                   ← SQLite 数据库
  worlds/                    ← 用户创建的世界
  logs/                      ← 应用日志（按尺寸轮转，NDJSON 一行一记录）
    desktop.log              ← Electron 主进程事件（窗口 / IPC / sidecar 监督 / 启动失败）
    server.log               ← Node sidecar 的 stdout/stderr（bootstrap 输出 + Hono 请求日志）
    desktop.log.1 … .N       ← 轮转副本，超过 max_files 丢弃最旧
    server.log.1 … .N
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

**热重载**：改完 `llm.toml` 不必重启 app —— 到 **Settings → LLM** 点「重载配置」即可。后端会重读文件并原地应用到运行中的 gateway（`POST /api/llm-config/reload`），新增/删除的 slot 立即生效。桌面版该接口受一次性 bearer token 保护（同其他写接口），前端自动附带；dev/web tier 无 token 时开放。

**解析失败可见**：若 `llm.toml` 有语法错误（如某个 key 写了 `=` 却没值），整份文件会解析失败并**回退到内置默认**（只剩一个 `story` slot）。此时 `GET /api/llm-config` 会带 `error` 字段，**Settings → LLM** 顶部显示红色提示（含具体错误），不再静默回退让你摸不着头脑。改好后点「重载配置」即可恢复。

**插件 provider slot 就地覆盖**：有些插件（如图像生成）通过 `modelPresetId` 设置指定要用哪个 `[covel.<slot>]`（如 `openai-image`）。如果你没配那个 slot 名、但配了别的同类 slot（如 `gpt-image`），可在**开局准备**界面该插件那一行的「提供方 slot」下拉里直接选你已有的 slot —— 不必去 Settings > Plugins 改、也不必照搬插件默认的 slot 名。选中后红色「缺少」提示即消失，覆盖值会随回合下发给该插件的 function runtime。

## 前端入口

**Settings → Desktop** tab 暴露所有路径、一键打开目录、切换 `data_root`。不想改文件就在 UI 里点。

## 桌面 REST 写接口的 token 门

桌面版 sidecar 会在每次启动时生成一个一次性 bearer token，并以 `COVEL_DESKTOP_REST_TOKEN` 注入子进程环境。所有写接口（`PUT /api/config/keys`、`PUT /api/config/settings`、`PUT /api/config/data-root`、`POST /api/config/open-folder`）以及 `GET /api/config/settings`（返回完整 settings.json 内容）都会校验请求头 `Authorization: Bearer <token>`，缺失或不匹配返回 `401`。真正开放的只有 `GET /api/config/info` 和 `GET /api/config/keys`（仅返回 provider 列表，不含 key 值）。

`GET /api/config/info` 的响应里增加了 `requiresAuth` 字段，前端据此决定是否需要附带 Authorization 头。Electron 渲染进程通过 `covel:get-info` IPC 拿到 `restToken` 字段，自动注入到所有写请求。开发模式下若未设置该 env，token 门不启用，纯 web tier 与 `pnpm dev:web` 流程保持原样。

## 相关文档

- [README · 快速开始](../../README.md#-快速开始) — 下载与首次启动
- [apps/desktop/PACKAGING.md](../../apps/desktop/PACKAGING.md) — 桌面版本地构建、签名、公证
- [reference/api.md](../reference/api.md) — 后端 API 参考

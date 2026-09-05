# 桌面版配置与数据目录

> 🇬🇧 [English version](./desktop-config.en.md)

适用于 [`apps/desktop/`](../../apps/desktop/)（Electron）。桌面壳启动同一个 Node sidecar bundle，并按下文的目录契约喂入环境变量。

## 目录结构

桌面版首次启动会自动创建 `~/.covel/`。配置小文件与用户插件放这里；占空间的 SQLite、日志与用户世界默认放 `~/.covel/data/`，可通过 `config.toml` 一起重定向到外置硬盘。

```
~/.covel/                    ← 配置根（小文件，随应用版本稳定）
  config.toml                ← 数据位置指针 + 日志轮转参数（见下文）
  llm.toml                   ← LLM slot 配置（provider / model / baseUrl）
  keys.env                   ← provider API key，KEY=VALUE 纯文本
  settings.json              ← 前端用户偏好（unified SettingsStore：locale / 外观 / slot 覆盖 / 每插件设置）
  app-update.json            ← 已忽略的桌面应用版本
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
- sidecar 的普通 stderr 记为 `error`；框架对可恢复 warning 使用 `[covel:warn]` 传输标记，日志收集器去掉标记后以 `warn` 持久化，`policy: warn` 调度诊断和自动重试因此不会污染 error 统计
- 老版本写入的 `electron.log` 会随轮转自然过期，不会被自动迁移

## `~/.covel/config.toml`

首次启动自带注释模板。字段：

```toml
schema_version = 1

[paths]
# 数据目录。相对路径相对于本文件所在目录；绝对路径直接使用。
# 默认：~/.covel/data
# data_root = "/Volumes/External/covel-data"

[network]
# direct | system | http | socks
proxy_mode = "direct"
# HTTP(S) 示例：http://127.0.0.1:7890
# SOCKS5 示例：socks5://127.0.0.1:7891
proxy_url = ""

[logging]
# 单个日志文件上限（MB），超过后轮转
max_size_mb = 10
# 保留的轮转文件数，超出后丢弃最旧一份。总磁盘占用 ≈ max_size_mb × max_files
max_files   = 10
```

未写 `schema_version` 的旧配置按 v1 读取。桌面 UI 和 REST 接口只修改上述已知字段，保留未知字段、未知 section 和已有注释；写入前后都会严格解析整份 TOML。若文件损坏，应用仍可用默认值启动并打印警告，但拒绝覆盖原文件，须先手动修复。成功写入通过同目录临时文件 + rename 原子替换，并将权限设为 `0600`。

手动改完要重启 Covel 生效；在 **设置 → 桌面 → 网络代理** 保存则会立即热应用。`direct` 不走代理，`system` 针对每个目标 URL 动态采用 Electron/Chromium 返回的系统规则和有序 fallback，`http` 接受 `http://` / `https://` 地址，`socks` 接受 `socks://` / `socks5://` 地址；省略协议时分别补为 `http://` 与 `socks5://`。代理 URL 可带 `user:password@host`，因此配置文件会收紧为 `0600`。

代理覆盖框架拥有的核心 LLM 请求、GitHub 模型数据库更新和桌面应用版本检查。第三方插件的 `fetchWithRetry` 保持直连和严格 DNS/SSRF pinning，避免代理侧远程 DNS 绕过插件网络边界。

## 新版本提示

正式打包的桌面版每次启动会通过 `GET /api/app-update/latest` 查询 GitHub 最新稳定 Release。该请求由 sidecar 的统一出站网络层发起，因此遵循设置中的 `direct`、`system`、HTTP(S) 或 SOCKS5 代理。若 GitHub 版本高于当前 SemVer，系统原生对话框提供“前往下载”和“忽略此版本”；前者打开固定的 Covel GitHub Releases 页面，后者将版本记入独立的 `app-update.json`，避免与前端设置写入发生 revision 冲突，并只在出现更高版本后再次提示。检查失败只写入桌面日志，不影响启动，也不会自动下载或安装文件。

**改 `data_root` 不会搬旧数据** —— 新位置是空的，老数据与用户世界留在原处你自己处理。

## `~/.covel/keys.env`

```env
# 一行一个 KEY=VALUE，# 开头是注释
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

server 会按 `*_API_KEY` 扫描所有条目注入 provider 运行时。Key 名 = provider 名全大写 + `_API_KEY`。文件权限默认 `0600`，app 保存时会重置；手动编辑后注意别改得太宽。

## `~/.covel/llm.toml`

见仓库根 [`llm.toml.example`](../../llm.toml.example) 示例；每个模型用途对应一个服务商 / 模型组合。应用自带的兜底 `story` 用途指向 `deepseek-v4-flash`，填好 `keys.env` 的 `DEEPSEEK_API_KEY` 即可运行。

设置界面的模型部分分为“用途分配”“服务商与模型”“生成参数”。“服务商与模型”采用服务商列表 + 详情结构，一个服务商只需配置一次 API 地址、协议、密钥和价格倍率，并可批量添加多个模型 ID；`openai/gpt-5.6-sol` 等带 `/` 的 ID 会按原样发送。随后在“用途分配”中分别选择服务商和模型，无需再创建自定义 Preset。价格倍率默认 `1`，调试成本面板会用模型参考价乘以该倍率估算结算金额。

模型设置只把 `llm.providers` 作为持久化真源；旧版 `llm.customPresets` 会在启动时先迁移连接密钥和模型引用，全部成功后删除。旧 API facade 与请求中的 custom preset 结构由 providers 即时编译，不再维护第二份同步副本。

**热重载**：改完 `llm.toml` 不必重启应用 —— 到 **设置 → 模型 → 用途分配** 点“重新加载配置”即可。后端会重读文件并原地应用到运行中的 gateway（`POST /api/llm-config/reload`），新增/删除的用途立即生效。桌面版该接口受一次性 bearer token 保护（同其他写接口），前端自动附带；dev/web tier 无 token 时开放。

**解析失败可见**：若 `llm.toml` 有语法错误（如某个 key 写了 `=` 却没值），整份文件会解析失败并**回退到内置默认**（只剩一个 `story` slot）。此时 `GET /api/llm-config` 会带 `error` 字段，**Settings → LLM** 顶部显示红色提示（含具体错误），不再静默回退让你摸不着头脑。改好后点「重载配置」即可恢复。

### 给单个世界或会话调整插件 runtime 模型

设置页的“用途分配”决定每个 slot 当前实际使用的服务商和模型，例如把 `plugin` 指向 `ali-coding-plan / qwen3.8-flash`。插件 manifest 只声明默认 slot（如 `model: plugin`），不会把 `deepseek-v4-flash` 之类的具体模型写死到世界中。

在**开局准备**的插件列表里，每个 agent runtime 都可以进一步选择一个 slot：

- 选择“插件默认用途：`plugin`”表示不做世界级覆盖，实际模型跟随设置页中 `plugin` 的当前有效配置。
- 选择 `story`、`fast` 等其他 slot，会把 `runtimeId → slot` 保存到新会话的 `runtimeModelOverrides`，只影响这局，不修改世界包或全局设置。
- 多 runtime 插件会逐项显示完整 runtime ID（例如 `char-creator/character-tracker`）；每项可独立选择。
- 已进入游戏后，可在左侧插件列表继续修改 agent runtime 的 slot；服务端通过 `PATCH /api/sessions/:id` 保存，并从下一次执行开始生效。

下拉项与默认摘要同时显示 slot、服务商和**当前有效模型**。因此 `default: plugin` 是路由声明，旁边的 `ali-coding-plan · qwen3.8-flash` 才是这台设备实际会调用的目标；两者并不冲突。以后在设置页把 `plugin` 改到另一个模型时，仍绑定 `plugin` 的 runtime 会自动跟随，不需要逐个世界重配。

这套 `runtimeModelOverrides` 只适用于 agent runtime。图像、语音等 function runtime 常通过插件设置 `modelPresetId` 选择媒体 provider slot；它会在开局准备中单独显示为“提供方 slot”，保存到当前设备的插件设置，而不是当前会话的 runtime 覆盖。

**插件 provider slot 就地覆盖**：有些插件（如图像生成）通过 `modelPresetId` 设置指定要用哪个 `[covel.<slot>]`（如 `openai-image`）。如果你没配那个 slot 名、但配了别的同类 slot（如 `gpt-image`），可在**开局准备**界面该插件那一行的「提供方 slot」下拉里直接选你已有的 slot —— 不必去 Settings > Plugins 改、也不必照搬插件默认的 slot 名。选中后红色「缺少」提示即消失，覆盖值会随回合下发给该插件的 function runtime。

## 前端入口

**Settings → Desktop** tab 暴露所有路径、一键打开目录、切换 `data_root`。不想改文件就在 UI 里点。

## 桌面 REST 写接口的 token 门

桌面版 sidecar 会在每次启动时生成一个一次性 bearer token，并以 `COVEL_DESKTOP_REST_TOKEN` 注入子进程环境。所有写接口（`PUT /api/config/keys`、`PUT /api/config/settings`、`PUT /api/config/proxy`、`PUT /api/config/data-root`、`POST /api/config/open-folder`）以及会返回本地配置或代发外部请求的 `GET /api/config/settings` / `GET /api/config/proxy` / `GET /api/app-update/latest` 都会校验请求头 `Authorization: Bearer <token>`，缺失或不匹配返回 `401`。真正开放的只有 `GET /api/config/info` 和 `GET /api/config/keys`（仅返回 provider 列表，不含 key 值）。

REST Settings backend 会把 `GET /api/config/keys` 返回的 provider 列表 hydration 为仅存在于内存的“server-managed”标记；该标记不会显示为 key 明文，也不会进入 `X-Provider-Keys`。保存全量 SettingsStore secret snapshot 时，backend 会保留未编辑的 server-managed key、把新输入转换成 PUT patch，并把从快照移除的 provider 转换成显式删除，因此不会把 provider 列表误当成 secret map，也不会因编辑一个 key 覆盖其他 key。

若 `keys.env` 无法读取，GET 返回 `500 keys_file_unreadable`，PUT 返回 `409 keys_file_unreadable` 并保留原路径；写入同样使用同目录临时文件 + rename 原子替换。

`settings.json` 使用同目录临时文件 + rename 原子替换，当前持久化格式为 `schemaVersion: 2`，并携带单调 `revision`。旧版 v1（必须有对象 `entries`）会在内存迁移为 revision 0，并在下次成功保存时写为 v2。若现有文件无法读取、JSON/`entries` 损坏或版本过新，GET 返回 `500 settings_file_invalid`，PUT 返回 `409 settings_file_invalid` 并保留原文件；写入必须携带读取到的 revision，若另一实例先保存则返回 `409 settings_revision_conflict` 且文件不变。读取失败时 SettingsStore 保持只读。正常的 revision 冲突会先验证并加载最新快照，再按设置键做三方比较：不同键的修改可在 CAS 保护下重放，同一键（包括整个对象或数组）的冲突仍拒绝覆盖，并提示核对最新值后重试。普通设置在浏览器 storage 事件、窗口重新聚焦或页面恢复可见时同步；这些同步不读取或写入 API key。详见 [SettingsStore 契约](../reference/settings-store.md)。

`GET /api/config/info` 的响应里增加了 `requiresAuth` 字段，前端据此决定是否需要附带 Authorization 头。Electron 渲染进程通过 `covel:get-info` IPC 拿到 `restToken` 字段，自动注入到所有写请求。开发模式下若未设置该 env，token 门不启用，纯 web tier 与 `pnpm dev:web` 流程保持原样。

## 相关文档

- [README · 快速开始](../../README.zh-CN.md#快速开始) — 下载与首次启动
- [desktop-packaging.md](./desktop-packaging.md) — 桌面版本地构建、签名、公证
- [reference/api.md](../reference/api.md) — 后端 API 参考

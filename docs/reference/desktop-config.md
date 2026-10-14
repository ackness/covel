# 桌面版配置与数据目录

> [English version](../en/reference/desktop-config.md)

这一页逐个说明桌面版（Electron，源码在 [`apps/desktop/`](../../apps/desktop/)）用到的文件：它们在哪里、里面写什么、损坏时会发生什么。想手动改配置、排查桌面版问题或者给桌面版写工具的人需要它。只想知道存档在哪、怎样备份，看[数据、备份与升级](../start/data-and-upgrade.md)就够了。

桌面程序启动时会在本机起一个后端进程（下文叫“后端”），并把这一页的目录通过环境变量告诉它。

## 目录结构

桌面版第一次启动时自动创建 `~/.covel/`。小的配置文件和用户插件放在这里。占空间的数据库、日志和用户世界默认放在 `~/.covel/data/`，可以通过 `config.toml` 一起移到别的磁盘。

```text
~/.covel/                    ← 配置根目录（小文件）
  config.toml                ← 数据位置、网络代理、日志轮转参数（见下文）
  llm.toml                   ← 模型用途配置（服务商 / 模型 / 地址）
  keys.env                   ← 服务商 API 密钥，KEY=VALUE 纯文本
  settings.json              ← 界面里的设置：语言、外观、用途覆盖、每个插件的设置
  reasoning-models.json      ← 可选：内置数据还没收录的模型的思考档位（见 slots.md 的“档位数据”）
  app-update.json            ← 已忽略的桌面应用版本
  window-state.json          ← 窗口尺寸、位置、最大化和全屏状态
  data-root-copy.json        ← 待执行的数据目录复制，只在下次启动前存在
  plugins/                   ← 用户插件（和应用自带的核心插件合并）

<data_root>/                 ← 默认 ~/.covel/data；可以改到任意路径
  covel.db                   ← SQLite 数据库
  worlds/                    ← 用户创建和安装的世界
  logs/                      ← 应用日志（按大小轮转，NDJSON，一行一条）
    desktop.log              ← 桌面主进程的事件（窗口 / IPC / 后端监督 / 启动失败）
    server.log               ← 后端的 stdout/stderr（启动输出和请求日志）
    desktop.log.1 … .N       ← 轮转副本，超过 max_files 后丢弃最旧的
    server.log.1 … .N
  server.port                ← 最近一次启动用的端口（下次优先复用）
```

思考档位数据的说明在[模型用途](./slots.md)。

**日志写入约定**：

- 请求日志默认不记录 `/api/health`。用 `COVEL_LOG_QUIET_PATHS=/api/foo,/api/bar` 可以改成别的路径列表。
- 每个回合里的模型调用、proposal、工具调用**不写进这些文件**。它们在数据库的 `trace_events` 表里，通过 `/debug` 页面或 JSON 导出查看。
- 单独运行 `pnpm dev:server` 时，server 会把 stdout/stderr 同时写到 `server.log`，终端里仍然看得到。`COVEL_SERVER_LOG_FILE=""` 关闭它，`COVEL_SERVER_LOG_FILE=/path/foo.log` 改路径。
- 后端的普通 stderr 记为 `error`。框架给可恢复的警告加上 `[covel:warn]` 标记，日志收集时去掉标记并记为 `warn`。所以 `policy: warn` 的调度诊断和自动重试不会算进 error。
- 很老的版本写过 `electron.log`。它不会被迁移，随轮转自然过期。

## `~/.covel/config.toml`

第一次启动时生成一份带注释的模板。字段：

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
# proxy_url = "http://127.0.0.1:7890"

[logging]
# 单个日志文件上限（MB），超过后轮转
max_size_mb = 10
# 保留的轮转文件数，超出后丢弃最旧一份。总磁盘占用 ≈ max_size_mb × max_files
max_files   = 10
```

读写规则：

- 没写 `schema_version` 的旧文件按 v1 读取。
- 界面和 REST 接口只修改上面这些已知字段。未知字段、未知的段和已有的注释都保留。
- 每次写入前后都会严格解析整份 TOML。
- 文件损坏时，应用仍然用默认值启动并打印警告，但拒绝覆盖原文件。你需要先手动修好它。
- 写入时先写同目录的临时文件，再改名替换，并把权限设为 `0600`。

**什么时候生效。** 手动改完要重启 Covel。在 **设置 → 桌面 → 网络代理** 里保存则立即生效。

**代理模式：**

| `proxy_mode` | 效果                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| `direct`     | 不走代理                                                                        |
| `system`     | 对每个目标 URL 询问系统代理规则，按系统返回的顺序依次尝试                       |
| `http`       | 使用 `proxy_url`，接受 `http://` 和 `https://` 地址；没写协议时补 `http://`     |
| `socks`      | 使用 `proxy_url`，接受 `socks://` 和 `socks5://` 地址；没写协议时补 `socks5://` |

代理地址可以带 `user:password@host`，所以保存代理设置时配置文件的权限会收紧为 `0600`。

**代理管哪些请求：**

- 框架自己发出的模型请求。
- 从 GitHub 更新模型数据库。
- 从 GitHub 解析和下载插件。
- 桌面应用的版本检查。

第三方插件的 `fetchWithRetry` 不走代理。它保持直连，并严格固定 DNS 解析结果，避免通过代理端的远程 DNS 绕过插件的网络限制。

## 新版本提示

正式打包的桌面版每次启动时，通过 `GET /api/app-update/latest` 查询 GitHub 上最新的稳定 Release。

- 请求由后端发出，走设置里选的 `direct`、`system`、HTTP(S) 或 SOCKS5 代理。
- GitHub 上的版本比当前版本新时，弹出系统原生对话框，有“前往下载”和“忽略此版本”两个按钮。
- “前往下载”打开固定的 Covel GitHub Releases 页面。
- “忽略此版本”把这个版本记到单独的 `app-update.json` 里（不写 `settings.json`，避免和界面设置的保存冲突）。出现更高的版本时才会再次提示。
- 检查失败只写入桌面日志，不影响启动。
- 不会自动下载或安装任何文件。

> [!NOTE]
> **手动改 `data_root` 不会复制数据。** 新位置里没有数据时是空的，旧的数据和用户世界留在原处。在 **设置 → 桌面** 里切换时，Covel 会问要不要复制，见[前端入口](#前端入口)。

## `~/.covel/keys.env`

外部环境的密钥优先于本地保存的副本，即使两个值相同。删除本地副本不会删除外部密钥。后端启动时先记录外部密钥，再加载 `keys.env`，因此保存操作不会混淆两种来源。

```env
# 一行一个 KEY=VALUE，# 开头是注释
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

- 后端会找出所有 `*_API_KEY` 条目，交给对应的服务商使用。
- 变量名 = 服务商名全大写 + `_API_KEY`。
- 文件权限默认 `0600`，应用保存时会重新设置。手动编辑后注意不要把权限放宽。

保存的过程：

- 后端不可用时，桌面程序直接读现有的密钥，只改这次提到的服务商，其余保持不变。
- 先写同目录的独占临时文件并设为 `0600`，完成后改名替换原文件。
- 写入、设置权限或改名失败时，原文件保留，临时文件会被尝试清理，并报告失败。
- 密钥值里有换行时，写入前就拒绝。

这保证文件要么是旧的、要么是完整的新内容。它不保证断电后新内容一定已经落盘。

## `~/.covel/llm.toml`

桌面程序总是把这个路径传给后端，即使文件还不存在。应用不会从安装目录复制模型配置：第一次启动用内置默认，之后新建这个文件并重载就能生效。

- 示例见仓库根目录的 [`llm.toml.example`](../../llm.toml.example)。每个模型用途对应一个服务商和一个模型。
- 内置默认的 `story` 用途指向 `deepseek-v4-flash`。在 `keys.env` 里填好 `DEEPSEEK_API_KEY` 就能运行。

**设置界面。** 模型部分分成“用途分配”“服务商与模型”“生成参数”三页。

- “服务商与模型”是一个服务商列表加详情。一个服务商只配置一次 API 地址、协议、密钥和价格倍率，可以批量添加多个模型 ID。
- 带 `/` 的模型 ID（例如 `openai/gpt-5.6-sol`）按原样发送。
- 然后在“用途分配”里分别选服务商和模型，不需要创建自定义预设。
- 价格倍率默认 `1`。调试页的成本面板用模型参考价乘以这个倍率估算金额。

界面里的模型设置只保存在 `llm.providers`。启动和读取都不会迁移或退回到 `llm.customPresets`。受影响的模型配置和密钥需要在当前的服务商界面里重新建立；旧条目不会自动删除。

**热重载。** 改完 `llm.toml` 不用重启应用。到 **设置 → 模型 → 用途分配** 点“重载配置”：后端重读文件并应用到运行中的模型网关（`POST /api/llm-config/reload`），新增或删除的用途立即生效。桌面版的这个接口受一次性 bearer token 保护（和其他写接口一样），界面会自动带上；开发和网页部署没有 token 时它是开放的。

**解析失败看得见。** `llm.toml` 有语法错误时（例如某个 key 写了 `=` 却没有值）：

- 首次启动：使用内置默认。
- 手动重载：**保留上一份有效配置**，不会悄悄换掉正在用的模型。
- 两种情况下 `GET /api/llm-config` 都带 `error` 字段，设置页的模型部分顶部显示红色提示和具体错误。改好后点“重载配置”即可恢复。

### 给单个世界或会话调整插件 runtime 模型

“用途分配”决定每个用途（slot）在这台设备上实际使用的服务商和模型，例如把 `plugin` 指向 `ali-coding-plan / qwen3.8-flash`。插件的清单只声明默认用途（如 `model: plugin`），不会把 `deepseek-v4-flash` 这样的具体模型写死到世界里。

开始会话前的配置页里，插件列表中的每个 agent runtime 都可以再选一个用途：

- 选“插件默认用途：`plugin`”表示不覆盖，实际模型跟随设置页里 `plugin` 当前的配置。
- 选 `story`、`fast` 等其他用途，会把 `runtimeId → slot` 保存到新会话的 `runtimeModelOverrides`。它只影响这一局，不修改世界包或全局设置。
- 多 runtime 插件逐项显示完整的 runtime ID（例如 `char-creator/character-tracker`），每项可以单独选。
- 进入游戏后，可以在左侧的插件列表里继续修改。服务端通过 `PATCH /api/sessions/:id` 保存，从下一次执行开始生效。

下拉项和默认摘要同时显示用途、服务商和**当前有效的模型**。`default: plugin` 是路由声明，旁边的 `ali-coding-plan · qwen3.8-flash` 才是这台设备实际会调用的目标，两者不冲突。以后在设置页把 `plugin` 改到另一个模型，仍然跟随 `plugin` 的 runtime 会自动跟着变，不用逐个世界重配。

`runtimeModelOverrides` 只适用于 agent runtime。图像、语音等 function runtime 通常通过插件设置 `modelPresetId` 选择媒体用的 `[covel.<slot>]`。它在同一个配置页里单独显示为“服务商用途”，保存在这台设备的插件设置里，不在会话的 runtime 覆盖里。

**就地改“服务商用途”。** 有些插件（如图像生成）用 `modelPresetId` 指定要用哪个 `[covel.<slot>]`（如 `openai-image`）。如果你没配这个用途，但配了另一个同类的（如 `gpt-image`），可以在开始会话前的配置页里，在这个插件那一行的“服务商用途”下拉里直接选你已有的。不用去插件设置里改，也不用照搬插件默认的用途名。选中后“缺少”提示消失，这个值会随回合传给该插件的 function runtime。

## 前端入口

**设置 → 桌面** 列出所有路径和代理选项，可以一键打开目录、切换 `data_root`。不想改文件就在这里操作。

**切换 `data_root`。** 桌面版里选好目录后，按新旧两个位置的情况处理：

- 当前目录有数据、新目录没有：弹窗问“复制我的数据”还是“从空目录开始”。
- 新目录里已经有 `covel.db` 或用户世界：直接使用，不复制，不覆盖。
- 选“复制我的数据”时，此刻只在配置根目录写一份 `data-root-copy.json`，`data_root` 不变。下次启动时，主进程在启动后端之前复制 `covel.db`、`covel.db-wal`、`covel.db-shm` 和 `worlds/`（不复制 `logs/` 和 `server.port`），成功后才改写 `data_root`。
- 复制只尝试一次。失败、被中断，或者还有别的 Covel 进程开着数据库时，删除这次复制写下的文件，`data_root` 保持不变，并弹窗说明原因。
- 旧目录只读不改：不移动，不删除。

在浏览器里通过 REST 切换（`PUT /api/config/data-root`）只改写 `data_root`，从不复制。

**打开和编辑 `llm.toml`：**

- “打开 llm.toml”使用当前生效的 `COVEL_LLM_TOML` 路径，没设置时才用配置根目录的 `llm.toml`。`keys.env` 始终在配置根目录。
- `llm.toml` 不存在时，应用用内置默认运行：DeepSeek 的 `story` 用途；设置了 `DEFAULT_BASE_URL` 时改指那个端点，见[模型用途](./slots.md)。
- 第一次点“编辑 llm.toml”时，应用按这份内置默认生成文件再打开。生效的模型不变。
- 其他要打开的目标不存在时返回 `open_target_unavailable`。

**设置 → 模型 → 服务商与模型** 里的标记：

- 来自文件的模型标为“来自 llm.toml”；文件不存在时标为“内置默认”。这两类只能通过编辑文件移除。
- 在界面里添加的服务商保存在 `settings.json`，可以直接删除。

源码开发时根目录 `llm.toml` 的优先级、用户资源目录和 Docker 挂载和桌面版不同，见[环境变量说明](./env-registry.md#加载路径与环境差异)。

**窗口状态。** 保存在配置根目录的 `window-state.json`。启动时会检查尺寸、坐标和布尔状态；记录损坏或无效时用默认窗口。已经断开的显示器上的坐标会被忽略，合法的负坐标仍然可以把窗口恢复到副屏。

**版本号。** 框架版本来自应用包。页面、桌面桥接和服务端 health 不各自维护写死的版本号。

## 启动与恢复

- 应用启动时先取得单实例锁。重复打开只会聚焦已有的窗口。
- 后端开始监听后，通过私有 IPC 通知主进程，窗口立即加载。桌面主进程断开时，后端会收尾并退出。
- `server.port` 保存上次成功使用的端口，下次在它空闲时复用；被占用时换另一个空闲端口。
- 页面使用 Electron 默认的持久化 session。页面的源包含端口，所以旧端口留下的存储（媒体缓存、面板布局）不会再被读到：启动时应用清除所有旧的本机页面源的存储，发现过旧的源时一并清空 HTTP 缓存。
- 安装插件或世界包后，按提示点“立即重启”。主进程等新后端就绪，再带着当前页面的路径和查询参数重新加载。后端崩溃、重启和恢复的状态会在应用内提示。
- 重启后会话数据保留。社区插件的授权只存在进程内，可能需要重新批准。
- 系统菜单的“导入插件”和“导入世界”打开 **设置 → 安装与管理**，在那里选择 ZIP、预览、授权和查看结果。

## 桌面 REST 写接口的 token 门

桌面程序每次启动时生成一个一次性的 bearer token，通过 `COVEL_DESKTOP_REST_TOKEN` 传给后端。

| 接口                                                                                                                                               | 要不要 token                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `PUT /api/config/keys`、`PUT /api/config/settings`、`PUT /api/config/proxy`、`PUT /api/config/data-root`、`POST /api/config/open-folder`（写接口） | 要                               |
| `GET /api/config/settings`、`GET /api/config/proxy`、`GET /api/app-update/latest`（返回本地配置，或者代你向外发请求）                              | 要                               |
| `GET /api/config/info`                                                                                                                             | 不要                             |
| `GET /api/config/keys`                                                                                                                             | 要。只返回服务商列表，不含密钥值 |

需要 token 的接口检查请求头 `Authorization: Bearer <token>`，缺失或不匹配返回 `401`。

- `GET /api/config/info` 的响应带 `requiresAuth` 字段，前端据此决定要不要带 Authorization 头。
- Electron 的页面通过 `covel:get-info` IPC 拿到 `restToken`，自动加到所有写请求上。
- 开发模式下没设置这个变量时，token 门不启用。纯网页部署和 `pnpm dev:web` 的流程不受影响。

**密钥在界面里怎样表示。** 界面从 `GET /api/config/keys` 拿到服务商列表后，只在内存里把这些服务商标记为“服务端已有密钥”。这个标记不是密钥明文，也不会进入 `X-Provider-Keys` 请求头。保存时：

- 没编辑过的服务端密钥保持不变。
- 新输入的密钥变成一次 PUT 里的增量修改。
- 从界面里移除的服务商变成显式删除。

所以服务商列表不会被误当成密钥表，编辑一个密钥也不会覆盖其他密钥。

**`keys.env` 读不了时。** GET 返回 `500 keys_file_unreadable`，PUT 返回 `409 keys_file_unreadable`，原文件保留。写入同样是同目录临时文件加改名替换。

**`settings.json` 的格式和冲突处理。**

- 写入用同目录临时文件加改名替换。当前格式是 `schemaVersion: 2`，带一个只增不减的 `revision`。
- 这个版本用不了的文件不会被转换。v1、没有版本号或损坏的 `settings.json` 在桌面版启动时被改名为 `settings.<v1|unversioned|damaged>.bak.json`，设置从默认值开始。
- 只是个别值不再被接受时，先把文件复制为 `settings.conflict.bak.json`，再去掉这些值。
- 这两种情况都在应用内提示一次，副本可以在 **设置 → 数据** 里查看。`keys.env` 不受影响。
- 单独的设置导入/导出文件仍然使用 `schemaVersion: 1`。
- 升级前请读 [v0.0.42 升级指南](../internals/upgrade-0.0.42.md)。

通过 REST 读写时的错误：

| 情况                                                 | 结果                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 文件读不了、JSON 或 `entries` 损坏、版本比应用还新   | GET 返回 `500 settings_file_invalid`，PUT 返回 `409 settings_file_invalid`，原文件保留。设置保持只读 |
| 保存时带的 `revision` 已经过期（另一个实例先保存了） | `409 settings_revision_conflict`，文件不变                                                           |

每次写入必须带上读取时拿到的 `revision`。遇到普通的 revision 冲突时，界面先加载并校验最新的内容，再逐个设置键比较：

- 双方改的是不同的键：你的修改在最新内容上重新应用并保存。
- 双方改了同一个键（整个对象或数组也算一个键）：拒绝覆盖，提示你核对最新的值后重试。

普通设置在浏览器 storage 事件、窗口重新获得焦点或页面恢复可见时同步。这些同步不读也不写 API 密钥。详见 [SettingsStore 契约](./settings-store.md)。

## 相关文档

- [安装](../start/install.md)：下载和首次启动
- [数据、备份与升级](../start/data-and-upgrade.md)：玩家需要知道的部分
- [桌面版打包](../internals/desktop-packaging.md)：本地构建、签名、公证
- [API 参考](./api.md)

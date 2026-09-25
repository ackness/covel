# 插件目录与安装

官方目录：[covel-ai/covel-plugins](https://github.com/covel-ai/covel-plugins)。目录采用每个插件一个 JSON 条目的结构，README 表格由条目生成。第三方源码保留在作者仓库；官方扩展和示例可在目录仓库的独立子目录维护。

## 分类与信任

核心插件随 Covel 内置；官方扩展和社区插件按需安装。维护者标签和功能分类只用于展示，不参与权限判定。现有 `pluginType` 表达插件角色，`source: builtin | community` 由发现目录决定。外部安装的官方插件也属于 `community`，不自动启用、不跳过会话代码授权。

服务端 JavaScript 不是进程沙箱。公共 API 的权限检查无法完整限制任意第三方 JavaScript 对进程文件、环境变量和网络的访问。目录收录、源码摘要和静态清单检查均不等于安全审计。

## 用户流程

打开 **设置 → 插件 → 安装与管理**：

1. 浏览社区目录，或粘贴公开 GitHub 仓库 / `/tree/<ref>/<path>` 链接。
2. 解析插件；包含多个包的仓库会显示选择框。
3. 核对插件 ID、版本、来源、commit 和代码风险，确认信任后安装。
4. 重启后端，再在会话中启用插件并按现有审批流程允许执行。

安装写入当前连接的后端，而非固定写入浏览器所在机器。桌面实例写入本机；远程部署写入服务器。安装、预览、安装记录查询和卸载复用安装 API 权限门控，demo/commercial 部署必须使用运营者令牌。生产自托管实例仍需桌面令牌或 `COVEL_INSTALL_API_ENABLED=1`。

本地 ZIP 导入保持可用，界面要求先确认代码风险。GitHub 安装记录和磁盘目录独立于启动时的 registry，因此新安装、失败插件和待卸载插件在重启前仍可管理。安装和卸载都需要重启；不提供热更新或后台自动更新；普通安装不覆盖同 ID 目录，更新走独立确认流程。

## GitHub 输入与发布物

支持仓库根链接、tag/commit/branch 的 tree 链接和插件子目录链接。普通仓库链接通过 GitHub API 解析默认分支的当前 commit；tree 链接解析指定 ref。含 `/` 的 ref 需要在对应 URL 段写为 `%2F`，或改用 commit SHA。仓库转移产生重定向时，需粘贴新的规范地址。

多插件仓库会递归发现所选目录中的插件包，例如 `plugins/` 和 `examples/`，忽略隐藏目录与 `node_modules`。粘贴 `https://github.com/covel-ai/covel-plugins` 可列出全部可安装包；`https://github.com/covel-ai/covel-plugins/tree/main/plugins` 仅列出功能插件；继续指定 `plugins/mimo-tts` 则直接预览该插件。若所选目录本身就是插件包，按一个完整包处理，其 `runtimes/` 不拆分安装。一次最多预览 20 个插件，超出时应指定更具体的目录。

设置页显示插件 ID 与仓库内路径，逐个选择、审阅风险并安装。成功后仅移除已安装项，保留其余预览，每个插件都需要重新确认风险；失败保留列表供重试或选择其他插件，已安装的包不回滚。每次安装重新下载同一固定 commit 的归档，但只提取所选插件目录，不复制其他插件或仓库根工具。预览过期需要重新预览。全部所需插件安装后可统一重启后端。

GitHub API 解析和归档下载统一使用现有 outbound 网络层，实时遵循设置中的直连、系统代理、HTTP(S) 或 SOCKS5 配置，不另建代理设置。明确指定 HTTP/SOCKS 代理失败会报错，不静默直连；系统代理按系统解析的路由顺序工作，包括系统明确返回的 DIRECT。

只下载公开 GitHub 源码归档，不使用用户 GitHub 凭证。首期不自动下载 Release 附件，不接受任意 URL、私有仓库或 GitHub Enterprise。已构建的 Release ZIP 可手动下载后导入。

插件包目录必须有 `package.json` 和根 `PLUGIN.md`，或 `runtimes/<sub>/PLUGIN.md`。使用规范插件 ID，不能覆盖内置 ID。清单及语言变体只接受普通 YAML frontmatter，拒绝可执行语言标记。安装器不会执行脚本、包管理器、编译器或插件模块；GitHub 安装要求运行文件自包含，package.json 不声明 dependencies、optionalDependencies、peerDependencies，开发依赖不受此限制。需要构建时，作者应在独立发布目录提供已构建、自包含的文件。

GitHub 源码归档带的一层外目录会被移除，再提取指定插件目录。普通上传 ZIP 仍要求包文件位于 ZIP 顶层。归档限制复用安装器：压缩文件 20 MiB、最多 2000 条目、解压 200 MiB、膨胀比最多 100。这些限制应用于整个 GitHub 归档；大型 monorepo 应使用精简发布仓库或本地 ZIP。拒绝符号链接、路径逃逸和大小写冲突的重复文件路径。

## HTTP 契约

请求与响应 Zod schema 位于 `@covel/shared` 的 `plugin-install` 导出。

| 接口                                      | 请求                          | 响应                                                           |
| ----------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| `POST /api/install/plugin/github/preview` | `{ url }`                     | `{ items: GithubPluginPreview[] }`                             |
| `POST /api/install/plugin/github`         | `{ token, acceptRisk: true }` | `{ ok: true, kind: "plugin", id, restartRequired: true }`，201 |
| `GET /api/install/plugins`                | 无                            | `{ items: [{ id, version, source, pendingUpdate }] }`          |
| `POST /api/install/plugin`                | multipart `file`              | 保持现有 ZIP 安装响应                                          |

预览包含 ID、包版本、描述、代码存在提示、来源、签名 token 和 `expiresAt`。来源为 `{ repository, commit, path, digest, tracking }`。`tracking` 为 `{ kind: "default-branch" }`、`{ kind: "branch", ref }` 或 `{ kind: "pinned", ref }`。仓库根链接跟踪默认分支，tree 链接先解析明确的分支；其余 tag/commit 保持锁定。`hasServerCode` 是保守的文件和清单扫描提示，不是完整代码审计；测试或构建源码也可能触发代码提示。适配版本仍由作者在目录与 README 声明，当前仅验证清单格式，不自动判断所有运行时兼容性。

预览不写入插件目录。签名覆盖源仓库、commit、子目录、文件摘要与预览信息，15 分钟有效，进程重启后失效。安装只使用签名内容，重新下载固定 commit，并对按路径排序、包含文件名及长度的文件内容摘要进行比对；不依赖 GitHub ZIP 字节级稳定性。摘要变化或过期返回 409，需重新预览确认。下载只访问固定 GitHub API 和 codeload 地址，拒绝重定向，不转发运营者或浏览器凭证，并限制流式读取字节数及单请求 30 秒超时。

确认安装后才通过现有临时目录与 rename 流程落盘，附加 `.covel-install.json` 记录来源、版本和安装时间。该文件只用于展示和追溯，不授予信任；插件包不能自带该文件。旧 ZIP 或手工安装的插件没有来源记录时返回 `source: null`。取消预览不会写入插件目录；确认安装后不提供取消提交操作。

错误包括无效输入/清单 400、权限 401/403、仓库或 ref 不存在 404、过期/冲突/内容变化 409、超限 413、GitHub 限流 429 和上游响应失败 502。网络传输异常沿用安装错误响应。

## 检查与更新

设置中的已安装插件各自提供“检查更新”。检查是用户主动触发的，不定时轮询、不自动下载替换。分支安装跟踪保存的分支，根仓库安装跟踪当前默认分支；tag/commit 安装保持锁定。可以展开“选择其他版本”，粘贴同仓库、同插件目录的版本链接；不允许借更新切换来源或插件身份。带 `/` 的 tag 需要 `%2F` 编码，例如 `/tree/mimo-tts%2Fv0.0.40/plugins/mimo-tts`。暂不自动枚举发布版本。

| 接口                                             | 请求                          | 响应                                                                                  |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------- |
| `POST /api/install/plugin/github/update/preview` | `{ id, url? }`                | `{ status: "current" }`、`{ status: "pinned" }` 或 `{ status: "available", preview }` |
| `POST /api/install/plugin/github/update`         | `{ token, acceptRisk: true }` | `{ ok: true, kind: "plugin", id, restartRequired: true }`，201                        |
| `DELETE /api/install/plugin/github/update/:id`   | 无                            | `{ ok: true }`，取消尚未应用的更新                                                    |

更新预览沿用安装预览字段，增加 `previous: { version, source }` 和 `changes: { added, modified, removed }` 文件列表。UI 展示当前与目标版本、精确 commit、包内文件变化，以及 GitHub 整仓提交对比链接。只有所选插件目录的内容摘要变化才提示更新；同仓库其他插件或根 README 的提交不会造成误报。版本号不递增但内容变化仍提示，由使用者核对后确认。

签名区分安装和更新用途，并绑定当前安装记录、目标内容及 15 分钟有效期。确认更新时重新下载固定 commit，核对内容摘要、身份、清单和内置 ID 限制，重新核对本地安装记录与文件内容。下载与检查沿用现有代理、公开 GitHub 地址约束和归档上限。同一插件的安装、暂存、取消和卸载操作互斥；重复提交待安装更新返回 409。

确认后，将包和替换计划原子写入用户插件目录的 `.covel-updates/<id>/`，不覆盖运行中的文件。`GET /api/install/plugins` 的 `pendingUpdate` 为 `{ version, source, error }` 或 `null`；此时当前 `version` 仍是旧包版本。可以取消暂存更新；卸载也清理其暂存更新。旧 ZIP、手工安装或缺少有效来源记录的包不提供自动检查。

下次后端启动，在社区插件发现及代码加载前重新检查旧包、暂存包及摘要，先将旧包移入事务备份，再提升新包。提升失败恢复旧包，并在安装列表显示错误；正常完成后删除事务备份。中断启动会根据备份和目标内容恢复或完成事务，不能确定状态时停止启动并保留文件供恢复。此流程处理文件替换失败，不自动回滚插件运行后的逻辑错误或数据变更。

设置、会话、plugin-data 和 MediaStore 不属于插件包，更新不删除或修改这些持久化数据；数据格式是否兼容仍由插件作者负责。包目录中任何本地文件增删或修改、符号链接都会阻止替换；应先备份并解决这些改动。旧进程始终使用旧文件，新进程的社区执行授权重新建立，因此更新确认不会继承旧进程的执行授权。部署应由单个后端进程管理其插件安装目录。

开发期安装记录契约已增加必需的 `tracking` 字段。旧开发记录不自动推断更新来源，也不迁移；需先备份本地源码改动，再卸载并从明确来源重装以建立新记录。独立存储的会话数据不随卸载删除。

## 维护范围

Jev 推荐 Demo、DashScope / OpenAI 生图与 MiMo TTS 已迁入 [官方社区仓库](https://github.com/covel-ai/covel-plugins)，主仓不再内置分发。插件 ID、runtime ID 与设置键保持不变。升级主仓后，已有会话需要先从目录安装对应插件、重启后端并重新授权服务端代码；旧内置信任不会自动继承。已有存档、插件数据、模型配置与媒体不主动删除，不需要数据库结构迁移。

当前不提供网页市场、后台自动升级、插件隔离执行或按目录标签提升权限。

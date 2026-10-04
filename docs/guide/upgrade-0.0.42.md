# 从 v0.0.41 升级到 v0.0.42

> [English version](./upgrade-0.0.42.en.md)

v0.0.42 更换了开发期的插件、世界数据和持久化契约。**它不会自动转换 v0.0.41 的数据库、会话、快照或浏览器 checkpoint。** 升级时保留旧版本和完整数据备份，在隔离的新数据存储中启动 v0.0.42，再创建新会话。只创建新会话不能修复旧数据库结构。本文面向使用 v0.0.41 的用户、部署者和外部插件/世界作者；具体字段以链接的当前参考文档为准。

## 先保存旧环境

1. 记录旧应用版本、实际存储后端、数据库和媒体位置、浏览器 origin/资料目录，以及用户安装的插件和世界。停止所有连接到旧数据库的 server、desktop 和后台 worker，确认写入已经停止。
2. 备份旧应用或安装包、配置与设置、用户插件和世界。桌面版还应备份配置根目录（默认 `~/.covel/`）及实际 `<data_root>`；`<data_root>` 可能由 `config.toml` 的 `[paths].data_root` 重定向。`keys.env`、环境文件和浏览器密钥可能含凭证，只存放在受限位置，勿贴入工单或日志。
3. SQLite 应连同数据库文件及存在的同名前缀 `-wal`、`-shm` 一起备份，不能只复制主文件，也不要在仍有进程打开数据库时单独移动伴随文件。源码 server 的实际路径以 `SQLITE_PATH` 为准；默认开发路径见[环境变量指南](env-registry.md#plugin-extension-development-data)。桌面默认数据库为 `<data_root>/covel.db`。
4. 把媒体字节也纳入备份：SQLite/local-fs 的媒体文件根目录可能由 `MEDIA_ROOT` 配置；PostgreSQL 媒体可能在数据库内；浏览器本地媒体在 IndexedDB。按当前部署实际后端确认，不能只备份数据库中的媒体元数据。PostgreSQL 使用数据库管理员认可的一致性备份，并备份应用数据卷和外部媒体存储。Docker Compose 的 `appdata` 与 `pgdata18` 卷都需要考虑；`pnpm docker:down-all` 会删除卷数据。

备份后先验证文件可读取、数据库备份可恢复，并保留原始备份。本文不要求清空全部设置：普通设置持久化只接受当前 `schemaVersion: 2`，无版本或 v1 开发数据会被拒绝且原内容保留，应在备份后重建受影响的设置（之后的版本会把 v1 数据自动改名备份并从默认值开始，见 [SettingsStore 契约](../reference/settings-store.md)）。密钥通过独立通道管理，升级前确认能够安全重新配置，避免把密钥写入普通设置导出。

## 使用新数据启动

| 环境                       | v0.0.42 操作                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面版                     | 先退出旧应用并备份上述目录。安装新应用后，在首次使用旧数据库前，让 `[paths].data_root` 指向一个**尚未包含旧数据库**的新目录，再启动；保留原 `<data_root>` 供回退。配置根目录仍保存 `config.toml`、`settings.json`、`llm.toml`、`keys.env` 和 `plugins/`，检查其中旧设置及插件。目录规则见[桌面配置](desktop-config.md)。                                                                                                                            |
| 源码 / 普通 server，SQLite | 停止旧进程、备份数据库/WAL/SHM 和媒体后，把 `SQLITE_PATH` 指向一个尚不存在的新数据库文件，再启动当前 server 让它创建当前 schema。确认 `STORE_BACKEND` 和 `MEDIA_ROOT` 等实际值；若沿用旧媒体根目录，先核对备份及引用，避免误清理共享内容。                                                                                                                                                                                                          |
| PostgreSQL / Docker        | 用**新建的空数据库**或经过单独设计、审核并在备份副本验证的 SQL 迁移部署当前 schema；不要将生成的初始建表 SQL 当作旧库升级脚本。保留旧数据库、卷及外部媒体备份。Compose 的 `DATABASE_URL` 和卷映射须一起核对；启动前确认应用连接的是新目标。见[数据库维护](env-registry.md#数据库维护命令)与[存储事务](../reference/transactions.md#schema-migrations)。                                                                                             |
| 浏览器本地模式             | 会话和世界的权威数据在该 origin 的 `covel-browser-vault` IndexedDB，媒体/缓存及部分应用数据在 `covel-browser-cache`；普通设置在 localStorage，密钥另存。保存旧浏览器资料及站点数据备份，在**独立的浏览器资料或 origin** 上使用新版本并建立新会话。不要把旧 checkpoint 直接导入当前存储，也不要把“清除站点数据”当作备份。远端模式仍需按 server 后端处理。见[存储架构](../architecture/storage.md)与[SettingsStore](../reference/settings-store.md)。 |

旧 SQLite 的 `lorebook_entries` 使用 `plugin_id`，当前 schema 要求 `owner`。`CREATE TABLE IF NOT EXISTS` 不会修改旧表，创建新索引时可能出现 `no such column: owner`；新会话、删除会话或重置浏览器 checkpoint 都不能修复该表。其他旧后端 schema 也不保证可直接启动。**不要将旧会话、记忆、执行结果、导出、排队作业或快照视为当前格式。** 在新存储中重新导入已更新的世界包、重建会话与快照；旧 checkpoint 不可作为兼容恢复点。保留旧备份供查看或后续专门迁移。[开发数据说明](env-registry.md#plugin-extension-development-data)记录了已知边界。

用户安装的外部插件和世界不会因为更新应用源码或安装包而自动改写。先备份安装目录，再升级或重新安装**通过 v0.0.42 loader 校验**的版本；旧包可能被发现流程跳过。只重建数据库仍会留下不兼容的插件/世界文件。当前插件在[插件安装](../reference/plugin-installation.md)所述目录发现；桌面版插件默认在配置根 `plugins/`，用户世界默认在 `<data_root>/worlds/`。

## 插件与世界作者修改清单

| 旧写法或假设                                                                                                       | 当前契约与动作                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平铺清单，多个子 `PLUGIN.md`；加载器把插件与 runtime 视为同一对象                                                  | 根 `PLUGIN.md` 声明包身份、`provides/requires/optional/conflicts`、schema 和 `contributes`；多个 runtime 使用 `runtimes/<id>/RUNTIME.md`。单 runtime 可用根 `runtime`；无 runtime 的包也合法。`loadPluginDefinition()` 返回 `packageManifest` 和 `manifests`，UI 使用 `loadPluginUi()`，不要读旧的 `definition.plugin`/主 `manifest` 镜像。包 entry/UI/事件/扩展只注册一次。见[插件契约](../reference/plugins.md#包与运行时文件)。                                  |
| 跨包依赖写具体 runtime ID 或只写裸 `provides` 期待满足内核扩展点                                                   | 跨包输入和 `needs` 使用版本化 contract，并在根 `requires` 或 `optional` 声明；包内 runtime ID 仍可使用。扩展点在根 `contributes.extensions` 声明并由 entry 注册；内核点依赖按实际实现解析。见[插件契约](../reference/plugins.md#runtime-分组字段)和[扩展点](../reference/extension-points.md)。                                                                                                                                                                     |
| Function 返回的 `value.events`、`value.pluginData`、`value.interactions`、`value.preGameDone` 被当成效果或完成信号 | `value` 是原样业务值，可以是对象、数组、标量或 `null`；显式写入 `HandlerResult.effects`，完成状态写入 `completion`。内部 `RuntimeResult.output`、`effects`、`completion` 分离；hook 改 function `output` 时还须同步 `canonicalValue`。输入绑定、schema 与 `recordAs` 使用同一业务值。见[输入和输出](../reference/plugins.md#输入和输出)。                                                                                                                           |
| 扩展 handler 读取快照式跨插件 `pluginData`、任意注册扩展点                                                         | 已知扩展点用 typed `provideExtension(point, id, handler)`；宿主的执行 scope 以 `readPluginData(pluginId, namespace)` 按 namespace 延迟读取，provider handler 用绑定自身的 `ctx.pluginData.get/list`。跨插件用公开服务/契约。检查 schema、顺序、超时和失败策略。见[扩展点](../reference/extension-points.md)与[插件通信](../reference/plugin-extensions.md)。                                                                                                        |
| 插件私有角色镜像、旧 Lorebook 身份、旧文本型 `lastPlayerInput`                                                     | 角色 schema/记录归内核 World Model；Lorebook 按 world/player/plugin owner 区分。`ctx.playerMessage` 仍是文本，`ctx.session.lastPlayerInput` 是结构化提交或 `null`。后台作业需完整 `turn-digest@1`，含终态 runtime 列表；重建旧作业与快照。见[World Model](../reference/world-model.md)和[插件契约](../reference/plugins.md#输入和输出)。                                                                                                                            |
| 世界 `dimensions.time`、插件 ID 目标和旧规则 ID                                                                    | 时间放入 `world.time-definition@1` 数据源；`pluginPolicy` 使用 `requested`/`recommended`，插件数据以 `contract:<id>` 导入。WorldIR 投影规则 ID 为 `world-ir-<SHA256(statement.id)>`，源 ID 保存在 `sourceStatementId`；重新导入旧规则。见[世界时间](../reference/world-time.md)和[世界数据](../reference/world-data.md)。                                                                                                                                           |
| 密钥保存发送完整 provider 映射；生图由 tag 猜角色或只检查插件安装                                                  | `saveSecrets`、`/api/config/keys` 与桌面 `covel:keys:save` 发送原子 patch：字符串设置、`null` 删除、未列出的 provider 保持不变。浏览器 localStorage 密钥写入需要 HTTPS/localhost 上的 Web Locks。生图明确解析图像用途，`ImagesContext.isAvailable()` 必需，生成结果带实际 `target`；叙事舞台依赖 `scene-stage@1`。见[SettingsStore](../reference/settings-store.md#密钥通道边界)、[模型用途](../reference/slots.md)和[图像生成](../reference/image-generation.md)。 |

Embedding 请求现在携带预期模型身份；即使向量维度相同，更换模型也会因身份漂移而拒绝混用。有意切换模型时，应在新开发会话中重建索引，保留源消息时从源数据重新摄取。`__kernel:vector` 派生进度不随快照、分支或浏览器传输；旧 checkpoint 不能直接作为当前会话恢复点。见[向量索引与转移](../reference/transactions.md#vector-index-initialization-and-transfer)。

例如，更新一个 provider 时只提交 `{"openai":"<new-key>"}`；删除它时提交 `{"openai":null}`。不要把真实密钥写进测试、文档或普通 settings 快照。world 数据源可按[世界时间示例](../reference/world-time.md#definition)使用 `schema: contract:world.time-definition@1` 和 `to: contract:world.time-definition@1`。

插件作者可先用 `pnpm validate:plugin <path-to-plugin>` 校验包，再运行相关包测试和 `pnpm e2e:extensions` 验证安装后的第三方交互；命令参数和环境见[插件测试](plugin-testing.md)。重新检查 UI slot 的服务端投影、面板数据归属与媒体引用；生成媒体在元数据可见前必须已发布，导入失败不应清理其他会话的共享字节。见[UI 槽位](../reference/ui-panels.md#kernel-ui-slots)和[MediaStore](../reference/media-store.md)。

## 验证与回退

在隔离的新数据上，确认 `/api/health` 的实际存储/媒体后端、世界与插件发现诊断、模型用途和密钥配置；创建新世界会话，完成 setup、一个回合、重启后的读档以及相关媒体显示。插件作者再检查输出契约、effects、扩展点、后台 settle 和浏览器/桌面恢复。此处列的是升级验收步骤；先前 PR 中的本地或真实模型运行记录不是这次升级安装的验收结果。

若新版本启动或验收失败，停止新版本进程，仅以**旧应用版本配套恢复旧数据库、WAL/SHM、媒体、浏览器资料、用户包和配置**。切勿让旧版本打开新 schema，也不要用新备份覆盖唯一旧备份。需要保留旧游戏进度时继续运行旧版本，待有经过单独验证的迁移方案后再处理；当前版本不提供自动转换或双读。

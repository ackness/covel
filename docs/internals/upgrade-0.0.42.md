# 从 v0.0.41 升级到 v0.0.42

> [English version](../en/internals/upgrade-0.0.42.md)

这一页写给还在用 v0.0.41 的人：玩家、部署者，以及在仓库外写插件和世界的作者。它讲怎样安全地换到 v0.0.42，以及作者要改哪些写法。

v0.0.42 换掉了插件、世界数据和存储的格式。**它不会自动转换 v0.0.41 的数据库、会话、快照或浏览器存档。** 正确的做法是：保留旧版本和一份完整的备份，让 v0.0.42 使用一份全新的数据，然后创建新会话。只在旧数据库里创建新会话，修不好旧的数据库结构。

> [!NOTE]
> 这是 v0.0.42 的升级背景。直接升级到当前版本时，还要阅读之后各版的[破坏性变更与升级说明](../releases.md)；当前 SQL schema 和开发数据重建规则以[存储版本检查](./storage.md#capabilities-and-migrations)为准。以下旧字段用于识别旧包，不表示当前版本仍接受它们。

具体字段以文中链接的参考页为准。

## 先保存旧环境

1. **记下现状并停止写入。** 记录旧应用的版本、实际使用的存储后端、数据库和媒体文件的位置、浏览器的地址（origin）和资料目录，以及装了哪些插件和世界。停掉所有连着旧数据库的服务端、桌面应用和后台进程，确认没有写入了。
2. **备份应用和配置。** 备份旧应用或安装包、配置、设置、用户插件和世界。
   - 桌面版还要备份配置根目录（默认 `~/.covel/`）和实际的 `<data_root>`。`<data_root>` 可能被 `config.toml` 的 `[paths].data_root` 改到了别处。
   - `keys.env`、环境变量文件和浏览器里的密钥可能含有凭证。只放在受限的位置，不要贴进工单或日志。
3. **备份 SQLite。** 数据库文件要连同同名的 `-wal`、`-shm` 文件一起备份。不能只复制主文件，也不要在还有进程打开数据库时单独移动这两个伴随文件。
   - 从源码运行的服务端，实际路径以 `SQLITE_PATH` 为准；默认的开发路径见[环境变量](../reference/env-registry.md#plugin-extension-development-data)。
   - 桌面版默认是 `<data_root>/covel.db`。
4. **备份媒体文件本身。** 只备份数据库里的媒体记录是不够的。按你实际使用的后端确认文件在哪里：
   - SQLite 或本地文件系统：媒体目录可能由 `MEDIA_ROOT` 指定。
   - PostgreSQL：媒体可能就在数据库里。用数据库管理员认可的一致性备份方式，并备份应用数据卷和外部的媒体存储。
   - 浏览器本地模式：媒体在 IndexedDB 里。
   - Docker Compose：SQLite 那套的数据库和媒体都在 `appdata` 卷里；PostgreSQL 那套要同时考虑 `appdata` 和 `pgdata18` 两个卷。

> [!CAUTION]
> `pnpm docker:down-all` 和 `pnpm docker:pg:down-all` 会删除卷里的数据。

备份之后，先确认文件能读、数据库备份能恢复，并保留原始备份。

关于设置和密钥：

- 不需要清空全部设置。普通设置只接受当前的 `schemaVersion: 2`。没有版本号或 v1 的开发数据会被拒绝，原内容保留不动。备份后重建受影响的设置即可。（之后的版本会把 v1 数据自动改名备份，并从默认值开始，见 [SettingsStore 契约](../reference/settings-store.md)。）
- 密钥走单独的通道。升级前确认你能安全地重新配置它们，不要把密钥写进普通设置的导出文件。

## 使用新数据启动

按你的运行方式选一种。

### 桌面版

1. 退出旧应用，备份上面说的目录。
2. 安装新应用。在它第一次用到旧数据库之前，把 `[paths].data_root` 指向一个**还没有旧数据库**的新目录，再启动。
3. 保留原来的 `<data_root>`，以便回退。

配置根目录仍然保存 `config.toml`、`settings.json`、`llm.toml`、`keys.env` 和 `plugins/`。检查里面的旧设置和旧插件。目录规则见[桌面版配置](../reference/desktop-config.md)。

### 源码 / 普通 server，SQLite

1. 停掉旧进程，备份数据库、WAL/SHM 文件和媒体。
2. 把 `SQLITE_PATH` 指向一个还不存在的新数据库文件。
3. 启动当前的服务端，让它建出当前的表结构。

确认 `STORE_BACKEND`、`MEDIA_ROOT` 等变量的实际值。如果沿用旧的媒体目录，先核对备份和引用，免得误清理共用的内容。

### PostgreSQL / Docker

- 用一个**新建的空数据库**部署当前的表结构。Covel 不提供旧库迁移流程。
- 不要把生成的初始建表 SQL 当成旧库的升级脚本。
- 保留旧数据库、卷和外部媒体的备份。
- Compose 的 `DATABASE_URL` 和卷映射要一起核对。启动前确认应用连接的是新的目标。

见[数据库维护命令](../reference/env-registry.md#数据库维护命令)和[存储事务](../reference/transactions.md#schema-changes)。

### 浏览器本地模式

数据的位置：

| 数据                     | 位置                                            |
| ------------------------ | ----------------------------------------------- |
| 会话和世界               | 该 origin 的 `covel-browser-vault`（IndexedDB） |
| 媒体、缓存和部分应用数据 | `covel-browser-cache`（IndexedDB）              |
| 普通设置                 | localStorage                                    |
| 密钥                     | 另外保存                                        |

1. 备份旧的浏览器资料目录和站点数据。
2. 在一个**独立的浏览器资料或 origin** 上使用新版本，并建立新会话。

不要把旧存档直接导入当前存储，也不要把“清除站点数据”当成备份。远端模式仍然要按服务端的后端处理。见[存储架构](./storage.md)和 [SettingsStore](../reference/settings-store.md)。

### 旧数据不能当作当前格式

旧 SQLite 的 `lorebook_entries` 表使用 `plugin_id` 列，当前表结构要求 `owner`。当前启动检查会在建表之前以 `StoreSchemaVersionError` 拒绝不兼容的数据库，不会替旧表加列。新建或删除会话、重置浏览器存档，都修不好服务端的表结构。PostgreSQL 同样需要使用当前 schema 的数据库。

**不要把旧的会话、记忆、执行结果、导出、排队中的作业或快照当作当前格式。** 在新存储里重新导入更新过的世界包，重建会话和快照。旧存档不能作为恢复点。保留旧备份，供查看或以后专门迁移。已知的边界记在[开发数据说明](../reference/env-registry.md#plugin-extension-development-data)里。

### 用户装的插件和世界

更新应用源码或安装包，不会改写用户装的插件和世界。

1. 备份安装目录。
2. 升级或重新安装**能通过 v0.0.42 加载校验**的版本。旧包可能在发现时被跳过。

只重建数据库，不兼容的插件和世界文件还在原处。插件的发现目录见[插件安装](../reference/plugin-installation.md)。桌面版的插件默认在配置根目录的 `plugins/`，用户世界默认在 `<data_root>/worlds/`。

## 插件与世界作者修改清单

左边是 v0.0.41 的写法或假设，右边是现在的规则和你要做的事。

| 旧写法或假设                                                                                                       | 当前契约与动作                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平铺的清单，或多个子 `PLUGIN.md`；把插件和 runtime 当成同一个东西                                                  | 根 `PLUGIN.md` 声明包的身份、`provides/requires/optional/conflicts`、schema 和 `contributes`。多个 runtime 放在 `runtimes/<id>/RUNTIME.md`；只有一个时可以写在根文件的 `runtime` 里；没有 runtime 的包也合法。`loadPluginDefinition()` 返回 `packageManifest` 和 `manifests`，UI 用 `loadPluginUiSpecs()`；不要再读旧的 `definition.plugin` 或主 `manifest`。包的 entry、UI、事件和扩展只注册一次。见[插件契约](../reference/plugins.md#包与运行时文件)。                                 |
| 跨包依赖写具体的 runtime ID；或只写一个 `provides` 就指望满足内核扩展点                                            | 跨包的输入和 `needs` 使用带版本的 contract，并在根文件的 `requires` 或 `optional` 里声明。包内仍然可以用 runtime ID。扩展点在根文件的 `contributes.extensions` 里声明，由 entry 注册；内核按实际注册的实现来解析依赖。见[插件契约](../reference/plugins.md#runtime-分组字段)和[扩展点](../reference/extension-points.md)。                                                                                                                                                                |
| Function 返回的 `value.events`、`value.pluginData`、`value.interactions`、`value.preGameDone` 被当成效果或完成信号 | `value` 是原样的业务值，可以是对象、数组、标量或 `null`。写入放在 `HandlerResult.effects`，完成状态放在 `completion`。内部的 `RuntimeResult.output`、`effects`、`completion` 是分开的；hook 改 function 的 `output` 时，要同时改 `canonicalValue`。输入绑定、schema 和 `recordAs` 用的是同一个业务值。见[输入和输出](../reference/plugins.md#输入和输出)。                                                                                                                                |
| 扩展 handler 读取快照式的跨插件 `pluginData`，或注册任意扩展点                                                     | 已知的扩展点用带类型的 `provideExtension(point, id, handler)`。宿主的执行环境用 `readPluginData(pluginId, namespace)` 按 namespace 延迟读取；提供方的 handler 用绑定在自己身上的 `ctx.pluginData.get/list`。跨插件共享走公开的服务或契约。检查 schema、顺序、超时和失败策略。见[扩展点](../reference/extension-points.md)和[插件通信](../reference/plugin-extensions.md)。                                                                                                                |
| 插件私有的角色镜像、旧的 Lorebook 身份、文本型的 `lastPlayerInput`                                                 | 角色的 schema 和记录归内核的 World Model。Lorebook 条目按所有者区分：world、player 或某个 plugin。`ctx.playerMessage` 仍然是文本；`ctx.session.lastPlayerInput` 是结构化的提交，或 `null`。后台作业需要完整的 `turn-digest@1`，里面含各 runtime 的最终状态列表；旧作业和旧快照要重建。见 [World Model](../reference/world-model.md)和[插件契约](../reference/plugins.md#输入和输出)。                                                                                                     |
| 世界的 `dimensions.time`、以插件 ID 为目标的数据、旧的规则 ID                                                      | 时间放进 `world.time-definition@1` 数据源。`pluginPolicy` 使用 `requested` / `recommended`，插件数据以 `contract:<id>` 为目标导入。WorldIR 投影出的规则 ID 是 `world-ir-<SHA256(statement.id)>`，原来的 ID 保存在 `sourceStatementId`；旧规则要重新导入。见[世界时间](../reference/world-time.md)和[世界数据](../reference/world-data.md)。                                                                                                                                               |
| 保存密钥时发送完整的 provider 映射；生图靠 tag 猜角色，或只检查插件有没有装                                        | `saveSecrets`、`/api/config/keys` 和桌面版的 `covel:keys:save` 接收的是补丁：字符串表示设置，`null` 表示删除，没列出的 provider 保持不变。浏览器往 localStorage 写密钥需要 HTTPS 或 localhost 上的 Web Locks。生图要明确解析图像用途，`ImagesContext.isAvailable()` 是必需的，生成结果带实际的 `target`；叙事舞台依赖 `scene-stage@1`。见 [SettingsStore](../reference/settings-store.md#密钥通道边界)、[模型用途](../reference/slots.md)和[图像生成](../reference/image-generation.md)。 |

几个例子：

- 更新一个 provider 的密钥，只提交 `{"openai":"<new-key>"}`。删除它，提交 `{"openai":null}`。不要把真实密钥写进测试、文档或普通设置的快照。
- 世界的时间数据源可以按[世界时间示例](../reference/world-time.md#definition)写 `schema: contract:world.time-definition@1` 和 `to: contract:world.time-definition@1`。

### 向量索引

Embedding 请求现在带着预期的模型身份。换了模型，即使向量维度相同，也会因为身份不一致而被拒绝，不会混用。

- 有意换模型时，在新的开发会话里重建索引。源消息还在的话，从源数据重新摄取。
- `__kernel:vector` 的派生进度不随快照、分支或浏览器传输带走。旧存档不能直接作为当前会话的恢复点。

见[向量索引与转移](../reference/transactions.md#vector-index-initialization-and-transfer)。

### 作者怎样自查

1. 运行 `pnpm validate:plugin <path-to-plugin>` 校验包。
2. 运行相关的包测试。
3. 运行 `pnpm e2e:extensions`，验证安装后的第三方交互。

命令参数和环境见[插件测试](../plugins/testing.md)。

另外重新检查这几处：

- UI slot 的服务端投影、面板数据的归属和媒体引用。见 [UI 槽位](../reference/ui-panels.md#kernel-ui-slots)。
- 生成的媒体必须先发布，它的元数据才能可见。导入失败时不应该清理其他会话共用的媒体文件。见 [MediaStore](../reference/media-store.md)。

## 验证与回退

### 验证

在隔离的新数据上检查：

1. `/api/health` 报告的存储和媒体后端是你预期的。
2. 世界和插件的发现诊断没有问题，模型用途和密钥已经配置好。
3. 创建一个新的世界会话，完成 setup 和一个回合。
4. 重启后读档，相关的媒体能显示。

插件作者再检查输出契约、effects、扩展点、后台作业的结算，以及浏览器和桌面版的恢复。

> [!NOTE]
> 这些是升级这一次安装的验收步骤。以前拉取请求里的本地运行记录或真实模型运行记录，不能算作这次安装通过了验收。

### 回退

新版本启动失败或验收失败时：

1. 停掉新版本的进程。
2. 用**旧版本的应用**，配套恢复旧的数据库、WAL/SHM 文件、媒体、浏览器资料、用户包和配置。

> [!WARNING]
> 不要让旧版本打开新的表结构，也不要用新的备份覆盖唯一的一份旧备份。

需要保留旧的游戏进度时，继续运行旧版本，等有了单独验证过的迁移方案再处理。当前版本不提供自动转换，也不会同时读取新旧两种格式。

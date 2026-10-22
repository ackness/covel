# 环境变量 Registry

这一页列出 Covel 读取的每一个环境变量：它的默认值、作用，以及写在哪个文件里。从源码运行、用 Docker 部署或维护服务端的人需要它。只用桌面版的玩家一般不用设置任何变量，看[数据、备份与升级](../start/data-and-upgrade.md)就够了。

变量清单的唯一来源是 `packages/shared/src/env/registry.ts`。本页必须提到其中声明的每一个变量，有测试检查这一点。

代码读取环境变量时，使用 `@covel/shared` 提供的函数：

- `readRuntimeEnv()`：一次读出 server、storage、desktop 的常用配置。
- `isEnvEnabled()`：读一个默认关闭的开关。只有字符串 `1` 表示开启。
- `isEnvDefaultOn()`：读一个默认开启的开关。`0` 或 `false` 表示关闭。
- `readEnvString()` / `readEnvInt()` / `readEnvChoice()`：读单个变量。`readEnvChoiceStrict()` 在值不合法时抛错。
- `providerApiKeysFromEnv()`：找出所有 `*_API_KEY`，对应到服务商 ID。

## 分组

每个变量属于一个分组（`group`）：

| group       | 用途                                                      |
| ----------- | --------------------------------------------------------- |
| `storage`   | `STORE_BACKEND`、`DATABASE_URL`、SQLite / PostgreSQL 配置 |
| `server`    | 端口、CORS、静态资源、部署层级、限流                      |
| `desktop`   | Electron 传给后端进程的路径和桌面模式配置                 |
| `ai`        | 模型配置、服务商密钥、模型数据库、提示词根目录            |
| `feature`   | 运行期功能开关                                            |
| `web`       | Vite 开发代理和浏览器可见的变量                           |
| `test`      | Playwright、真实服务商测试、e2e 脚本、开发脚本            |
| `packaging` | Electron 签名、公证用的密钥                               |

## 状态

| status      | 含义                                   |
| ----------- | -------------------------------------- |
| `active`    | 代码已经在读，是当前生效的配置         |
| `packaging` | 打包工具读取，应用运行时一般只是透传它 |

## 文件职责

| 文件                   | 放什么                                                               |
| ---------------------- | -------------------------------------------------------------------- |
| `.env`                 | 基础设施、server、storage、功能开关、本地开发辅助配置                |
| `.env.llm`             | 服务商 API 密钥和服务商地址                                          |
| `llm.toml`             | 模型用途（slot）、服务商、模型、协议、能力；可以用 `${VAR}` 引用变量 |
| `~/.covel/keys.env`    | 桌面版保存的服务商 API 密钥                                          |
| `~/.covel/config.toml` | 桌面版的数据目录、网络代理和日志轮转参数                             |

`.env`、`.env.llm` 和 `llm.toml` 都从对应的 `*.example` 复制而来，不要提交到仓库。示例文件里只放可以公开的值。

## 加载路径与环境差异

不同的启动方式读不同的文件。

**源码开发的 server**

- 读仓库根目录的 `.env` 和 `.env.llm`。进程环境里已经有的值优先。
- 模型配置文件由 `COVEL_LLM_TOML` 指定（默认 `./llm.toml`）；没设置时固定用仓库根目录的 `llm.toml`，不会换成个人目录里的另一份。
- `llm.toml` 不存在时用内置默认。首次加载失败会报错并用内置默认；手动重载失败则保留当前有效的配置。
- 密钥的优先级：进程环境 > `.env.llm` > `.env` > `$COVEL_HOME/keys.env`。
- 界面里填的密钥随请求发送，优先于允许使用的服务端默认密钥。

**Electron 桌面版**

- 固定使用 `$COVEL_HOME/llm.toml`。`COVEL_HOME` 默认是 `~/.covel`。
- 其余文件见[桌面版配置与数据目录](./desktop-config.md)。

**Vite（网页前端）**

- 从仓库根目录读 `.env`、`.env.local` 和对应 mode 的文件。只有 `VITE_*` 会暴露给浏览器。
- 开发代理的目标主机是 `RUNTIME_HOST`（默认 `127.0.0.1`）；端口按 `RUNTIME_PORT` > `SERVER_PORT` > `3001` 取。Shell 里的值优先。
- 构建缓存把这些根环境文件和 `VITE_*` 算在内，所以改了公开配置后不会用到旧产物。
- 根 `.env` 里的 `NODE_ENV` 只对 server 起作用。`pnpm --filter @covel/web build`（以及经它构建的 `pnpm build`、`pnpm build:electron`）始终产出生产包。只有在 shell 里显式导出 `NODE_ENV=development`，才会得到开发模式的前端产物。

**`pnpm dev:pg` 的启动前检查**

- 读根 `.env`，默认按 `DATABASE_URL` 检查数据库是否能连上。
- 没有 URL 时检查 `127.0.0.1:POSTGRES_PORT`（默认 `5432`）。
- URL 里没写端口时用 PostgreSQL 默认端口 `5432`。
- `COVEL_PG_PREFLIGHT_HOST` / `COVEL_PG_PREFLIGHT_PORT` 可以直接指定检查目标；`COVEL_PG_PREFLIGHT_SKIP=1` 跳过检查。

**Docker**

- 进程环境由 Compose 注入，模型配置从宿主机只读挂载。路径和持久化规则见 [Docker Compose](#docker-compose)。

**插件译文**

- 包外的插件译文（翻译包、本机机器翻译）从 `COVEL_USER_TRANSLATIONS_DIR` 读取，未设置时用 `$COVEL_HOME/translations`。目录不存在就什么都不读。格式见 [i18n](./i18n.md)。

**用户安装的世界和插件**

- 安装和启动时的发现都使用 `COVEL_USER_WORLDS_DIR` / `COVEL_USER_PLUGINS_DIR`，未设置时用 `$COVEL_HOME/worlds` / `$COVEL_HOME/plugins`。桌面版使用它自己注入的目录。
- 世界安装成功后马上可以查询和使用。插件安装后需要重启服务。
- 插件目录下指向目录的软链接（例如在另一个仓库里开发的插件）按普通插件发现，读取范围限定在链接解析后的插件目录内。失效的软链接会被跳过，并记录一条警告。

**离线图片脚本**

- 使用和应用相同的 TOML 读取逻辑，支持 metadata 内联表、子表和 `${VAR}` 引用。
- 配置路径是 `COVEL_LLM_TOML`，否则是 `$COVEL_HOME/llm.toml`。
- 密钥的优先级：`COVEL_IMG_KEY` > 服务商自己的环境变量 > `$COVEL_HOME/keys.env` 里该服务商的密钥 > `OPENAI_API_KEY`（环境变量或文件）。
- 在源码里用根目录配置预览生成任务：

  ```bash
  COVEL_LLM_TOML=llm.toml pnpm exec tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm scripts/generate-scenes.mjs haruka-academy --dry-run
  ```

  真正生成时去掉 `--dry-run`，并用 `--slot` 选定配置里的一个用途。

### 个人配置与存档边界

同一项配置，用浏览器访问和用桌面版时存在不同的地方：

| 配置                     | 浏览器访问 pnpm / Docker                                             | Electron                                       |
| ------------------------ | -------------------------------------------------------------------- | ---------------------------------------------- |
| 模型默认值               | 项目里的或挂载的 `llm.toml`                                          | `$COVEL_HOME/llm.toml`                         |
| 界面里的连接、用途和参数 | 当前 origin 的 `covel:settings`                                      | `$COVEL_HOME/settings.json`，通过 IPC          |
| 界面里填的 API 密钥      | 当前 origin 的 `covel:keys`                                          | `$COVEL_HOME/keys.env`，通过 IPC               |
| 服务端默认密钥           | 环境变量；只有允许的可信 origin 才能使用                             | 同样按环境优先级；文件变更会同步到运行中的后端 |
| 服务端执行的设置         | 服务端数据库（`server_settings` 表），`self` 层级可以在设置页修改    | 同左：经本机服务端写入数据库                   |
| 游戏存档                 | memory 模式由浏览器保存 checkpoint；SQLite / pg 模式由个人实例持久化 | 个人 SQLite，或明确选择的后端                  |

几条容易弄错的规则：

- 用浏览器访问桌面版的后端时，用的是浏览器自己的设置。
- `COVEL_HOME` 只决定路径。文件管理 REST API 需要显式设置 `COVEL_DESKTOP_REST=1`（默认关闭）；Electron 会自动设置它并提供 token。
- `GET /api/provider-keys` 只回答某个服务商有没有可用的密钥，不返回密钥原值或片段。启动和重载都不会把服务端密钥复制到浏览器。
- 删除个人密钥不会删除 shell 或 `.env.llm` 里另外配置的实例默认值。重启后这些外部配置仍然有效。
- “重载配置”只重读模型 TOML，不重读 `.env` / `.env.llm`。改了这两个文件要重启。

`settings.json` / `covel:settings` 读取失败时：

- 原数据保留，设置进入只读。设置页会提示恢复步骤，不会假装保存成功。
- 当前的持久化格式是 schema v2，旧数据不自动迁移。处理旧开发数据时先备份，再移走旧设置文件或对应的浏览器键，然后重新配置。
- 不需要删除 `keys.env`、游戏数据库或整个个人目录。

> [!IMPORTANT]
> 这个仓库面向可信的个人实例和客户端。SQLite / PostgreSQL 不提供公开服务器所需的账号隔离。商业服务商、托管的自带密钥和账号存档需要另外的产品边界。

### 用户资源目录

| 入口               | 世界目录                                           | 插件目录                                             |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------- |
| 源码 / 普通 server | `COVEL_USER_WORLDS_DIR`，否则 `$COVEL_HOME/worlds` | `COVEL_USER_PLUGINS_DIR`，否则 `$COVEL_HOME/plugins` |
| Electron           | 桌面程序注入 `<data_root>/worlds`                  | 桌面程序注入 `<config_root>/plugins`                 |
| Docker Compose     | `/home/node/.covel/worlds`                         | `/home/node/.covel/plugins`                          |

- 普通 server 没设置 `COVEL_HOME` 时用 `~/.covel`。
- `COVEL_WORLDS_DIR` / `COVEL_PLUGINS_DIR` 指向**随应用自带**的世界和插件。安装的和 AI 生成的世界写入用户目录。
- 插件脚手架和 `test:runtime` 也使用用户插件目录，显式的 `--target` / `--plugins-dir` 优先。`--with-tools` 脚手架固定输出到仓库的 `plugins/`。

### Docker Compose

自托管有两套 Compose 文件，都是绑定回环地址的个人实例：

| 后端           | 文件                               | 命令                                                                                                 |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| SQLite（默认） | `docker/docker-compose.sqlite.yml` | `pnpm docker:build` / `docker:up` / `docker:down` / `docker:down-all` / `docker:logs`                |
| PostgreSQL     | `docker/docker-compose.yml`        | `pnpm docker:pg:build` / `docker:pg:up` / `docker:pg:down` / `docker:pg:down-all` / `docker:pg:logs` |

准备：

1. 复制 `.env.example` 为 `.env`，复制 `llm.toml.example` 为 `llm.toml`。
2. 在 `.env` 里设置 `COVEL_MEDIA_TOKEN_SECRET`（`openssl rand -hex 32` 生成）。生产模式下缺少它，应用签发第一个媒体地址时会报错，SQLite 那套在缺少它时拒绝启动；PostgreSQL 那套为了让 `pnpm db:up` 只起数据库而不检查它，所以要自己记得设置。
3. 用 PostgreSQL 时，取消 `.env.example` 里 PostgreSQL 一段的注释，并设置 `POSTGRES_PASSWORD`。只运行 `pnpm db:up` 时，只需要 PostgreSQL 的配置（`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`POSTGRES_PORT`）。
4. 服务端的服务商密钥可以放在可选的 `.env.llm` 里。

然后：

```bash
pnpm docker:build
pnpm docker:logs
```

用 PostgreSQL 时：

```bash
pnpm docker:pg:build
pnpm docker:pg:logs
```

两套 Compose 相同的行为：

- 使用 `DEPLOYMENT_TIER=self`。宿主机默认只绑定回环地址，同源的界面不需要 operator token 或 CORS 配置。
- 应用容器内 `SERVER_PORT` 固定为 `3001`。宿主机入口由 `APP_BIND_IP`（默认 `127.0.0.1`）和 `APP_PORT`（默认 `3001`）决定。两套用同一个默认端口，不要同时启动。
- 浏览器用 `localhost` 或 `127.0.0.1` 打开就能用。改了 `APP_BIND_IP`、要从别的机器打开时，把打开它用的名字写进 `COVEL_ALLOWED_HOSTS`。
- 内置健康检查访问容器内的 `http://127.0.0.1:3001/api/health`。
- 根 `llm.toml` 只读挂载到 `/app/llm.toml`。文件缺失时 Compose 会报错。
- `appdata` 卷挂载到 `/home/node/.covel`，保存用户世界和插件。

SQLite 那套：

- 只有一个应用容器，没有数据库服务。`STORE_BACKEND=sqlite`，`SQLITE_PATH=/home/node/.covel/data/covel.db`，`MEDIA_ROOT=/home/node/.covel/data/media`，都写在 Compose 文件里，会盖过 `.env` 里为源码运行写的同名变量。数据库和媒体因此都在 `appdata` 卷里。
- 容器镜像里没有挂卷的目录（例如 `/app/apps/server/data`）在容器重建时会丢，所以数据库不能放在那里。
- 项目名是 `covel-sqlite`，容器名是 `covel-sqlite-app`。

PostgreSQL 那套：

- 容器内的数据库地址固定为 `postgres:5432`，和宿主机的 `POSTGRES_PORT` 无关。
- `pgdata18` 卷保存数据库。

> [!CAUTION]
> `docker:down` / `docker:pg:down` 保留卷。**`docker:down-all` 会删除 SQLite 那套的 `appdata` 卷，也就是数据库和其中的所有数据；`docker:pg:down-all` 会删除 PostgreSQL 那套的两个卷和其中的数据。**

升级前，如果旧容器里已经装过世界或插件，先导出 `/home/node/.covel`，再导入新卷。新增的卷不会自动搬运旧容器可写层里的文件。

### 向量记忆

`VECTOR_BACKEND` 有三个值：

| 值         | 效果                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `embedded` | 默认。存储支持向量、并且接入了 embedding 函数时使用语义检索；失败或不可用时退回关键词检索。                                  |
| `none`     | 关闭自动锁定 embedding 模型、语义记忆摄取和向量检索。关键词记忆和已存的向量保留。它不禁止记忆系统之外的显式 embedding 请求。 |
| `external` | 需要宿主显式注入适配器。                                                                                                     |

详见 [API 配置说明](./api.md#installed-resource-storage-and-vector-configuration)。

## 数据库维护命令

SQLite 和 PostgreSQL 都在应用启动时创建当前的表结构，没有针对已有表结构的自动升级。仓库里没有受版本控制的迁移记录，所以也没有 `db:migrate` 命令：新生成的建表 SQL 不能直接应用到已有数据库。

| 命令               | 作用                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| `pnpm db:generate` | 生成 PostgreSQL 表结构快照和 SQL，供开发评审（输出到 `apps/server/drizzle/`，不入库） |
| `pnpm db:studio`   | 打开 PostgreSQL 查看工具                                                              |

两个命令都直接运行 Drizzle，读根 `.env`，shell 里的 `DATABASE_URL` 优先。

升级已有数据库需要针对旧表结构编写并审核 SQL，先在备份副本上验证，再手动应用。这两个工具不处理 SQLite 升级。

### Plugin extension development data

v0.0.42 调整了插件扩展契约，旧的开发数据不会自动升级。桌面、服务端、PostgreSQL 和浏览器各自怎样备份、换新存储、回退，见 [v0.0.42 升级指南](../internals/upgrade-0.0.42.md)（[English](../en/internals/upgrade-0.0.42.md)）。

**为什么旧 SQLite 数据库不能继续用。** 旧的 `lorebook_entries` 表用 `plugin_id` 作为列和主键的一部分，当前版本要求 `owner`。启动时的 schema 检查会以 `StoreSchemaVersionError` 拒绝打开这个旧库，并指出文件的绝对路径。只删除或新建会话、快照、浏览器 checkpoint 修不好这个表结构。

**处理旧开发环境的步骤：**

1. 停掉所有使用这个数据库的 server 和桌面进程。
2. 看 `StoreSchemaVersionError` 消息里的绝对路径，确认实际数据库。显式设置的 `SQLITE_PATH` 优先（包括仓库 `.env` 里的值）；相对路径以服务端工作目录为准，`pnpm dev` 下是 `apps/server/`。源码开发的 home bootstrap 只在 Covel 主目录已存在且 `SQLITE_PATH` 未设置时，选用 `<COVEL_HOME>/data/covel.db`（主目录默认 `~/.covel/`）。否则 registry 先取 `<COVEL_DATA_ROOT>/covel.db`（若已设置），再回退到 `./data/covel.db`，即 `apps/server/data/covel.db`。
3. 需要保留数据时，把这个数据库文件及其 `-wal`、`-shm` 文件一起备份到安全的位置。
4. 把 `SQLITE_PATH` 指向一个**还不存在**的新文件；也可以把备份后的这组文件一起移走。确认开发数据不需要保留时，可以直接删除这组文件。
5. 启动当前版本，让它创建新的表结构，再新建会话和快照。

> [!CAUTION]
> 还有进程打开数据库时，不要单独移动或删除 WAL/SHM 文件。这些步骤不要求删除真实的用户数据。

**同时检查用户目录。** 看一下用户插件目录（`COVEL_USER_PLUGINS_DIR`，默认 `$COVEL_HOME/plugins`）和用户世界目录（`COVEL_USER_WORLDS_DIR`，默认 `$COVEL_HOME/worlds`）：

- 多 runtime 插件的子清单必须叫 `RUNTIME.md`，不是旧的子 `PLUGIN.md`。
- 世界的 `pluginPolicy` 使用当前的写法：`preset`、`plus`、`pitch`、`packs`、`requires`（见[世界数据](./world-data.md#插件选择pluginpolicy)）。
- `worldData` 里指向插件数据的目标使用 `contract:<id>`。

先备份旧目录，再把包更新到能通过当前校验。旧文件不会自动转换；没核对过的用户内容不需要覆盖。

当前契约还要求同步更新以下消费者：

- 后台作业必须持久化完整的 `turn-digest@1`，包括结构化的 `lastPlayerInput` 和 `runtimeResults`。旧的作业、快照和会话需要重建，缺字段的不能恢复。`ctx.playerMessage` 仍然是文本，`ctx.session.lastPlayerInput` 现在是提交记录或 `null`。
- 插件状态读 `hostState`、`sessionState` 和独立的 `serverCodeApproved`。不要用 `loaded` 推断会话是否已授权。
- 跨包 runtime 的输入、`needs` 和 `after` 使用根清单声明过的契约。一次性 setup 的先后顺序用 `after`；不要把已完成的 setup 写成 `needs`，否则后续每次执行都要求它产生结果。
- 世界时间从 `dimensions.time` 移到 `world.time-definition@1` 数据，面板绑定和 GraphCanvas 按当前的 props 契约更新。世界生成的三种保存方式（写文件、只存储、直接返回）都带 `contractData`。

## Registry 中的其他运行变量

下面的变量也在 `registry.ts` 里。上文已经讲过用法的变量，这里只列默认值。

**服务端与存储**

<!-- prettier-ignore -->
| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NODE_ENV` | `development` | Node 运行模式（`development` / `production` / `test`） |
| `STORE_BACKEND` | `sqlite` | 服务端数据存在哪里（`memory` / `sqlite` / `pg`） |
| `SQLITE_PATH` | `./data/covel.db` | SQLite 文件路径，相对服务端工作目录（`pnpm dev` 下为 `apps/server/`）；home bootstrap 和 `COVEL_DATA_ROOT` 的选择规则见上文 |
| `DATABASE_URL` | — | PostgreSQL 连接串，`STORE_BACKEND=pg` 时必填 |
| `MEDIA_BACKEND` / `MEDIA_ROOT` | `mirror` / — | 媒体存在哪里（`mirror` / `memory` / `sqlite` / `pg` / `none`）和文件根目录。`mirror` 跟随 `STORE_BACKEND`，`none` 关闭媒体接口；`MEDIA_ROOT` 未设置时用 `SQLITE_PATH` 旁边的 media 目录 |
| `VECTOR_BACKEND` | `embedded` | 向量能力（`embedded` / `none` / `external`） |
| `POSTGRES_USER` / `POSTGRES_DB` | `covel` / `covel` | Docker Compose 里 PostgreSQL 的用户名和库名 |
| `POSTGRES_PASSWORD` | — | Docker Compose 里 PostgreSQL 的密码 |
| `POSTGRES_PORT` | `5432` | Docker Compose 的 PostgreSQL 在宿主机上的端口 |
| `SERVER_PORT` | `3001` | HTTP 服务监听的端口 |
| `APP_PORT` | `3001` | Docker Compose 的应用在宿主机上的端口 |
| `COVEL_BIND_HOST` | `127.0.0.1` | HTTP 服务监听的地址 |
| `COVEL_ALLOWED_HOSTS` | — | 除 `localhost`、`127.0.0.1`、`[::1]` 外，`self` 档位还回答哪些主机名，逗号分隔 |
| `DEPLOYMENT_TIER` | `self` | 部署层级（`self` / `demo` / `commercial`），决定鉴权的严格程度 |
| `SERVE_STATIC` / `STATIC_DIR` | `false` / `./web-dist` | 让 server 托管指定目录里的网页前端 |
| `CORS_ORIGIN` | — | 允许的 HTTP origin 列表，逗号分隔 |
| `ENABLE_DEBUG_PAGE` | `false` | 在生产环境开启调试和内部路由 |
| `RATE_LIMIT_RPM` | `60` | 每个 IP 每分钟的请求额度，只用于 `GET /api/events/stream`；其余路由的额度写在各自的路由里 |
| `TRUSTED_PROXY_IPS` | — | 可信代理的地址列表。只有来自这些地址的请求，才信任它带的转发 IP 头 |
| `COVEL_MEDIA_TOKEN_SECRET` | 生产环境必填 | 给媒体短期访问链接签名的密钥。开发环境没设置时，每次启动随机生成一个 |
| `COVEL_MEDIA_CLEANUP_ENABLED` | `false` | 开启 `POST /api/media/cleanup` |
| `COVEL_INSTALL_API_ENABLED` | `false` | 没有桌面 bearer token 时，显式开启安装、卸载插件和世界的接口 |
| `COVEL_SUSPENSION_TTL_MS` | `604800000`（7 天） | 未解决的挂起项多久后被清理 |
| `COVEL_PG_LOCK_POOL_MAX` | `16` | PostgreSQL 会话锁专用连接池的大小 |
| `COVEL_PG_INGEST_LOCK_POOL_MAX` | `4` | 语义记忆摄取专用的 PostgreSQL 锁连接池的大小 |
| `COVEL_LOG_QUIET_PATHS` | `/api/health` | 请求日志里不记录的路径，逗号分隔 |
| `COVEL_APP_VERSION` | 对应应用的 `package.json` | 覆盖桌面 preload 和服务端 health 里的框架版本 |

**桌面与路径**

<!-- prettier-ignore -->
| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `COVEL_HOME` | `~/.covel` | 个人配置根目录，`keys.env` 也在这里 |
| `COVEL_DATA_ROOT` | — | 桌面版存放 SQLite、世界和日志的数据根目录 |
| `COVEL_USER_CONFIG_DIR` | — | 桌面版模型数据库和设置所在的配置目录 |
| `COVEL_LLM_TOML` | `./llm.toml` | 生效的 `llm.toml` 的路径 |
| `COVEL_PLUGINS_DIR` / `COVEL_WORLDS_DIR` | — | 随应用自带的插件、世界目录 |
| `COVEL_USER_PLUGINS_DIR` / `COVEL_USER_WORLDS_DIR` | — | 用户安装的插件、世界目录 |
| `COVEL_USER_TRANSLATIONS_DIR` | — | 包外插件译文的目录 |
| `COVEL_DESKTOP_REST` | `false` | 开启桌面配置 REST 接口 |
| `COVEL_DESKTOP_REST_TOKEN` | — | 桌面配置写接口的 bearer token，也是托管层级的运维凭证 |
| `COVEL_SYSTEM_PROXY_URL` | — | 不支持动态系统代理 IPC 的宿主使用的静态系统代理 |
| `COVEL_DESKTOP_SYSTEM_PROXY_IPC` | `false` | Electron 注入的内部标记，表示后端可以逐个 URL 询问系统代理 |
| `COVEL_LOGS_DIR` | — | 桌面版日志目录（设置页显示） |
| `COVEL_LOG_MAX_SIZE_MB` / `COVEL_LOG_MAX_FILES` | `10` / `10` | 桌面版日志轮转：单个文件的上限和保留的份数 |
| `COVEL_SERVER_LOG_FILE` | — | server 把 stdout/stderr 另存到哪个文件。空字符串表示不存；未设置时用日志目录下的 `server.log` |

**模型**

| 变量                                 | 默认值                  | 用途                                                                                                                        |
| ------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_BASE_URL` / `DEFAULT_MODEL` | — / `deepseek-v4-flash` | 没有 `llm.toml` 时，内置的 `story` 用途改用这个 OpenAI 兼容端点和模型（服务商 `default`）；`e2e:replay --record` 也向它录制 |
| `DEFAULT_API_KEY`                    | —                       | `default` 服务商的密钥：上面的内置用途和 `tests/llm-replay/` 的会话都用它                                                   |
| `COVEL_LLM_RETRY_DISABLED`           | `false`                 | 设为 `1` 时关闭服务商 HTTP 重试                                                                                             |
| `COVEL_LLM_MAX_CONCURRENT`           | `4`                     | 整个进程同时进行的文本模型调用上限                                                                                          |
| `COVEL_MODEL_DB_PATH`                | —                       | 覆盖模型数据库 JSON 的路径                                                                                                  |
| `COVEL_PROMPTS_DIR`                  | —                       | 覆盖提示词模板根目录                                                                                                        |
| `COVEL_IMG_KEY`                      | —                       | 离线立绘、场景生成脚本用的密钥，优先于服务商自己的密钥                                                                      |

**功能开关**

| 变量                             | 默认值                    | 用途                                                  |
| -------------------------------- | ------------------------- | ----------------------------------------------------- |
| `COVEL_EFFECTS_POLICY`           | `warn`                    | 同一并行层里出现读写冲突时怎么办（`warn` / `strict`） |
| `COVEL_INSTRUCTION_LOCALE`       | 跟随会话语言              | 给所有会话固定指令语言（`en` / `zh`）                 |
| `COVEL_COMPACTOR_CONTEXT_WINDOW` | 按模型能力计算            | 固定压缩和提示词预算使用的上下文窗口                  |
| `COVEL_SNAPSHOT_INTERVAL_TURNS`  | `5`                       | 每隔几个玩家回合写一份自动快照                        |
| `COVEL_AUTO_SNAPSHOT_RETENTION`  | `20`                      | 每个会话保留几份自动快照                              |
| `COVEL_TRACE_RETENTION_DAYS`     | `30`                      | trace 和事件流水保留多少天                            |
| `COVEL_PLUGIN_LOG_LEVEL`         | 开发 `debug`，生产 `info` | 插件日志写入存储的最低级别                            |

这些开关的细节见 [Runtime Contract](#runtime-contract)。

**网页开发与测试**

| 变量                                                  | 默认值                          | 用途                                                       |
| ----------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| `RUNTIME_HOST` / `RUNTIME_PORT`                       | `127.0.0.1` / `3001`            | Vite 开发代理指向的 server                                 |
| `E2E_BASE_URL` / `E2E_MODEL_SLOT`                     | `http://127.0.0.1:5181` / `e2e` | Playwright 改测外部环境时的地址；插件验证脚本用的模型用途  |
| `COVEL_RANDOM_SEED`                                   | —                               | 只用于测试服务端：插件的 `ctx.random` 每次运行给出相同的数 |
| `CI`                                                  | `false`                         | CI 模式，影响 lint 和 Playwright 的行为                    |
| `LIVE_LLM_ENABLED`                                    | `false`                         | 开启调用真实服务商的测试                                   |
| `COVEL_PG_PREFLIGHT_HOST` / `COVEL_PG_PREFLIGHT_PORT` | `127.0.0.1` / `5432`            | `dev:pg` 启动前 TCP 检查的目标                             |
| `COVEL_PG_PREFLIGHT_SKIP`                             | `false`                         | 设为 `1` 跳过 `dev:pg` 的 TCP 检查                         |

**打包**

这些变量只由 Electron 打包工具或桌面打包脚本读取，详见[桌面版打包](../internals/desktop-packaging.md)。

| 变量                          | 默认值                          | 用途                         |
| ----------------------------- | ------------------------------- | ---------------------------- |
| `CSC_LINK`                    | —                               | 代码签名证书的路径或 URL     |
| `CSC_KEY_PASSWORD`            | —                               | 代码签名证书的密码           |
| `WIN_CSC_TIMESTAMP_SERVER`    | `http://timestamp.digicert.com` | Windows 签名用的时间戳服务器 |
| `APPLE_ID`                    | —                               | 公证用的 Apple 开发者账号    |
| `APPLE_APP_SPECIFIC_PASSWORD` | —                               | 公证用的 App 专用密码        |
| `APPLE_TEAM_ID`               | —                               | Apple 开发者团队 ID          |

**不在 registry 里的名字**

- `*_API_KEY` 由代码动态枚举，registry 只登记常用的例子。
- `*_BASE_URL` 只有在生效的 `llm.toml` 用 `${VAR}` 引用它时才起作用。
- `APP_BIND_IP` 只由 `docker/docker-compose.yml` 和 `docker/docker-compose.sqlite.yml` 读取。
- `COVEL_MEMORY_V1`、`COVEL_STORY_BASE_URL`、`COVEL_PLUGIN_BASE_URL`、`VITE_API_URL`、`LIVE_IMAGE_ENABLED` 没有任何代码读取，可以从本地配置里删掉。

## 迁移规则

新增或修改环境变量时遵守这几条：

1. 先在 `COVEL_ENV_REGISTRY` 里加一条定义，再在本页提到它。
2. 运行时代码用上面的函数读变量。直接读 `process.env` 只留给动态枚举的场景。
3. 新增服务商只要遵守 `${PROVIDER}_API_KEY` 的命名，不必逐个登记。
4. 新增功能开关用清楚的能力名，不要用版本号表达开发阶段。
5. 默认关闭的开关用 `isEnvEnabled()`。默认开启的开关用 `isEnvDefaultOn()`，并在 registry 里写清楚关闭它的值。
6. `.env.example` 和 `.env.llm.example` 只放可以公开的示例值。

## Runtime Contract

这一节逐个说明行为比较细的变量。

### 存储和部署

**`STORE_BACKEND`、`MEDIA_BACKEND`、`VECTOR_BACKEND`**

- `STORE_BACKEND` 的默认值是 `sqlite`。
- 这三个变量决定数据落在哪里，用 `readEnvChoiceStrict()` 读取。值不在可选范围内（例如把 `pg` 写成 `postgres`）会让服务启动失败，错误信息列出可以接受的值，不会悄悄退回默认值。
- `NODE_ENV` 这类不影响数据去向的变量仍用 `readEnvChoice()`，未知值退回默认。

**`DEPLOYMENT_TIER`**

- `self` 是本地自部署。来自 localhost 的请求可以读取 server 注入的服务商密钥的元数据。
- `demo` / `commercial` 强制要求会话 owner token。
- 即使是 `self`，当 `NODE_ENV=production` 并且实际使用的存储是 MemoryStore 时，也强制要求会话 owner token，全局世界写入还要求 operator token。这个判断看实际注入的存储，不只看 `STORE_BACKEND` 的值。
- 大小写和首尾空格不计。其他值会让服务启动失败，错误信息列出可以接受的值。
- 服务端在启动时把它和存储、令牌一起合成宿主配置，路由不再自己读它。各档位的规则见 [安全边界](../internals/security.md#host-profile)，鉴权细节见 [`api.md`](./api.md) 的鉴权章节。
- 桌面客户端启动服务端时固定传 `self`。

**`COVEL_DESKTOP_REST_TOKEN`**

- 它是运维凭证（operator token）。用它作为 Bearer token 可以通过任何会话的 owner 校验，管理工具和 e2e 脚本靠它工作。
- 在 `demo` / `commercial` 层级，下面这些操作必须带它：创建、分叉和列出会话，世界写入和维度导入、AI 世界生成、模型探测和刷新、激活社区插件的服务端代码。
- `DEPLOYMENT_TIER=demo|commercial` 启动时如果没配置它，服务端直接拒绝启动（宿主配置的启动检查）。
- `self` 层级启动不要求它。但在生产环境的 MemoryStore 下，全局世界的创建、修改、删除、维度导入和服务端生成保存都会校验它；没配置时这些写入保持关闭，公开读取和合法的会话访问仍然可用。
- 普通的本地或桌面会话不需要 token。桌面配置接口有它自己的 token 校验。
- 这是“只有一个运维方”的信任模型，不提供多租户身份或代码沙箱。见 [`api.md`](./api.md) 的鉴权章节。

**`COVEL_BIND_HOST`**

- 默认 `127.0.0.1`：本地和桌面部署只监听回环接口，网络上访问不到。
- 容器或多 pod 部署要显式设置 `COVEL_BIND_HOST=0.0.0.0`（两个 Docker Compose 文件都已经设置）。公开监听前先确认 `DEPLOYMENT_TIER` 和鉴权配置。

**`COVEL_ALLOWED_HOSTS`**

- `self` 档位只回答用 `localhost`、`127.0.0.1` 或 `[::1]` 打开的请求（端口不限），其他主机名一律 `403 host_not_allowed`。这挡住 DNS 重绑定：恶意网页把自己的域名指向本机，也没法驱动不要令牌的接口。
- 自部署的网页版要从别的机器打开时，把打开它用的名字写进来，例如 `COVEL_ALLOWED_HOSTS=covel.example.com,192.168.1.20`。写了端口也只比较主机名。
- 放在反向代理后面时，写代理转发过来的 `Host`。代理把 `Host` 改成上游名字（比如 nginx 默认的 `app:3001`）时，写那个名字。
- `demo` / `commercial` 档位使用各自的鉴权规则，不做这个检查。在这两个档位上设置它，服务端会拒绝启动，因为这个值不起作用。

**`TRUSTED_PROXY_IPS`**

- 限流中间件（`middleware/rate-limit.ts`）用它判断是否信任 `X-Forwarded-For`。
- 出站请求的 SSRF 防护默认对所有公网 `https` 主机开放，所以没有“允许的模型主机”这样的变量。

**`COVEL_PG_LOCK_POOL_MAX`**

- 默认 `16`。它是 PostgreSQL 会话锁专用连接池的上限。
- 每个进行中的回合占用一条连接。多个 pod 并发时，按峰值并发会话数调大。
- 获取锁的超时是 30 秒，包括在连接池里排队和轮询锁的全部时间。

**`COVEL_PG_INGEST_LOCK_POOL_MAX`**

- 默认 `4`。它是语义记忆摄取专用的 PostgreSQL 锁连接池。
- 读进度和哈希、调用 embedding、写向量，全程都在 `memory-ingest` 命名空间的锁里。同一个会话跨 pod 串行，不同会话仍然并行。
- 单独用一个小池，是为了不让后台的服务商请求占满玩家回合的锁连接。

**`COVEL_MEDIA_CLEANUP_ENABLED`**

- 默认 `false`，决定 `POST /api/media/cleanup` 能不能用。
- `DEPLOYMENT_TIER=commercial` 时这个接口固定返回 503，所以在这个档位上设为 `true` 会让服务端拒绝启动。
- 详见 [`api.md`](./api.md) 的媒体管理章节。

### 桌面代理

**`COVEL_DESKTOP_SYSTEM_PROXY_IPC`、`COVEL_SYSTEM_PROXY_URL`**

- 桌面版选择 `system` 代理时，后端为每个目标 URL 通过 IPC 询问 Chromium 的系统代理，并按系统返回的代理顺序依次尝试连接。
- Electron 注入内部标记 `COVEL_DESKTOP_SYSTEM_PROXY_IPC=1`，所以普通的 Node IPC 或 cluster 进程不会误用这套协议。
- `COVEL_SYSTEM_PROXY_URL` 为不支持动态 IPC 的宿主提供静态系统代理地址；Electron 按请求 URL 通过 IPC 解析代理。
- 代理用于框架自己的服务商请求、模型数据库更新、GitHub 插件解析和下载。它不作用于第三方插件的 `fetchWithRetry`。

### 模型调用

**`COVEL_LLM_MAX_CONCURRENT`**

- 整个进程同时进行的文本模型调用上限，默认 `4`。`0` 或负数关闭这个限制。由 `packages/shared/src/llm-slots.ts` 读取。
- 网关统一限制文本、对象、流式和评估调用；agent、函数、后台任务和直接调用共用队列。embedding 和媒体不占文本槽。
- agent 的排队时间补偿到 runtime 截止时间；函数保持固定的执行截止时间。逻辑请求预算都计入排队。
- 多会话的托管部署可以按服务商的吞吐调整。

**`COVEL_COMPACTOR_CONTEXT_WINDOW`**

这是一个**可选的显式覆盖**。

- 未设置时，压缩阈值和提示词的硬裁剪预算按所有已启用的文本用途里最保守的模型能力计算：取最小的 `contextWindow` 和最小的 `maxOutputTokens`。这样同一回合里 story、plugin、fast 几个用途的窗口不一样时，不会按较大的窗口放行。
- `llm.toml` 热重载后立即生效。模型能力也缺失时，退回 `262144` / `16384`。
- 请求里临时覆盖 story 用途时，会和基础预算再取较小值。
- 设置本变量后，窗口固定为这个值；给输出预留的部分仍按保守的模型能力取。

**`COVEL_INSTRUCTION_LOCALE`**

- 取 `en` / `zh`，默认不设置。
- 不设置：简体中文会话读插件的 `*.zh.md` 提示词和框架的中文指令，其他语言的会话读英文。
- `en`：所有会话都读英文。
- `zh`：所有会话优先读中文版本；没有中文版本的插件仍读英文。
- 插件代码写的指令（`pickLocaleText`、`instructionLocaleFor`、插件用 `createPromptLoader` 加载的模板）同样跟随它。
- 它只决定指令的语言，不改变会话内容的语言。用来对比两种指令语言的效果，或者给某个模型固定一种。

### 测试

**`COVEL_RANDOM_SEED`**

- 只用于测试服务端。
- 未设置时，插件的 `ctx.random.int(min, max)` 就是 `node:crypto` 的 `randomInt`。
- 设置后，同一个 runtime（或同一个 RPC action）在一个会话里取的第 n 个数，只由种子、插件 ID、runtime ID 和 n 决定。所以同一个脚本会话每次运行掷出的骰子相同。
- 计数保存在进程内。同一个会话 ID 再次创建时从头开始计数。
- 模型请求的录制和回放由外部代理 `pnpm llm:replay` 完成。服务端进程内没有回放缓存，也没有对应的环境变量。
- 配合 `e2e:verify --session-id` 和 `pnpm llm:replay` 的用法见[真实模型验证](../ship/real-model.md)。

> [!WARNING]
> 种子让骰子可以预测。不要在给玩家用的部署里设置它。

### 快照、trace 和清理

**`COVEL_SNAPSHOT_INTERVAL_TURNS`**

- 默认 `5`，控制自动快照（`kind=auto`）多久写一次。
- `completedPlayerTurns <= 1` 时总是写；之后每 N 个已完成的玩家回合写一份。`1` 表示每回合都写。
- 恢复挂起（resume）时不受这个间隔限制，强制写入。
- 每个 `completedPlayerTurns` 值只有一份自动快照，ID 是 `auto-<计数>-<sessionId>`。同一计数下后续的后台提交或恢复提交会原地刷新它，所以检查点包含该回合的后台结果，而不会多存一份。
- 不每回合都写的原因：构建快照要读出全部消息历史和会话的全部数据，每回合都写的话成本随回合数平方增长，存储也会膨胀。

**`COVEL_AUTO_SNAPSHOT_RETENTION`**

- 默认 `20`：每个会话保留的自动快照数。`0` 或负数保留全部。
- 每次写入检查点后，删除更早的 `kind=auto` 快照。被分叉作为 `parentId` 引用的快照不删。手动快照和分叉快照不受影响。
- 快照内容不包含框架自己的控制数据（命名空间 `_jobs`、`_runtime_jobs`、`_runtime_job_control`、`_logs`）。

**`COVEL_TRACE_RETENTION_DAYS`**

默认 `30`，`0` 保留全部。

清理什么、什么时候清理：

- 设为 N 时，每次执行提交后，删除这个会话 N 天前的 runtime trace 事件，以及同一期限之前的事件流水。事件流水是 `events` 表：事件总线发布的每个事件的副本，没有代码回读它。
- 服务启动时，以及之后最多每天一次（在某次提交之后顺带触发），对所有会话做同样的清理。所以没人再玩的会话也会被清到。
- 清理失败只记录警告，不影响提交或请求。

不会被清理的：

- 每个会话最新一个回合的 trace。执行状态和失败回合的重试入口是从它的 `turn.started` / `turn.completed` / `turn.failed` 记录读出来的；隔了保留期再回到会话，重试仍然在。
- 故事、消息和存档。trace 只是诊断数据；调试页面只能看到保留期内的记录。

谁说了算：

1. 设置了本变量时，它就是运维值，压过玩家在设置里的选择。设置页会显示“此部署固定了这个值。”
2. 未设置时，用玩家在设置里的选择。它只在 `self` 层级生效，桌面版和自托管的 Web 部署都可以改。它保存在服务端数据库的 `server_settings` 表里，修改后下一次提交或清理就生效，见 [`settings-store.md`](./settings-store.md)。
3. 都没有则是 30 天。

`demo` / `commercial` 层级忽略保存的值，只认本变量。所有“服务端执行的设置”都按这个顺序：环境变量、保存的值、默认值。

SQLite 新建的数据库使用增量 auto-vacuum，清理后会把空闲页交还给文件。旧的数据库文件保持原样：空间会被复用，但文件不会缩小。见 [`storage.md`](../internals/storage.md)。

**`COVEL_SUSPENSION_TTL_MS`**

- 默认 `604800000`（7 天），控制未解决的挂起项多久后被清理。`0` 或负数关闭清理。
- 没有独立的定时器。服务启动时强制清理一次；之后在有人请求挂起项列表或恢复某个挂起项时顺带触发，最多每小时一次。
- **正在恢复中的（claimed）和已经成功解决的记录永远不清理。**
- 同一次清理还会释放进程中途退出后留下的 claim，让这个挂起项可以再次恢复或放弃。SQLite 和内存后端在启动时释放全部 claim；PostgreSQL 只释放超过 1 小时的 claim，因为别的进程可能正在恢复。这一步不受本变量关闭的影响。
- 它是框架级的开关，不是插件的会话设置。详见 [`api.md`](./api.md) 的 Suspend / Resume 章节。

### 插件相关

**`COVEL_PLUGIN_LOG_LEVEL`**

- 取 `debug` / `info` / `warn` / `error`：插件的 `ctx.logger` 写入 `_logs` 的最低级别。
- 未设置时，开发环境是 `debug`，`NODE_ENV=production` 时是 `info`。低于这个级别的日志不写入存储。
- 达到级别的 `warn` / `error` 同时写入服务器日志。

**`COVEL_EFFECTS_POLICY`**

默认 `warn`。它决定这种情况怎么处理：同一并行层里的两个 runtime，一个读、一个写同一份数据，彼此之间又没有声明依赖。

- `warn`：给出稳定的诊断信息，仍然并行执行。
- `strict`：给出诊断的同时，按 runtime ID 的固定顺序把冲突的一对拆开串行执行。不添加依赖边，不会造成环。没有冲突的 runtime 仍然并行。
- 任何不是 `strict` 的值都当作 `warn`。

它是框架级的开关（`feature` 组），不是插件的会话设置。

**插件自己的环境变量**

- 插件自带的开关由插件自己通过 `process.env` 读取，写在各自的 `PLUGIN.md` / `README.md` 里。它们不经过框架的读取函数，也不在本页的分组表里。
- 插件的阈值类配置优先用每个会话的 `userSettings`（hook 里通过 `HookContext.getOwnSettings()` 读取），环境变量只作兜底。

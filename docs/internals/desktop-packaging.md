# 桌面打包与发布

这一页讲怎样构建 Covel 桌面版的安装包，怎样在本地检查它，以及发一个版本要走哪些步骤。它写给维护者和想自己打包的贡献者。

官方的 GitHub Release 只发布两种产物：macOS Apple Silicon 和 Windows x64。它们都**没有签名**，因为项目没有平台签名证书。玩家第一次打开时，macOS Gatekeeper 和 Windows SmartScreen 可能会给出警告。Linux 产物可以在 Linux 机器上用同一份 electron-builder 配置自己构建。

## One-off prep

1. 在仓库根目录安装工具链和依赖：

   ```bash
   pnpm install
   ```

2. 准备打包用的资源：

   ```bash
   pnpm --filter @covel/desktop build
   ```

   它生成 `apps/desktop/dist/` 和 `apps/desktop/staging/`。构建过程不联网下载模型数据库：它复制仓库里提交的那份 LiteLLM 快照，并检查 staging 里有 `node_modules/@covel/ai-provider/data/model-db.json`。独立 Node 模式的准备步骤不下载 Electron；后续 electron-builder 打包时获取目标平台的 Electron。Electron 后端模式仍在构建前获取并校验实际运行时。

   默认 `standalone` 模式的后端运行时来自 Node 官方分发站，固定为 `apps/desktop/node-runtime.json` 的版本与各平台 SHA256，并与 `mise.toml` 保持一致。下载通过校验后才解包；缓存复用也要校验。安装包只携带运行所需的 Node 可执行文件、许可证和校验元数据，不携带 npm，也不在玩家首次启动时下载运行时。

3. 调用 electron-builder 打包：

   ```bash
   pnpm --filter @covel/desktop dist
   ```

   各平台有自己的命令，见下面的 [macOS](#macos)、[Windows](#windows)、[Linux](#linux)。在仓库根目录运行 `pnpm build:electron` 效果相同，并且会在最后清掉解包目录，只留下安装包。

### 选择后端运行时

唯一开关是 `apps/desktop/node-runtime.json` 的 `mode`，只在构建时读取：

| 值                   | 后端进程                                                           | 随包的额外 Node                        |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| `standalone`（默认） | 固定摘要校验的独立 Node                                            | 保留 `resources/node/`                 |
| `electron`           | 安装包自身的 Electron 可执行文件，以 `ELECTRON_RUN_AS_NODE=1` 启动 | 不下载、不打包，清除该目标的旧暂存副本 |

以后切回 Electron 不需要重写后端：先升级并锁定已修复的 Electron，再把 `mode` 改为 `electron`，重新构建整个安装包并运行下文的产物校验与启动冒烟。反向切换也只改同一字段并重建。它不是玩家设置，也不能通过环境变量覆盖；开发模式仍使用外部管理的服务端。

构建检查实际 Electron 可执行文件的内嵌版本和 RunAsNode fuse，不只看 npm 包版本。只允许稳定版 Electron，且内嵌 Node 属于已修复的 24.x（至少 24.22.1）或 26.x（至少 26.12.1）。旧版、预发布、未知主版本或禁用 RunAsNode 都会失败，不回退到其他运行时。当前锁定的 Electron 44.9.3 不满足条件，不能启用该模式。

主进程 bundle、目标资源和运行时选择通过摘要绑定；只改配置、复用旧 bundle 或混用不同目标资源会被拒绝。产物检查读取实际 `app.asar` 中的入口与主进程字节，不能用源码目录里的文件代替。每次受桌面管理的启动、重启和故障恢复都重新校验。切换模式不降低系统版本要求，也不表示已完成对应平台的运行验证或签名支持。

### 更新内置的模型数据库

内置快照来自 `packages/ai-provider/model-db-source.json` 里写明的那个 LiteLLM 提交。更新它的步骤：

1. 修改这个文件里的 40 位提交号和提交时间。
2. 运行 `pnpm --filter @covel/ai-provider update-model-db`。它会重新生成快照，并重新记录每个模型名提供哪些思考强度。
3. 检查生成的 JSON 的差异，以及 `packages/ai-provider/tests/__snapshots__/reasoning-characterization.snap.txt` 的差异。
4. 把清单文件、快照和这份记录一起提交。

`pnpm release:preflight` 会拒绝没有纳入版本管理的快照或清单。最终的安装包校验还会确认快照在打包后仍然存在。玩家想要更新的数据时，可以在设置里手动刷新，新数据下载到用户的配置目录。

### 应用启动时的行为

打包者需要知道的几件事：

- 桌面版只允许一个实例。它先拿到单实例锁，再启动内置的服务端进程。再开一个实例时，会把已有的窗口切到前台。
- 页面的本地存储使用 Electron 持久化的默认会话。服务端进程优先使用上次的端口，让页面的来源地址保持不变。
- 服务端进程恢复时保留当前页面，并在应用里显示状态。Windows 启动后端时隐藏额外的控制台窗口。
- 桌面健康检查只读取响应状态，并在请求期限内释放未使用的响应体，避免轮询占用连接。
- 原生菜单里的“导入插件”和“导入世界”会打开 **设置 → 安装与管理**。选择 ZIP、校验、授权和成功/失败提示都走共用的安装流程。直接复制文件夹不是一种安装方式。

### 打包后的服务端怎样启动

- 内置服务端使用构建时选定的运行时直接执行预编译的 `server/src/index.js`。默认独立 Node 位于 `resources/node/node`（Windows 为 `node.exe`）；Electron 模式只用本安装包的可执行文件。两种模式都不查找玩家 PATH，也不在启动时转译框架模块。
- 每次启动、重启或恢复前都核对运行时选择、主进程摘要和目标平台；独立 Node 还核对固定二进制及许可证摘要，Electron 模式核对实际内嵌版本及 fuse。大文件摘要和 fuse 扫描使用异步读取，校验完成前不启动子进程，也不复用上次校验结果。缺失、损坏或不符时提示重新安装，不执行替代运行时。合并环境配置后移除 `NODE_OPTIONS`、`NODE_PATH` 和外来 Electron 模式变量，保留合法的代理、提供商密钥与 `NODE_EXTRA_CA_CERTS`。
- 构建把 staging 里的框架模块以最多四个并行任务编译到源码旁边。全部编译成功后才改写包的运行时导出，再删除已成功编译的 `.ts`；失败时先等正在执行的任务结束，再报错，不进入裁剪。`import.meta.url` 算出来的模型数据和提示词文件的相对位置不变。
- `tsx` 加载器及其 esbuild 目标二进制保留在 `resources/server/node_modules/`，用于动态加载 TypeScript 插件；桌面主进程不再另带一份依赖树。
- HTTP 端口监听成功后，子进程向父进程发一条私有的 `covel:ready` 消息，带上端口。桌面版收到后立刻加载应用。
- 等待就绪在这三种情况下失败：子进程退出、IPC 断开、超过 30 秒。

### staging 目录的规则

- staging 目录拥有自己的文件。`pnpm deploy` 之后，构建先把硬链接换成独立的副本，再改写资源或缓存输出。打包和恢复 Turbo 缓存都不能改动工作区源码或 pnpm 的包存储。
- 编译后只清理审核过的测试、快照和类型声明位置；保留第三方运行源码、Zod 的源码导出、所有目标架构的原生库、插件与世界内容、语言资源和许可证。删除重复的 `.pnpm` 目录之前，检查保留的链接和显式运行路径，发现依赖被删目录或宿主文件时直接失败。
- 主进程和 preload 的 npm 依赖已经打入 bundle，在桌面包里列为开发依赖。构建检查输出只剩 Node 内置模块或 Electron 导入，并核对服务端保留的许可证与实际打入 bundle 的版本和文本一致。
- Turbo 的桌面任务会等服务端构建完成。它的缓存输入包括服务端代码、工作区包、内置插件、提示词和世界。生成的输出、依赖目录和任务日志不算输入。
- 构建不会打包开发者的 `llm.toml` 或其他私有的服务端配置。staging 检查和解包后的安装包检查都会拒绝服务端资源根目录下出现这些文件。
- 安装后的应用总是从用户配置目录读取 `llm.toml`，文件在首次启动之后才创建也一样。
- 内置资源目录缺失时，它在发现顺序里的位置不变。用户插件不会因为安装资源缺失而获得内置插件的信任。
- 每个目标平台与架构单独准备 `staging/backend-runtime/<os>-<arch>/`；打包钩子按实际目标选取，不能把构建机的运行时复制进其他架构的安装包。staging 和解包产物校验检查选定运行时的版本、平台和架构，并执行该模式的资源与摘要检查。

### 启动冒烟测试

启动冒烟测试跑两次：一次用临时生成的配置，一次完全没有配置。两次都不需要模型密钥，也不调用模型。它们检查：

- 使用实际随包选定的运行时和 SQLite，并确认 sqlite-vec 可用。运行时缺失或校验失败就报错，不回退到宿主 Node 或内存后端。
- 就绪消息能收到。
- 收到关闭请求时干净退出，父进程断开时也干净退出。
- 没有任何内置插件加载失败，包括 `[plugin-entry]` 工厂初始化失败。

> [!NOTE]
> 只有健康检查返回成功还不算通过：一个插件可以加载失败，而服务端照常运行。

## macOS

桌面版要求 macOS 13.5（Ventura）或更高版本。Electron 44 本身要求 13.0，但独立 Node 26 官方二进制要求 13.5，因此 `mac.minimumSystemVersion` 采用更严格的 `"13.5.0"`。见 [Node 26 平台要求](https://github.com/nodejs/node/blob/v26.12.1/BUILDING.md#platform-list)。

### Official unsigned build

仓库里的配置设置了 `mac.identity: null` 和 `mac.notarize: false`。发版 CI 另外设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`。不需要任何签名证书或 Apple 账号。

```bash
pnpm --filter @covel/desktop dist:mac
```

产物是 `release/electron/` 下的 `.dmg` 和 `.zip`，目标架构是 `arm64`。应用没有签名也没有公证，玩家第一次打开时可能要在 macOS 的“隐私与安全性”里确认。

### Optional future signing

官方 macOS 构建保持无签名。独立 Node 使用官方二进制的固定摘要，目前不支持自行签名或公证的构建：electron-builder 默认会重新签名 `Contents/Resources/node/node`，改变文件字节，导致运行时校验失败。

仅修改 `identity` / `notarize` 不足以启用签名。以后接入签名时，需要单独验证 Node 原有签名、完整应用公证、解包校验和真实启动；不要关闭摘要校验，也不要把签名后现场生成的摘要当成可信固定值。

### Entitlements

`apps/desktop/resources/entitlements.mac.plist` 是 hardened runtime 需要的权限文件。它允许三件事：

- V8 的 JIT。
- 启动 Node 子进程（`com.apple.security.cs.allow-dyld-environment-variables`）。
- 内置 API 服务端使用的本机回环网络。

不清楚某一项为什么需要时，不要删它。

## Windows

### Official unsigned build

发版 CI 设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，不提供证书。

```bash
pnpm --filter @covel/desktop dist:win
```

产物在 `release/electron/` 下，都是 x64：

| 文件                                            | 用途                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Covel-electron-<version>-win-x64.exe`          | 推荐的 NSIS 安装程序。安装后不再由便携启动器解压。                                 |
| `Covel-electron-<version>-win-x64.zip`          | 免安装目录。先“全部解压”，之后直接运行目录中的 `Covel.exe`，保留同目录的其他文件。 |
| `Covel-electron-<version>-win-x64-portable.exe` | 单文件自解压版。每次启动都解压，退出时清理，不缓存上一次解压结果。                 |

单文件版用 NSIS 的 `portable.splashImage` 在解压期间显示静态准备提示。它不是进度条，也不保证在 SmartScreen 或杀毒扫描之前出现。提示关闭后才启动 Electron，不能保证两者之间没有空档。ZIP 避免重复解压，但不消除应用和后端本身的启动耗时。三种形式的数据目录规则相同，不把存档改放到 EXE 旁边。

编辑 `apps/desktop/resources/portable-splash.svg` 后，运行下面的命令生成 640×300、24 位 BMP，检查文字和颜色后连同 SVG 一起提交。NSIS 直接读取 BMP，不在玩家机器上运行生成器：

```bash
pnpm --filter @covel/desktop exec electron scripts/generate-portable-splash.mjs
```

### Optional future signing

如果以后有维护者拿到了 Windows 代码签名证书，本地构建可以用这些变量。官方的发版 CI 不读取它们。

| 变量                       | 用途                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `CSC_LINK`                 | `.pfx` 代码签名证书的路径（或 https 地址）                            |
| `CSC_KEY_PASSWORD`         | `.pfx` 的密码                                                         |
| `WIN_CSC_TIMESTAMP_SERVER` | 可选，RFC 3161 时间戳服务地址（默认 `http://timestamp.digicert.com`） |

```bash
CSC_LINK=/path/to/cert.pfx \
CSC_KEY_PASSWORD=... \
  pnpm --filter @covel/desktop dist:win
```

### SmartScreen

没有签名的官方构建第一次启动时会触发 Windows SmartScreen。两种处理方式：

1. 现阶段让玩家在 SmartScreen 对话框里点“仍要运行”。
2. 以后购买合适的证书，在后续版本里加上代码签名。

## Linux

```bash
pnpm --filter @covel/desktop dist:linux
```

官方 Node 的 Linux 二进制需要内核 4.18、glibc 2.28、libstdc++ 6.0.25（`GLIBCXX_3.4.25`）或更高版本，以及 libatomic 运行库（通常名为 `libatomic1` 或 `libatomic`）。deb 声明这些库的依赖；AppImage 用户需要在系统上安装它们。这不是 musl/Alpine 版运行时，也不是不依赖系统库的包。每个架构的安装包都要在对应平台验证，不能用构建机上的启动检查代替其他架构的运行验证。

产物在 `release/electron/` 下：

- `Covel-electron-<version>-linux-x64.AppImage` 和 `Covel-electron-<version>-linux-arm64.AppImage`
- `Covel-electron-<version>-linux-x64.deb`

目前没有接入 GPG 签名。分发时需要的话：

```bash
# After building
dpkg-sig --sign builder release/electron/*.deb
```

## Verifying a build locally

### 两步清理

打包后的清理分两步。这样 CI 构建时解包目录还在，可以拿来检查；而你在本地运行 `pnpm build:electron` 时，最后只剩安装包。

1. **第一步**：`afterAllArtifactBuild` 钩子（`apps/desktop/scripts/cleanup-artifacts.mjs`）只删自动更新用的元数据：`*.blockmap`、`latest-*.yml`、`builder-*.yml`。解包目录 `mac-arm64/` 保留，`apps/desktop/scripts/verify-release.mjs` 可以检查 `Covel.app/Contents/Resources/...`。
2. **第二步**：`node apps/desktop/scripts/cleanup-artifacts.mjs --strip-unpacked`。根目录的 `build:electron` 脚本在 `electron-builder` 返回**之后**接着运行它，删掉 `mac-arm64/` 和各个 `*-unpacked/` 目录。本地最后只剩 `.dmg` 和 `.zip`。

CI **不**调用第二步。它直接运行 `electron-builder`，让解包目录留到 `Verify unpacked release resources` 这一步，然后 `actions/upload-artifact` 只上传分发文件（macOS 是 `.dmg` 和 `.zip`，Windows 是 `.exe` 和 `.zip`）。

### 发版 CI 检查什么

- 每个平台上，先检查解包后的应用入口和资源，再用其中选定的运行时启动后端，验证 SQLite、向量扩展和插件加载，最后只上传安装包。每个内置插件必须保留根 `PLUGIN.md`；子目录清单或仅有翻译文件不能代替它。
- Windows 还运行 `apps/desktop/scripts/verify-windows-artifacts.mjs`，分别启动真正的 ZIP 内 `Covel.exe` 和单文件自解压 EXE。检查要求原生准备画面、进程树内实际可见且未最小化的应用窗口、世界列表和可操作的开局按钮，再检查整个进程树退出。它使用隔离数据目录，不调用付费模型。
- 这项 Windows 检查需要交互式、未锁定的桌面；拿不到原生像素或可见窗口就失败。截图和日志单独上传到 `covel-windows-startup-evidence`，不混进发布安装包。macOS 构建、API 检查和渲染器截图不能代替这项原生 Windows 证据。
- 官方构建没有签名，所以没有签名检查。
- 发布任务为每个 `.dmg`、`.zip` 和 `.exe` 写一份 `SHA256SUMS.txt`，附在 GitHub Release 上。玩家用 `shasum -a 256 -c SHA256SUMS.txt`（macOS）或 `sha256sum -c SHA256SUMS.txt` 校验下载的文件。这份清单说明的是“文件和构建任务上传的一致”，不是“谁构建的”。
- 发布任务还为同一批文件记录构建来源证明。`gh attestation verify <file> --repo ackness/covel` 可以确认一个下载的文件是这个仓库的发版工作流构建的，以及来自哪个提交。

### 检查 electron-builder 实际复制的资源

在本地做出 macOS arm64 的解包构建之后，可以用同一个冒烟测试检查 electron-builder 实际复制进去的资源：

```bash
node apps/desktop/scripts/verify-staging.mjs \
  --resources release/electron/mac-arm64/Covel.app/Contents/Resources
```

加上 `--no-llm-toml` 可以检查没有配置时的默认行为，以及父进程断开后的收尾。冒烟测试的数据放在操作系统临时目录里的独立子目录；应用资源和用户数据只读不写。

> [!NOTE]
> 解包目录只在第二步清理之前存在。`pnpm build:electron` 跑完后它已经被删掉；要保留它，运行 `pnpm --filter @covel/desktop dist:mac`。

### 离线启动

打包后的 Web 应用启动时不向字体服务或任何第三方发请求：

- 拉丁字体（`@fontsource-variable/*`，约 530 KB 的 WOFF2，SIL OFL 1.1 许可）打包在 `dist/web/assets` 里。
- 构建出的页面带内容安全策略，见[安全边界](./security.md)。

所以第一次启动时没有网络，画面也和联网时一样。

## Sidecar shutdown

sidecar 指桌面版启动的那个内置服务端子进程。

- 正常退出应用时，Electron 等 sidecar 退出之后才结束。重启走同一道等待。
- 正在进行的版本更新检查会响应后端关闭信号，取消网络请求；它不会占满收尾预算，让快速重启跳过存储关闭。
- 每个平台上，都由父子进程之间的一条私有 IPC 消息请求服务端收尾。只有 IPC 不可用时才退回到 SIGTERM（Windows 上这条退路是强制结束）。
- sidecar 发现自己和父进程的 IPC 断开时，也执行同样的收尾。所以崩溃的桌面版不会留下一个占着数据库的孤儿进程。
- 如果父进程在 sidecar 启动途中就退出了，sidecar 初始化结束时会发现 IPC 已断开，并立刻收尾。

时间限制：

| 阶段                      | 时限                                                  |
| ------------------------- | ----------------------------------------------------- |
| 服务端自己的收尾          | 10 秒，超过后它强制退出                               |
| 桌面版等 sidecar 完成收尾 | 12 秒，超过后发 SIGKILL                               |
| 发出 SIGKILL 后确认退出   | 再等 1 秒；仍没看到退出就报错，并且不启动新的 sidecar |

发信号出错不算“已确认退出”。操作系统强制结束应用的情况不在这条收尾路径之内。

进程收尾和重复退出的回归测试：

```bash
pnpm --filter @covel/desktop test
```

## Auto-update publishing

自动下载和安装更新**没有启用**。

- `apps/desktop/electron-builder.yml` 里是 `publish: null`。
- `apps/desktop/scripts/cleanup-artifacts.mjs` 会删掉 `latest-*.yml` 和 `*.blockmap`。
- 最终的分发文件：macOS 是 `.dmg` 安装镜像和装着 `.app` 的 `.zip`；Windows 是 NSIS 安装程序、自解压版两个 `.exe` 和免安装目录 `.zip`；本地 Linux 打包产出配置里的 `.AppImage` 和 `.deb`。

打包后的应用已经会在每次启动时检查一次 GitHub 上有没有更新的正式版，并让玩家选择打开下载页或忽略这个版本。这个提示不会下载或安装任何东西，见[桌面版配置](../reference/desktop-config.md#新版本提示)。

以后要启用自动更新：

1. 删掉 `apps/desktop/electron-builder.yml` 里的 `publish: null`，或者换成真实的发布配置。
2. 修改 `apps/desktop/scripts/cleanup-artifacts.mjs`，保留 `latest-*.yml` 和 `*.blockmap`（现在它们在删除列表里）。
3. 在 CI 里传入 `GH_TOKEN`（或对应发布服务的凭证）。Release 工作流的 `--publish=never` 要改成 `--publish=always`。
4. 加入 `electron-updater` 依赖，并在 `apps/desktop/src/main.ts` 里接入。

## Release checklist

按顺序做。每一步通过了再做下一步。

1. **设置版本号。** 在干净的工作区里先运行 `pnpm release:prepare <version> --dry-run`，再运行 `pnpm release:prepare <version>`。它做这些事：
   - 设置根目录、`apps/*` 和 `packages/*` 的版本。插件和世界包各自维护版本，不会被改。
   - 更新 `README.md` 和 `README.zh-CN.md` 里的版本徽章和“源码版本”一行。
   - 汇总变更日志（下一步）。
   - 版本号比当前低，或者工作区有未提交的改动时，它会拒绝运行。它不提交、不打标签、不推送。
   - 用同一个版本号再跑一次，只会加入上次之后合并进来的片段。
2. **检查变更日志。** `pnpm release:prepare` 里的这一步（单独运行 `pnpm changelog:release <version>` 只做这一步）把 `docs/changelog.d/` 里的片段和 `[Unreleased]` 下的条目移到 `docs/CHANGELOG.md` 的 `## [<version>] - <date>` 一节，并删除片段。你要做的：
   - 在标题下写一段总结。
   - 检查 README 链接到的 `Breaking changes in v<version>` 和 `Upgrade notes for v<version>` 两节。
   - 之后又合并了新片段的话，打标签前要再跑一次。
3. **改 README 的升级提示。** 重写 `README.md` 和 `README.zh-CN.md` 里当前版本提示的那句升级说明。脚本只改徽章和“源码版本”，并会指出哪些行还带着旧版本号。检查 Release 链接。
4. **新手引导。** 引导流程有变化时，把 `apps/web/src/components/onboarding-wizard/constants.ts` 里的 `ONBOARDING_VERSION` 加一。
5. **本地检查。** 依次运行 `pnpm check`、`pnpm test`、`pnpm test:pg`、`pnpm e2e` 和 `pnpm release:preflight`。已知的失败先修好再推送。
6. **构建桌面资源。** 运行 `pnpm --filter @covel/desktop build`。
7. **玩家流程验收。** 用隔离的数据和真实模型完成[发版前的玩家流程验收](./e2e-testing.md#发版前的玩家流程验收)。确定性测试和启动健康检查不能说明游戏能玩。
8. **重启冒烟。** 在有桌面环境的会话里运行 `pnpm --filter @covel/desktop smoke:restart`，确认 preload 里的版本正确，并且页面能跳到新的后端端口。
9. **发布说明。** 确认发布说明写明了 macOS 和 Windows 的产物没有签名。
10. **推送并等 CI。** 本地检查通过后推送评审过的拉取请求，等 CI 和 PostgreSQL 集成测试通过。
11. **试打包。** 在候选分支上手动运行 `Build Desktop` 工作流，`publish_release=false`。两个平台的任务都会检查 staging 资源和启动；Windows 还会跑一遍包安装 API 的回归测试。
12. **打标签。** 合并拉取请求，确认 `main` 正常，然后在那个合并提交上创建并推送一个带注释的 `v*` 标签。推送标签会触发构建并发布 GitHub Release。
13. **检查校验文件。** 确认 Release 里安装包旁边有 `SHA256SUMS.txt`，并对其中一个安装包运行 `gh attestation verify <installer> --repo ackness/covel`，确认通过。
14. **下载复核。** 下载发布出来的 `.dmg`、`.zip`、安装程序和便携版 `.exe`，核对版本和摘要，并在下载的包上重复启动检查和插件生命周期检查。

发布工作流的规则：

- 手动触发的构建只解析一次你给的 ref，并把得到的那个不可变的提交传给所有任务。
- 发布需要同时满足：一个已经存在的语义化版本标签、和它一致的框架包版本、变更日志里对应的一节，以及 `docs/changelog.d/` 里没有剩下的片段。
- 工作流从不创建或移动标签。
- 试运行（`publish_release=false`）只构建产物，不创建 GitHub Release。

> [!IMPORTANT]
> 记录实际验证过的操作系统和玩家流程。Windows 上构建成功、API 测试通过，不能代替在 Windows 上完整地玩一遍。

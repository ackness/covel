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

   它生成 `apps/desktop/dist/` 和 `apps/desktop/staging/`。构建过程不联网下载模型数据库：它复制仓库里提交的那份 LiteLLM 快照，并检查 staging 里有 `node_modules/@covel/ai-provider/data/model-db.json`。

3. 调用 electron-builder 打包：

   ```bash
   pnpm --filter @covel/desktop dist
   ```

   各平台有自己的命令，见下面的 [macOS](#macos)、[Windows](#windows)、[Linux](#linux)。在仓库根目录运行 `pnpm build:electron` 效果相同，并且会在最后清掉解包目录，只留下安装包。

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
- 服务端进程恢复时保留当前页面，并在应用里显示状态。
- 原生菜单里的“导入插件”和“导入世界”会打开 **设置 → 安装与管理**。选择 ZIP、校验、授权和成功/失败提示都走共用的安装流程。直接复制文件夹不是一种安装方式。

### 打包后的服务端怎样启动

- 内置的服务端进程在 Electron 的 Node 模式下直接运行预编译好的 `server/src/index.js`。框架模块不需要在启动时转译。
- 构建把 staging 里的每个工作区包都编译到源码旁边，并把包的导出指向生成的 `.js`。所以 `import.meta.url` 算出来的模型数据和提示词文件的相对位置不变。
- `tsx` 加载器仍然保留，用来加载动态导入的 TypeScript 插件代码。
- HTTP 端口监听成功后，子进程向父进程发一条私有的 `covel:ready` 消息，带上端口。桌面版收到后立刻加载应用。
- 等待就绪在这三种情况下失败：子进程退出、IPC 断开、超过 30 秒。

### staging 目录的规则

- staging 目录拥有自己的文件。`pnpm deploy` 之后，构建先把硬链接换成独立的副本，再改写资源或缓存输出。打包和恢复 Turbo 缓存都不能改动工作区源码或 pnpm 的包存储。
- Turbo 的桌面任务会等服务端构建完成。它的缓存输入包括服务端代码、工作区包、内置插件、提示词和世界。生成的输出、依赖目录和任务日志不算输入。
- 构建不会打包开发者的 `llm.toml` 或其他私有的服务端配置。staging 检查和解包后的安装包检查都会拒绝服务端资源根目录下出现这些文件。
- 安装后的应用总是从用户配置目录读取 `llm.toml`，文件在首次启动之后才创建也一样。
- 内置资源目录缺失时，它在发现顺序里的位置不变。用户插件不会因为安装资源缺失而获得内置插件的信任。

### 启动冒烟测试

启动冒烟测试跑两次：一次用临时生成的配置，一次完全没有配置。两次都不需要模型密钥，也不调用模型。它们检查：

- 就绪消息能收到。
- 收到关闭请求时干净退出，父进程断开时也干净退出。
- 没有任何内置插件加载失败，包括 `[plugin-entry]` 工厂初始化失败。

> [!NOTE]
> 只有健康检查返回成功还不算通过：一个插件可以加载失败，而服务端照常运行。

## macOS

Electron 44 要求 macOS 13（Ventura）或更高版本。打包配置里写了 `mac.minimumSystemVersion: "13.0.0"`，和这个要求一致。当前构建不支持 macOS 12。见 [Electron 44 发布说明](https://github.com/electron/electron/releases/tag/v44.0.0)。

### Official unsigned build

仓库里的配置设置了 `mac.identity: null` 和 `mac.notarize: false`。发版 CI 另外设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`。不需要任何签名证书或 Apple 账号。

```bash
pnpm --filter @covel/desktop dist:mac
```

产物是 `release/electron/` 下的 `.dmg` 和 `.zip`，目标架构是 `arm64`。应用没有签名也没有公证，玩家第一次打开时可能要在 macOS 的“隐私与安全性”里确认。

### Optional future signing

如果以后有维护者拿到了 Apple Developer 证书，本地签名用下面这些 electron-builder 变量。官方的发版 CI 不读取它们。

| 变量                          | 用途                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `CSC_LINK`                    | Developer ID Application `.p12` 证书的路径（或 https 地址）                        |
| `CSC_KEY_PASSWORD`            | `.p12` 的密码                                                                      |
| `APPLE_ID`                    | Apple Developer 账号的邮箱                                                         |
| `APPLE_APP_SPECIFIC_PASSWORD` | [App 专用密码](https://support.apple.com/en-us/102654)（不是 Apple ID 的登录密码） |
| `APPLE_TEAM_ID`               | 开发者团队 ID（10 个字符，例如 `ABCDE12345`）                                      |

要在本地做一个签名并公证的构建，先编辑 `apps/desktop/electron-builder.yml`。把：

```yaml
mac:
  identity: null
  notarize: false
```

改成（也可以删掉 `identity` 一行，让它自动寻找证书）：

```yaml
mac:
  identity: "Developer ID Application: Your Name (TEAMID)"
  notarize:
    teamId: "${env.APPLE_TEAM_ID}"
```

然后运行：

```bash
CSC_LINK=/path/to/cert.p12 \
CSC_KEY_PASSWORD=... \
APPLE_ID=you@example.com \
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx \
APPLE_TEAM_ID=ABCDE12345 \
  pnpm --filter @covel/desktop dist:mac
```

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

产物是 `release/electron/` 下的 NSIS 安装程序和便携版，都是 x64。

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

CI **不**调用第二步。它直接运行 `electron-builder`，让解包目录留到 `Verify unpacked release resources` 这一步，然后 `actions/upload-artifact` 只上传安装包（macOS 是 `.dmg` 和 `.zip`，Windows 是 `.exe`）。

### 发版 CI 检查什么

- 每个平台上，先检查解包后的应用资源，再只上传安装包。
- 官方构建没有签名，所以没有签名检查。
- 发布任务为每个 `.dmg`、`.zip` 和 `.exe` 写一份 `SHA256SUMS.txt`，附在 GitHub Release 上。玩家用 `shasum -a 256 -c SHA256SUMS.txt`（macOS）或 `sha256sum -c SHA256SUMS.txt` 校验下载的文件。这份清单说明的是“文件和构建任务上传的一致”，不是“谁构建的”。
- 发布任务还为同一批文件记录构建来源证明。`gh attestation verify <file> --repo ackness/covel` 可以确认一个下载的文件是这个仓库的发版工作流构建的，以及来自哪个提交。

### 检查 electron-builder 实际复制的资源

在本地做出 macOS arm64 的解包构建之后，可以用同一个冒烟测试检查 electron-builder 实际复制进去的资源：

```bash
node apps/desktop/scripts/verify-staging.mjs --electron-node \
  --resources release/electron/mac-arm64/Covel.app/Contents/Resources
```

加上 `--no-llm-toml` 可以检查没有配置时的默认行为，以及父进程断开后的收尾。冒烟测试的数据放在桌面 staging 下的临时目录里；应用资源和用户数据只读不写。

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
- 最终的安装包：macOS 是 `.dmg` 安装镜像和装着 `.app` 的 `.zip`；Windows 是 NSIS 和便携版两个 `.exe`；本地 Linux 打包产出配置里的 `.AppImage` 和 `.deb`。

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

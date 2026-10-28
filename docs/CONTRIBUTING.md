# Contributing to Covel

感谢你愿意参与 Covel！本文档描述了贡献代码、问题与文档的流程。

> 🇬🇧 [English version](./CONTRIBUTING.en.md)

> 根目录 README 见 [`../README.md`](../README.md)。

参与本项目的每个人都遵守[行为准则](../CODE_OF_CONDUCT.md)（英文）。

## 开发环境

- Node.js 26.x
- pnpm 12.14.0（见根目录 `package.json` 的 `packageManager`）
- 可选：Docker（用于 PostgreSQL 模式）

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # server and storage settings
cp llm.toml.example llm.toml   # 配置 LLM slot
cp .env.llm.example .env.llm   # 填写 API Key
pnpm dev                       # 同时启动前端与后端
```

每个新克隆在 `pnpm install --frozen-lockfile` 后运行一次 `pnpm hooks:install`，安装本地 Git pre-push hook；已有 pre-commit hook 保持不变。如果已有其他 pre-push hook，安装命令会拒绝覆盖，需先自行处理冲突。pre-push hook 使用 `mise exec` 选择 `mise.toml` 指定的 Node 26.12.1、pnpm 12.14.0 和 actionlint，因此还需安装 mise 并运行 `mise install` 准备相应工具链。运行检查的 Node 与 `mise.toml` 指定的版本不一致时（例如 PATH 里 nvm 排在 mise 前面），检查直接拒绝并说明原因，不会在别的 Node 上运行测试。

提交前检查由根目录 `.pre-commit-config.yaml` 定义；安装 pre-commit 后运行 `pre-commit install` 启用，或用 `pre-commit run --all-files` 手动检查。Oxlint 的版本固定在根 `devDependencies` 和 `pnpm-lock.yaml`，与 Prettier 一样通过 `mise exec` 使用项目工具链，不创建独立的 Node 环境。`scripts/run-with-project-node.mjs` 和 pre-push 一样先核对 Node 版本，与 `mise.toml` 不一致时直接拒绝；再将选中的 Node 放在子进程 PATH 首位，确保 CLI shim 和后续命令也使用同一版本；更新配置后，已有 hook 会自动读取新配置，无需清理全局缓存。Oxlint 的规则在根目录 `.oxlintrc.jsonc`，关闭的规则各有一行说明；hook 检查改动的文件，`pnpm check` 检查整个仓库，两处都带 `--deny-warnings`，所以警告也会让检查失败。提交 hook 不做类型检查；类型检查在 `pnpm check`、pre-push hook 和 CI 里运行。

新增文件默认上限为 3 MiB；世界画廊原图 `worlds/*/media/gallery/*.png` 单独允许 4 MiB，以保留 1536×1024 图片的无损质量；每张原图旁要有同名 WebP 展示版，安装包和 Docker 镜像只带 WebP。世界立绘和场景只以 WebP 入库（见 [`guide/world-art-direction.md`](./worlds/art-direction.md)）。

### PostgreSQL 18 开发环境

SQLite 是默认后端，从源码运行不需要数据库服务。要用 PostgreSQL，先按上面的步骤创建根 `.env`，取消 `.env.example` 里“PostgreSQL (optional)”一段的注释，核对 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`POSTGRES_PORT` 与 `DATABASE_URL`。仅启动数据库，不需要 Docker 应用服务的 operator token：

```bash
pnpm db:up
pnpm dev:pg                    # PostgreSQL-backed API server
```

首次初始化时先确认数据库已就绪，再运行 `dev:pg`；可用 `docker compose -f docker/docker-compose.yml --env-file .env ps postgres` 查看 `healthy` 状态。需要前端时，在另一个终端运行 `pnpm dev:web`。`dev:pg` 先读取根 `.env` 做连接预检，默认检查 `DATABASE_URL` 的 host/port；未设置 URL 时使用 `127.0.0.1:POSTGRES_PORT`。更换端口时同步更新 URL；完整覆盖规则见[环境变量说明](./reference/env-registry.md#加载路径与环境差异)。

Compose 使用 PostgreSQL 18 + pgvector 0.8.7，数据库存入 `pgdata18` 卷。旧 PG17 `pgdata` 卷不会被挂载、自动迁移或删除。

### Docker 自托管

自托管有两套 Compose，都是绑定回环地址的个人实例（`DEPLOYMENT_TIER=self`）。默认用 SQLite，只有一个应用容器；要用 PostgreSQL 时换成带 `pg` 的命令。两套各用自己的 Compose 项目和卷，互不影响。

| 后端           | 启动（构建并运行）     | 启动已有容器        | 停止，保留数据        | 停止并**删除卷**          | 日志                  |
| -------------- | ---------------------- | ------------------- | --------------------- | ------------------------- | --------------------- |
| SQLite（默认） | `pnpm docker:build`    | `pnpm docker:up`    | `pnpm docker:down`    | `pnpm docker:down-all`    | `pnpm docker:logs`    |
| PostgreSQL     | `pnpm docker:pg:build` | `pnpm docker:pg:up` | `pnpm docker:pg:down` | `pnpm docker:pg:down-all` | `pnpm docker:pg:logs` |

两套都需要根 `.env`、根 `llm.toml`（模型配置从宿主机只读挂载），并在 `.env` 里设置 `COVEL_MEDIA_TOKEN_SECRET`（`openssl rand -hex 32` 生成；缺少它，应用在生产模式下无法签发媒体地址；SQLite 那套缺少它时 Compose 直接拒绝启动，PostgreSQL 那套不检查，要自己设置）。PostgreSQL 那套还要取消 `.env.example` 里 PostgreSQL 一段的注释并设置 `POSTGRES_PASSWORD`。

SQLite 那套的 `appdata` 卷挂载到 `/home/node/.covel`：数据库文件 `data/covel.db`、媒体文件和安装、生成的用户世界与插件都在里面。PostgreSQL 那套的数据库在 `pgdata18` 卷，`appdata` 卷只保存用户世界与插件。详见 [Docker 配置](./reference/env-registry.md#docker-compose)。

`docker:down` 和 `docker:pg:down` 停止容器并保留数据。**`docker:down-all` 会删除 SQLite 那套的 `appdata` 卷，包括数据库和用户世界、插件；`docker:pg:down-all` 会删除 PostgreSQL 那套的 `pgdata18` 和 `appdata`**；仅在备份后明确需要清空整套环境时使用。

`db:generate` / `db:studio` 是 PostgreSQL 开发维护工具，不是数据库自动升级命令，见[数据库维护](./reference/env-registry.md#数据库维护命令)。

### 官网演示媒体

先安装 FFmpeg。以下命令从仓库根运行，会更新官网站点的视频和封面：

```bash
pnpm --filter @covel/site build:media
# Replace recording.mp4 with an existing source file.
node apps/site/scripts/build-media.mjs ./recording.mp4 --speed 3
```

默认依次选择 `.assets/demo.dev1.mp4`、`.assets/demo.dev0.mp4`；显式路径不存在时直接报错。输出为 `apps/site/public/media/demo.mp4` 和 `demo-poster.jpg`。全部转换完成后才替换现有素材，转换失败会保留原素材并清理临时文件；输入可以是现有输出文件。通过 `pnpm --filter @covel/site build:media` 传入的相对路径以 `apps/site/` 为基准，直接调用 Node 时以当前目录为基准。

README 的动图（`.assets/images/demo.gif`）单独用一段短录屏制作，不超过 6 MiB：宽 800 像素、每秒 10 帧、128 色调色板、不抖动。

```bash
# Replace recording.mp4 with the source file.
vf="fps=10,scale=800:-2:flags=lanczos"
ffmpeg -y -i recording.mp4 -vf "$vf,palettegen=stats_mode=diff:max_colors=128" palette.png
ffmpeg -y -i recording.mp4 -i palette.png -lavfi "$vf [v]; [v][1:v] paletteuse=dither=none:diff_mode=rectangle" .assets/images/demo.gif
rm palette.png
git add -f .assets/images/demo.gif   # .assets/ is ignored
```

README 里的静态截图（`.assets/images/readme/`）取自真实游玩，取景、尺寸和隐私要求见[截图与 README 更新](./internals/e2e-testing.md#截图与-readme-更新)。

## 开发规范

### 代码风格

- TypeScript strict 模式，ESM-only
- 所有 TS import 使用 `.js` 扩展（NodeNext module resolution）
- 单文件 400 行与 800 行是评审时的参考线，不是硬上限；只有职责或维护成本确实需要时才拆分
- 不可变写法，禁用裸 `any`
- 使用 Zod 做外部输入校验
- 参考 [`reference/`](./reference/) 下的领域规范

### 测试

新功能与 bug 修复都应带测试。每个 package 自带 vitest，每次运行使用自己的临时目录并在结束时整个删除（`vitest.base.ts` 的 `useRunTempDir`；包的 `vitest.config.ts` 必须引入 `vitest.base`）：

```bash
pnpm check                                 # CI 静态检查与脚本回归
pnpm deps:check                            # Fallow 依赖与导入检查
pnpm analyze                               # Fallow 死代码、重复代码与复杂度报告
pnpm test                                  # 全量
pnpm check:push                            # 对当前已提交的 HEAD 运行 pre-push hook 的检查
pnpm check:push --full                     # 同上，但运行全部测试套件
pnpm changelog:preview                     # 按 docs/changelog.d/ 预览待发布的 [Unreleased]
pnpm --filter @covel/runtime test          # 单包
pnpm test:pg                               # 必须连接 PostgreSQL 的集成检查
pnpm e2e:smoke                             # CI 的确定性 Chromium 核心流程
pnpm e2e:extensions                        # CI 的社区插件验收（隔离目录里的第三方包）
pnpm e2e                                   # Playwright 端到端
```

`pnpm check` 包含 peer 依赖、类型、Oxlint、包边界、依赖声明、插件 manifest、schema 参考页、提示词变体、i18n、changelog 片段、脚本回归和工作流检查。修改作者可见的 schema 字段后运行 `pnpm schemas:generate`，重新生成 `packages/shared/schemas/*.json` 与 `docs/reference/schema/*.md`；每个字段都必须带 `.describe()` 说明，缺失或生成物过期都会让检查失败。工作流检查要求 `actionlint`，版本固定在 `mise.toml`（与 CI 一致），`mise install` 会一并安装。`pnpm lint` 和 `pnpm test` 不再隐式构建 Web 资源；需要打包验证时另跑 `pnpm build`。

安装 hook 后，每次 `git push` 都会检查本次推送中所有不同且未删除的已提交目标，包括与当前 HEAD 不同的 ref。每个目标在一次性干净克隆中运行 `pnpm install --frozen-lockfile` 和 `pnpm check`；任何一步失败都会阻止推送。源码推送的 hook 不跑测试套件：全部套件由 CI 在 PR 上用并行 job 运行，而 `main` 只接受通过 PR 合入的改动。对已提交的 HEAD 运行 `pnpm check:push`，或用 `COVEL_PUSH_CHECK=affected git push` 推送，会加上这次改动可能影响的测试和 `pnpm e2e --list`。这些测试包括：分支自远端 main 分支（`origin/main`，本地从未获取过时会先获取一次）分出以来改动过的包、依赖这些包的包（`turbo test --filter=...<包名>`），以及 `turbo.json` 里 `$TURBO_ROOT$` 输入匹配到改动文件的套件——内置插件的文件会带上 plugin-loader、runtime 和 server 套件，`worlds/**`、`prompts/**` 会带上读取它们的套件。以下情况运行全部套件：改动了所有包都会读取的文件（`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`turbo.json`、`vitest.base.ts`、根目录的 `package.json` 与 `tsconfig.json`、`mise.toml`），改动了规则未覆盖的根目录文件（规则在 `scripts/lib/push-scope.mjs`），推送目标是 `main` 或 tag，或者无法确定远端 main 分支。`COVEL_PUSH_CHECK=full git push` 和 `pnpm check:push --full` 可以要求运行全部套件；`pnpm check:push --base <分支>` 让叠在其他分支上的分支以下层分支为基准。输出的最后两行说明运行了什么、哪些留给 CI。检查不复制工作区的 `.env`、`node_modules` 或 `test-results`，不会使用开发者数据库连接变量 `DATABASE_URL` / `COVEL_REQUIRE_PG_TESTS`。Turbo 读写的是仓库所有 worktree 共用的缓存（主 worktree 的 `.turbo/cache`）：被推送的提交与某次已通过的运行有相同的已跟踪输入时，任务直接回放；回放看不出的是依赖了 Git 忽略文件的结果，这一类由 CI 兜底。在一台负载较高的开发机上、Turbo 缓存为空时实测：`apps/web` 的一行改动耗时 2 分 52 秒，运行全部套件为 4 分 43 秒；其中安装、`pnpm check` 和 E2E 收集约占 85 秒。`packages/shared` 被所有包依赖，改动它会选中全部套件（4 分 22 秒）。缓存已有结果时，未改动的任务直接回放；store 和 server 套件从不缓存，现在只在改动选中它们时运行。一次推送新增的内容全是文档时，hook 跑 `pnpm check` 和 `pnpm test:docs:packages`；文档脚本测试已包含在前者，不重复运行。独立的 `pnpm test:docs` 仍包含包测试和脚本测试。检查历史提交时使用该提交实际提供的文档命令。新分支以远端的 main 分支为基准。文档指 `docs/**`、根目录的 `*.md`、任意位置的 `README.md` / `README.*.md`、嵌套的 `AGENTS.md` / `CLAUDE.md`、`.claude/skills/**`、`.assets/**`、`LICENSE` 以及 issue 与 PR 模板，清单在 `scripts/lib/change-scope.mjs`。由加载器读取的 Markdown（`PLUGIN.md`、`RUNTIME.md`、`WORLD.md`、`prompts/` 下的文件）是源码，走完整流程。需要提前验证当前已提交的 HEAD 时可运行 `pnpm check:push`。

显式要求全部测试、推送 `main` 或 tag 时，纯文档也运行全部套件和 E2E 收集。已通过的受影响测试只在提交和实际比较基准都相同时复用；`--base` 缩小范围的检查不能代替从 `origin/main` 起算的检查。受影响测试记录只能替代相同范围或纯静态检查，不能代替纯文档检查；完整测试记录可覆盖所有范围。记录新结果时也按同一覆盖规则淘汰旧结果：同一提交的不同基线和互不覆盖的文档检查可以同时保留。

`git push` 先连接远端，再运行 hook；hook 运行期间这条连接上没有任何数据。远端、代理或 NAT 关闭空闲连接后，检查虽然通过，推送仍会失败（`git push` 以状态码 141 退出：它向已关闭的连接写入）。hook 无法让这条连接保持活动，所以做了两件事：少跑，并按 worktree 记录通过检查的提交，保留 12 小时。记录覆盖本次要求的检查时，再次推送同一个提交会直接发送，先运行 `pnpm check:push` 再推送也一样；需要全部套件的改动，先运行 `pnpm check:push --full`，通过后再推送。在 `~/.ssh/config` 里为该主机设置 `ServerAliveInterval 30`，也能避免代理把 SSH 连接当作空闲连接。

该检查只收集 E2E 测试，不执行本次推送未改动的测试套件、PostgreSQL 集成、浏览器 smoke 或发布/打包验证；按需显式运行 `pnpm test:pg`、`pnpm e2e:smoke`、`pnpm e2e`、`pnpm build` 和发布检查，并以 CI 结果为准。

[Fallow](https://github.com/fallow-rs/fallow) 作为根开发依赖安装，替代 Knip。`deps:check` 会阻断未使用依赖、未声明依赖与无法解析的导入；`analyze` 提供完整报告，供人工核实后清理，不作为全量阻断项。`.fallowrc.jsonc` 声明文件路由、插件动态入口和手动运行的脚本；增加这类入口时同步维护配置，避免误报。工具版本遵循工作区的 7 天发布等待期。

`pnpm test:pg` 从环境或根 `.env` 读取 `DATABASE_URL`，强制执行 Store 的五个真实 PG 文件（`pg-store`、`pg-schema-version`、`vector-store`、`media-store`、`schema-ddl-codegen`）和 Server 的全部 `tests/integration`，不再重跑其余 Store 文件。数据库缺失、不可达或缺少 pgvector 都会失败。Store 和 Server 的普通测试也接收显式传入的数据库环境变量，但由于数据库状态不属于源码输入，这两组测试不复用 Turbo 缓存。其余缓存会跟随公共 TypeScript 配置失效，读取框架 prompt 的测试也跟随 `prompts/**` 失效。

`pnpm test:coverage` 顺序执行两个覆盖率入口：`test:coverage:vitest` 每次重新运行 Vitest 工作区，按各包配置在 `coverage/` 生成报告；`test:coverage:desktop` 运行全部桌面 Node 测试与自检，将各子进程的原始 V8 覆盖率写入 `apps/desktop/coverage/`，供单独分析，不混入 Vitest 百分比。CI（[`ci.yml`](../.github/workflows/ci.yml)）只对 `@covel/runtime` 强制覆盖率下限：`pnpm test:coverage:runtime` 带覆盖率运行它的测试，低于 `packages/runtime/vitest.config.ts` 里的 `thresholds` 即失败；下限比实测值低几个百分点，用来拦截下降，覆盖率上升后应随之调高。其余包的 ≥ 80% 仍是参考目标，未强制。

PR、main 和发布统一使用 [`ci.yml`](../.github/workflows/ci.yml)，不再另跑 Docs 验证工作流。每种范围都运行完整的 `pnpm check`。纯文档随后运行 `pnpm test:docs:packages`；源码、混合改动、未知范围和发布运行完整套件。分类复用 pre-push 的 `scripts/lib/change-scope.mjs`；读取文档的包测试必须列进 `test:docs:packages`，由 `scripts/tests/change-scope.test.mjs` 检查。

完整路径中，`verify` 运行静态检查，与 `tests` 的其余套件及构建并行；两者只等待范围选择，各用独立 Turbo 缓存键，且都必须成功才能通过 `Verification`。纯文档的包测试和发布 preflight 留在 `verify`。`tests` 运行除 Web、server、runtime 之外的套件；Web 独立运行；server 独占 runner，并带覆盖率运行 runtime 套件、执行其下限，runtime 在 CI 只运行一次；PostgreSQL 和 Chromium 各自运行。浏览器 job 先收集全部 E2E，发现失效导入，再运行 smoke 和 `pnpm e2e:extensions`，共用安装和 Chromium。Chromium 下载按 Playwright 版本缓存，系统依赖每次安装。

非发布的完整检查运行 `pnpm build --cache=local:r --filter=!@covel/docs --filter=!@covel/site`，只读取 Turbo 缓存、不写回构建产物。官网和文档站由 CI 调用的 Site 任务用 Turbo 并行构建；纯文档改动也必须通过该任务。输入相同时恢复已有产物，仍须成功完成 Site 任务。独立的 `pnpm build` 仍构建全部目标。Turbo 本地缓存由 `turbo.json` 的 `cacheMaxAge`（7 天）和 `cacheMaxSize`（2GB）淘汰；CI 用 `TURBO_CACHE_MAX_AGE` / `TURBO_CACHE_MAX_SIZE` 收紧到 2 天、500MB，因为 actions/cache 每次整目录恢复再保存。

main 的每次推送使用独立的 CI 并发组，避免后来的纯源码推送替换正在等待的文档部署。Site 的非 PR、仅构建运行也使用独立组，不会挤掉待部署运行；需要部署的运行仍按分支共用一组，保留原有 Site 的等待替换行为。PR 的新提交仍会取消旧运行。

范围选择只有需要比较 PR 或 main 推送时获取完整的提交与树历史；发布或显式 commit 请求直接选完整范围，浅检出即可。范围选择、结果汇总和合并门禁只稀疏检出所需的控制脚本，checkout 使用 blob 过滤，避免下载无关历史文件内容或展开整个工作树。控制脚本仍来自工作流自身的版本。

Turbo、Electron、Chromium 和 Site 的任务缓存各用一次 restore；普通 PR/main 运行在任务成功且精确缓存键未命中时，用 restore 返回的原始键保存。失败或取消不保存，PR 缓存仍受 GitHub ref 隔离。发布和显式 commit 可能执行任意源码，不能把执行后产生的文件保存到工作流 ref 的缓存：这些任务仅恢复缓存，setup-node 的 pnpm 缓存关闭。显式 commit 也会传给非发布 Site，其任务缓存同样仅恢复。

桌面后端使用随包 Electron 的 RunAsNode，不再下载、打包或缓存独立 Node。Electron 下载缓存按 OS、架构和 lockfile 区分；发布只能复用已有缓存，未命中时重新下载且不保存。构建与发布校验仍检查目标与实际 Electron/Node 版本、RunAsNode fuse，以及主进程 bundle 与 ASAR 资源的绑定。

发布始终走完整测试路径并运行 `pnpm release:preflight`，不运行 Site 或 workspace Build；平台打包任务自行构建桌面产物。锁文件校验在临时元数据目录完成，不修改工作区依赖或执行安装脚本。发布调用声明嵌套工作流需要的 Pages/OIDC 权限上限，但 CI 将实际执行的发布验证任务限制为 `contents: read`，具有 Pages 写权限的 Site 任务被跳过。

macOS 发布任务从实际 ZIP 启动应用，通过真实 preload 验证世界选择、开局准备和刷新，再检查应用及其进程组退出；截图和日志独立上传。它不验证 Gatekeeper、DMG 安装交互或原生窗口可见性。Windows 发布任务运行桌面回归测试，并在含空格和中文的 ZIP 解压路径验证 Electron 后端；记录产物与 ZIP 解压体积。它还启动实际 ZIP 和自解压 EXE，检查原生准备画面、可见应用窗口、世界选择与开局按钮，以及进程树退出。它需要未锁定的交互式 Windows 桌面；无法观察时失败，不能用 API 或渲染器截图替代。原生截图与日志独立上传，不进入发布资产。打包改动的 PR 必须注明实际验证的平台；添加工作流不等于已通过 Windows 验证。

`Verification` 汇总所选任务，包括每次非发布 CI 的 Site；必需任务缺失、跳过、失败或取消都不能通过。`main` 只接受通过 PR 合入的改动；每个 PR 的 [`gate.yml`](../.github/workflows/gate.yml) 提供 `All checks pass`，要求 `Verification` 成功，同时保留其他检查的失败。重跑失败检查后，也要重跑这一项。

### Dagger 连接验证

[`dagger-smoke.yml`](../.github/workflows/dagger-smoke.yml) 是独立的手动检查，不替代现有 CI。在 `ackness/covel` 的 Actions 页面选择 **Dagger connection check → Run workflow → main**。成功时输出 `Remote Dagger connection and container execution passed.`；它只在远端容器执行固定的 `echo`，不检出源码、不运行项目测试，也不接受命令或目标地址输入。

仓库管理员先创建 `dagger-ci` Environment，将 **Deployment branches and tags** 设为 **Selected branches and tags**，只添加类型为 Branch 的 `main` 规则。在此 Environment 中保存 `DAGGER_CLIENT_CERT`（PEM 客户端证书）和 `DAGGER_CLIENT_KEY`（PEM 私钥），不要改成仓库级 Secrets。工作流自身也校验仓库名和 `refs/heads/main`；它不响应 PR，不能从 fork 获取凭据。

入口为 `tls://ci.covel.cc:8443`，使用系统信任的服务端证书和客户端 mTLS。CLI 从固定摘要的 Engine 镜像复制，版本与服务端一致；证书只写进 runner 的临时目录，退出时删除。客户端证书在七天内到期会让检查失败，管理员应提前签发并替换两项 Secrets；客户端证书不随服务端的 Let's Encrypt 证书自动续期。凭据只证明持有证书，不能证明调用者的仓库身份；泄露时必须在服务端吊销或替换信任 CA，删除 GitHub Secret 本身不能撤销已复制的证书。

### 框架/插件隔离（重要）

框架代码（`packages/`、`apps/server/src/`、`apps/web/src/`）中**禁止**出现任何具体插件 ID 或插件名称。插件通过版本化契约（`provides` / `requires`）、扩展点和已注册服务被发现，输出按 `outputKind` 分派，详见 [`AGENTS.md` Framework–Plugin Isolation Rule](../AGENTS.md#framework--plugin-isolation-rule)。

### 文档同步

凡是影响框架能力的改动，都必须同步更新 [`reference/`](./reference/) 对应文档。不同步文档的 PR 视为未完成。

## 提交与 PR

### Commit message

遵循 Conventional Commits：

```
<type>(<scope>): <subject>

<body>
```

常用 type：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`。

### Pull Request

1. 从 `main` 分出一个 feature branch
2. 推送后通过 GitHub UI 开 PR，指向 `main`
3. 推送时等待 pre-push 静态检查通过，再确认 CI 全部绿；涉及数据库或 UI 的变更还需运行相应专项检查
4. PR 描述说明「为什么」与「如何验证」
5. 用户、作者或运维能察觉的改动，新增一个 changelog 片段 `docs/changelog.d/<slug>.md`（[格式](./changelog.d/README.md)，条目用英文）；不要直接修改 `docs/CHANGELOG.md`，它由发布脚本写入
6. 有破坏性变更时，在正文中标注 `BREAKING CHANGE:`，并在片段里写一条 `### Breaking`

## Release Process

发布检查的唯一操作清单是[桌面打包指南](./internals/desktop-packaging.md#release-checklist)。按以下顺序执行：

1. 在开发分支准备版本、CHANGELOG 和文档。`pnpm release:prepare <version>`（先加 `--dry-run` 看结果）设置根目录、`apps/*` 与 `packages/*` 的版本和 README 版本徽章，并把 `docs/changelog.d/` 里的片段写入 `docs/CHANGELOG.md` 的该版本小节、删除片段；它要求工作区干净，不提交。版本摘要段落和 README 的升级说明手写。根目录、`apps/*` 与 `packages/*` 的版本匹配目标 tag；插件和世界包可以独立版本化。
2. 先顺序完成本地 `pnpm check`、`pnpm test`、`pnpm test:pg`、UI/E2E 检查和 `pnpm release:preflight`，再用隔离数据完成[真实模型玩家流程](./internals/e2e-testing.md#发版前的玩家流程验收)。
3. 本地通过后推送 PR，等待 CI / PostgreSQL 集成，以及候选分支的 `Build Desktop` dry run（`publish_release=false`）通过。
4. 合并 PR，确认 `main` 的检查和准确提交，再在该提交创建并推送 annotated `v*` tag。
5. [发布工作流](../.github/workflows/release.yml) 校验不可变提交、框架版本和发布说明，构建并验证 macOS arm64 / Windows x64 产物后发布 GitHub Release。下载产物复核版本、摘要、启动和插件生命周期。

记录实际覆盖的平台与流程；构建通过不等于完成该平台的交互试玩。Release notes 必须说明当前产物未签名，macOS 产物也未公证。

桌面运行时或打包改动还要验证安装包自己的 Electron RunAsNode：校验目标与实际 Electron/Node 版本、架构、fuse 和主进程/ASAR 绑定，用它启动 SQLite 后端并确认 sqlite-vec 与内置插件可用。不能用宿主 Node 或内存后端代替；就绪、设置读写、恢复和退出都要检查。详见桌面打包指南。

### 官网部署

[`site.yml`](../.github/workflows/site.yml) 由每次非发布 CI 调用，不再独立响应 push 或 PR。它构建官网 `apps/site` 和文档站 `apps/docs`（页面在 `docs/`），并把文档站放在官网的 `docs/` 路径下。PR 只构建，不上传发布产物或部署；`main` 改动站点、文档或相关根构建/安装配置时才发布到 GitHub Pages，无关源码改动只构建。部署选择与测试范围共用一次 git diff；无法确定变更时保守选择部署，但仍限于 `main` push。具体输入列在 `scripts/ci-scope.mjs`。Actions 页面手动运行 Site 默认部署，也可关闭 `deploy` 只验证构建。

仓库设置 Settings > Pages 的 Source 需选 “GitHub Actions”。站点默认在 `https://ackness.github.io/covel/`；PR 使用 `/covel/`，其他构建按 Pages 设置读出路径并作为 `SITE_BASE` 传给 Vite，所以配置自定义域名后会自动改用 `/`。文档站读取同一个变量，路径为 `<SITE_BASE>docs/`。文档站构建时有失效链接会失败。`public/` 里的文件在代码中通过 `asset()`（`apps/site/src/links.ts`）引用，以便带上这一前缀。Site 用下面的命令并行构建两个独立目标，再把 `apps/docs/dist` 复制到 `apps/site/dist/docs`；复制前删除旧 docs 子树。Turbo 分别保存两份输出，官网缓存排除合并进去的 docs 子树。

```bash
pnpm exec turbo build --filter=@covel/site --filter=@covel/docs --concurrency=2
```

Site 的独立 Turbo 缓存按内容复用：输入覆盖各自源码与配置、`docs/**`、`SITE_BASE`、`VITE_*`、构建环境文件、根安装配置、lockfile 和工具链。`docs/**` 只影响文档目标，无关框架源码不影响这两个目标。GitHub 的 PR 缓存仍限于 PR ref，部署不能恢复它们。部署只消费同次 Site 任务按当前输入构建或恢复、重新合并并上传的产物，不下载其他工作流的发布产物。

### 模型资料快照

内置的 LiteLLM 模型表（`packages/ai-provider/data/model-db.json`，由 `model-db-source.json` 固定到具体提交）决定未在 `llm.toml` 或设置中填写上限的模型的上下文窗口、输出上限与价格。[`update-model-db.yml`](../.github/workflows/update-model-db.yml) 每周一把它固定到 LiteLLM 最新修改模型表的提交，重新生成快照和各模型名称得到哪些思考档位的记录（`tests/__snapshots__/reasoning-characterization.snap.txt`）并跑 `@covel/ai-provider` 测试，然后在 `chore/update-model-db` 分支开启或刷新 PR，不直接推送 `main`；也可在 Actions 页面手动触发。用默认 `GITHUB_TOKEN` 开的 PR 不会触发其他 workflow：配置可开 PR 的 `MODEL_DB_PR_TOKEN` secret 才会自动跑 CI，否则关闭再重开 PR 即可。默认 token 还需要在仓库设置中开启 “Allow GitHub Actions to create and approve pull requests”。手动更新运行 `pnpm --filter @covel/ai-provider update-model-db`。模型表只说明模型是否会思考；它支持哪些档位是人工维护的数据，刷新不会改动，见[档位数据](./reference/slots.md#档位数据)。

### 代码签名

当前正式发布有意使用 unsigned 产物，不需要平台签名凭据。发布说明必须披露这一点，并说明首次启动可能触发 macOS Gatekeeper 或 Windows SmartScreen 提示。未来启用签名时，需要同时更新 electron-builder 配置与发布工作流；本地签名配置见 [`guide/desktop-packaging.md`](./internals/desktop-packaging.md)。

## 报告问题

请在 [Issues](https://github.com/ackness/covel/issues) 中使用缺陷报告或功能建议表单。使用上的疑问和还没成形的想法请到 [Discussions](https://github.com/ackness/covel/discussions)。安全漏洞请按 [`SECURITY.md`](../SECURITY.md) 私下报告。

# Contributing to Covel

感谢你愿意参与 Covel！本文档描述了贡献代码、问题与文档的流程。

> 🇬🇧 [English version](./CONTRIBUTING.en.md)

> 根目录 README 见 [`../README.md`](../README.md)。

## 开发环境

- Node.js 26.x
- pnpm 12.6.0（见根目录 `package.json` 的 `packageManager`）
- 可选：Docker（用于 PostgreSQL 模式）

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # server and storage settings
cp llm.toml.example llm.toml   # 配置 LLM slot
cp .env.llm.example .env.llm   # 填写 API Key
pnpm dev                       # 同时启动前端与后端
```

每个新克隆在 `pnpm install --frozen-lockfile` 后运行一次 `pnpm hooks:install`，安装本地 Git pre-push hook；已有 pre-commit hook 保持不变。如果已有其他 pre-push hook，安装命令会拒绝覆盖，需先自行处理冲突。pre-push hook 使用 `mise exec` 选择 `mise.toml` 指定的 Node 26、pnpm 12.6 和 actionlint，因此还需安装 mise 并运行 `mise install` 准备相应工具链。

提交前检查由根目录 `.pre-commit-config.yaml` 定义；安装 pre-commit 后运行 `pre-commit install` 启用，或用 `pre-commit run --all-files` 手动检查。Oxlint 的版本固定在根 `devDependencies` 和 `pnpm-lock.yaml`，与 Prettier、类型检查一样通过 `mise exec` 使用项目工具链，不创建独立的 Node 环境。`scripts/run-with-project-node.mjs` 将选中的 Node 放在子进程 PATH 首位，确保 CLI shim 和后续命令也使用同一版本；更新配置后，已有 hook 会自动读取新配置，无需清理全局缓存。Oxlint 的规则在根目录 `.oxlintrc.jsonc`，关闭的规则各有一行说明；hook 检查改动的文件，`pnpm check` 检查整个仓库，两处都带 `--deny-warnings`，所以警告也会让检查失败。

新增文件默认上限为 3 MiB；世界画廊原图 `worlds/*/media/gallery/*.png` 单独允许 4 MiB，以保留 1536×1024 图片的无损质量。展示时优先使用配套 WebP。

### PostgreSQL 18 开发环境

先按上面的步骤创建根 `.env`，核对 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`POSTGRES_PORT` 与 `DATABASE_URL`。仅启动数据库，不需要 Docker 应用服务的 operator token：

```bash
pnpm db:up
pnpm dev:pg                    # PostgreSQL-backed API server
```

首次初始化时先确认数据库已就绪，再运行 `dev:pg`；可用 `docker compose -f docker/docker-compose.yml --env-file .env ps postgres` 查看 `healthy` 状态。需要前端时，在另一个终端运行 `pnpm dev:web`。`dev:pg` 先读取根 `.env` 做连接预检，默认检查 `DATABASE_URL` 的 host/port；未设置 URL 时使用 `127.0.0.1:POSTGRES_PORT`。更换端口时同步更新 URL；完整覆盖规则见[环境变量说明](./guide/env-registry.md#加载路径与环境差异)。

Compose 使用 PostgreSQL 18 + pgvector 0.8.6，数据库存入 `pgdata18` 卷。旧 PG17 `pgdata` 卷不会被挂载、自动迁移或删除。

`pnpm docker:build` 会构建并启动**数据库和应用**，应用采用 `commercial` 配置，还需在 `.env` 设置 `COVEL_DESKTOP_REST_TOKEN`、`COVEL_MEDIA_TOKEN_SECRET` 和 `CORS_ORIGIN`，并准备根 `llm.toml`。`appdata` 卷持久化安装及生成的用户世界与插件；模型配置仍从宿主机只读挂载。详见[Docker 配置](./guide/env-registry.md#docker-compose)。

`pnpm docker:down` 停止容器并保留数据。**`pnpm docker:down-all` 会删除当前 Compose 项目的 `pgdata18` 和 `appdata`，包括数据库及用户世界、插件**；仅在备份后明确需要清空整套环境时使用。`db:generate` / `db:studio` 是 PostgreSQL 开发维护工具，不是数据库自动升级命令，见[数据库维护](./guide/env-registry.md#数据库维护命令)。

### 首页演示媒体

先安装 FFmpeg。以下命令从仓库根运行，会更新首页视频、封面和 README 动图：

```bash
pnpm --filter @covel/web build:media
# Replace recording.mp4 with an existing source file.
node apps/web/scripts/build-media.mjs ./recording.mp4 --speed 3
```

默认依次选择 `.assets/demo.dev1.mp4`、`.assets/demo.dev0.mp4`、`.assets/images/demo.gif`；显式路径不存在时直接报错。输出为 `apps/web/public/media/demo.mp4`、`demo-poster.jpg` 和 `.assets/images/demo.gif`。全部转换完成后才替换现有素材，转换失败会保留原素材并清理临时文件；输入可以是现有输出文件。通过 `pnpm --filter @covel/web build:media` 传入的相对路径以 `apps/web/` 为基准，直接调用 Node 时以当前目录为基准。

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

安装 hook 后，每次 `git push` 都会检查本次推送中所有不同且未删除的已提交目标，包括与当前 HEAD 不同的 ref。每个目标在一次性干净克隆中运行 `pnpm install --frozen-lockfile`、`pnpm check`、本次推送可能影响的测试和 `pnpm e2e --list`；任何一步失败都会阻止推送。全部测试套件由 CI 运行。hook 运行的测试包括：分支自远端 main 分支（`origin/main`，本地从未获取过时会先获取一次）分出以来改动过的包、依赖这些包的包（`turbo test --filter=...<包名>`），以及 `turbo.json` 里 `$TURBO_ROOT$` 输入匹配到改动文件的套件——内置插件的文件会带上 plugin-loader、runtime 和 server 套件，`worlds/**`、`prompts/**` 会带上读取它们的套件。以下情况运行全部套件：改动了所有包都会读取的文件（`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`turbo.json`、`vitest.base.ts`、根目录的 `package.json` 与 `tsconfig.json`、`mise.toml`），改动了规则未覆盖的根目录文件（规则在 `scripts/lib/push-scope.mjs`），推送目标是 `main` 或 tag，或者无法确定远端 main 分支。`COVEL_PUSH_CHECK=full git push` 和 `pnpm check:push --full` 可以要求运行全部套件；`pnpm check:push --base <分支>` 让叠在其他分支上的分支以下层分支为基准。输出的最后两行说明运行了什么、哪些留给 CI。检查不复制工作区的 `.env`、`node_modules` 或 `test-results`，不会使用开发者数据库连接变量 `DATABASE_URL` / `COVEL_REQUIRE_PG_TESTS`。Turbo 读写的是仓库所有 worktree 共用的缓存（主 worktree 的 `.turbo/cache`）：被推送的提交与某次已通过的运行有相同的已跟踪输入时，任务直接回放；回放看不出的是依赖了 Git 忽略文件的结果，这一类由 CI 兜底。在一台负载较高的开发机上、Turbo 缓存为空时实测：`apps/web` 的一行改动耗时 2 分 52 秒，运行全部套件为 4 分 43 秒；其中安装、`pnpm check` 和 E2E 收集约占 85 秒。`packages/shared` 被所有包依赖，改动它会选中全部套件（4 分 22 秒）。缓存已有结果时，未改动的任务直接回放；store 和 server 套件从不缓存，现在只在改动选中它们时运行。一次推送新增的内容全是文档时，hook 只跑静态检查和读取文档的测试（`pnpm test:docs`），约半分钟；新分支以远端的 main 分支为基准。文档指 `docs/**`、根目录的 `*.md`、任意位置的 `README.md` / `README.*.md`、嵌套的 `AGENTS.md` / `CLAUDE.md`、`.claude/skills/**`、`.assets/**`、`LICENSE` 以及 issue 与 PR 模板，清单在 `scripts/lib/change-scope.mjs`。由加载器读取的 Markdown（`PLUGIN.md`、`RUNTIME.md`、`WORLD.md`、`prompts/` 下的文件）是源码，走完整流程。需要提前验证当前已提交的 HEAD 时可运行 `pnpm check:push`。

`git push` 先连接远端，再运行 hook；hook 运行期间这条连接上没有任何数据。远端、代理或 NAT 关闭空闲连接后，检查虽然通过，推送仍会失败（`git push` 以状态码 141 退出：它向已关闭的连接写入）。hook 无法让这条连接保持活动，所以做了两件事：少跑，并按 worktree 记录通过检查的提交，保留 12 小时。再次推送同一个提交会直接发送，先运行 `pnpm check:push` 再推送也一样；需要全部套件的改动，先运行 `pnpm check:push --full`，通过后再推送。在 `~/.ssh/config` 里为该主机设置 `ServerAliveInterval 30`，也能避免代理把 SSH 连接当作空闲连接。

该检查只收集 E2E 测试，不执行本次推送未改动的测试套件、PostgreSQL 集成、浏览器 smoke 或发布/打包验证；按需显式运行 `pnpm test:pg`、`pnpm e2e:smoke`、`pnpm e2e`、`pnpm build` 和发布检查，并以 CI 结果为准。

[Fallow](https://github.com/fallow-rs/fallow) 作为根开发依赖安装，替代 Knip。`deps:check` 会阻断未使用依赖、未声明依赖与无法解析的导入；`analyze` 提供完整报告，供人工核实后清理，不作为全量阻断项。`.fallowrc.jsonc` 声明文件路由、插件动态入口和手动运行的脚本；增加这类入口时同步维护配置，避免误报。工具版本遵循工作区的 7 天发布等待期。

`pnpm test:pg` 从环境或根 `.env` 读取 `DATABASE_URL`，强制执行 Store 与 Server 的 PostgreSQL 测试；数据库缺失、不可达或缺少 pgvector 都会失败。Store 和 Server 的普通测试也接收显式传入的数据库环境变量，但由于数据库状态不属于源码输入，这两组测试不复用 Turbo 缓存。其余缓存会跟随公共 TypeScript 配置失效，读取框架 prompt 的测试也跟随 `prompts/**` 失效。

`pnpm test:coverage` 顺序执行两个覆盖率入口：`test:coverage:vitest` 每次重新运行 Vitest 工作区，按各包配置在 `coverage/` 生成报告；`test:coverage:desktop` 运行全部桌面 Node 测试与自检，将各子进程的原始 V8 覆盖率写入 `apps/desktop/coverage/`，供单独分析，不混入 Vitest 百分比。CI（[`ci.yml`](../.github/workflows/ci.yml)）只对 `@covel/runtime` 强制覆盖率下限：`pnpm test:coverage:runtime` 带覆盖率运行它的测试，低于 `packages/runtime/vitest.config.ts` 里的 `thresholds` 即失败；下限比实测值低几个百分点，用来拦截下降，覆盖率上升后应随之调高。其余包的 ≥ 80% 仍是参考目标，未强制。

PR、main 和发布复用同一份 CI 检查，pre-push hook 省去的内容都在这里运行：静态检查连同可缓存的测试与构建（`verify`：除 Web、server 和 runtime 之外的全部套件），以及独立的 Web 单元测试、server 测试、PostgreSQL 与 Chromium job（smoke 之后接着跑 `pnpm e2e:extensions`，约半分钟，用同一次安装和同一份 Chromium；Chromium 下载按 Playwright 版本缓存，系统依赖每次重新安装）。server 套件最长且从不缓存，所以独占一个 runner；同一个 job 带覆盖率运行 runtime 套件并执行其下限，这是 runtime 套件在 CI 里唯一的一次运行。只改文档的变更不运行 `ci.yml`，改由 `docs.yml` 跑静态检查和 `pnpm test:docs`。文件清单就是 pre-push hook 用的那份；`scripts/tests/change-scope.test.mjs` 保证两个工作流与它一致，并在某个读取文档的测试没有列进 `test:docs` 时失败。浏览器 job 先收集完整 E2E 测试以发现失效的导入，再执行核心流程。PR 和 main 都会运行 `pnpm build`，但只读取 Turbo 缓存、不写回构建产物。Turbo 本地缓存由 `turbo.json` 的 `cacheMaxAge`（7 天）和 `cacheMaxSize`（2GB）自动淘汰，开发机上的 `.turbo/cache` 不会再无限增长；CI 用环境变量 `TURBO_CACHE_MAX_AGE` / `TURBO_CACHE_MAX_SIZE` 收紧到 2 天、500MB，因为 actions/cache 每次都会整目录恢复再保存。发布前还会执行 `pnpm release:preflight`；锁文件校验在临时元数据目录完成，不修改工作区依赖或执行安装脚本。

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
3. 推送时等待 pre-push 检查通过，再确认 CI 全部绿；涉及数据库或 UI 的变更还需运行相应专项检查
4. PR 描述说明「为什么」与「如何验证」
5. 用户、作者或运维能察觉的改动，新增一个 changelog 片段 `docs/changelog.d/<slug>.md`（[格式](./changelog.d/README.md)，条目用英文）；不要直接修改 `docs/CHANGELOG.md`，它由发布脚本写入
6. 有破坏性变更时，在正文中标注 `BREAKING CHANGE:`，并在片段里写一条 `### Breaking`

## Release Process

发布检查的唯一操作清单是[桌面打包指南](./guide/desktop-packaging.md#release-checklist)。按以下顺序执行：

1. 在开发分支准备版本、CHANGELOG 和文档。`pnpm release:prepare <version>`（先加 `--dry-run` 看结果）设置根目录、`apps/*` 与 `packages/*` 的版本和 README 版本徽章，并把 `docs/changelog.d/` 里的片段写入 `docs/CHANGELOG.md` 的该版本小节、删除片段；它要求工作区干净，不提交。版本摘要段落和 README 的升级说明手写。根目录、`apps/*` 与 `packages/*` 的版本匹配目标 tag；插件和世界包可以独立版本化。
2. 先顺序完成本地 `pnpm check`、`pnpm test`、`pnpm test:pg`、UI/E2E 检查和 `pnpm release:preflight`，再用隔离数据完成[真实模型玩家流程](./guide/e2e-testing.md#发版前的玩家流程验收)。
3. 本地通过后推送 PR，等待 CI / PostgreSQL 集成，以及候选分支的 `Build Desktop` dry run（`publish_release=false`）通过。
4. 合并 PR，确认 `main` 的检查和准确提交，再在该提交创建并推送 annotated `v*` tag。
5. [发布工作流](../.github/workflows/release.yml) 校验不可变提交、框架版本和发布说明，构建并验证 macOS arm64 / Windows x64 产物后发布 GitHub Release。下载产物复核版本、摘要、启动和插件生命周期。

记录实际覆盖的平台与流程；构建通过不等于完成该平台的交互试玩。Release notes 必须说明当前产物未签名，macOS 产物也未公证。

### 模型资料快照

内置的 LiteLLM 模型表（`packages/ai-provider/data/model-db.json`，由 `model-db-source.json` 固定到具体提交）决定未在 `llm.toml` 或设置中填写上限的模型的上下文窗口、输出上限与价格。[`update-model-db.yml`](../.github/workflows/update-model-db.yml) 每周一把它固定到 LiteLLM 最新修改模型表的提交，重新生成快照和各模型名称得到哪些思考档位的记录（`tests/__snapshots__/reasoning-characterization.snap.txt`）并跑 `@covel/ai-provider` 测试，然后在 `chore/update-model-db` 分支开启或刷新 PR，不直接推送 `main`；也可在 Actions 页面手动触发。用默认 `GITHUB_TOKEN` 开的 PR 不会触发其他 workflow：配置可开 PR 的 `MODEL_DB_PR_TOKEN` secret 才会自动跑 CI，否则关闭再重开 PR 即可。默认 token 还需要在仓库设置中开启 “Allow GitHub Actions to create and approve pull requests”。手动更新运行 `pnpm --filter @covel/ai-provider update-model-db`。模型表只说明模型是否会思考；它支持哪些档位是人工维护的数据，刷新不会改动，见[档位数据](reference/slots.md#档位数据)。

### 代码签名

当前正式发布有意使用 unsigned 产物，不需要平台签名凭据。发布说明必须披露这一点，并说明首次启动可能触发 macOS Gatekeeper 或 Windows SmartScreen 提示。未来启用签名时，需要同时更新 electron-builder 配置与发布工作流；本地签名配置见 [`guide/desktop-packaging.md`](./guide/desktop-packaging.md)。

## 报告问题

请在 [Issues](https://github.com/AcKnEsS/covel/issues) 中使用对应模板提交 bug report 或 feature request。

# Contributing to Covel

感谢你愿意参与 Covel！本文档描述了贡献代码、问题与文档的流程。

> 🇬🇧 [English version](./CONTRIBUTING.en.md)

> 根目录 README 见 [`../README.md`](../README.md)。

## 开发环境

- Node.js ≥ 26
- pnpm 11.22.0（见根目录 `package.json` 的 `packageManager`）
- 可选：Docker（用于 PostgreSQL 模式）

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # server and storage settings
cp llm.toml.example llm.toml   # 配置 LLM slot
cp .env.llm.example .env.llm   # 填写 API Key
pnpm dev                       # 同时启动前端与后端
```

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
- 单文件建议 < 400 行、硬上限 800 行
- 不可变写法，禁用裸 `any`
- 使用 Zod 做外部输入校验
- 参考 [`reference/`](./reference/) 下的领域规范

### 测试

新功能与 bug 修复都应带测试。每个 package 自带 vitest：

```bash
pnpm test                                  # 全量
pnpm --filter @covel/runtime test          # 单包
pnpm e2e                                   # Playwright 端到端
```

覆盖率目标 ≥ 80%（`pnpm test:coverage`）——当前为参考目标，CI（[`ci.yml`](../.github/workflows/ci.yml)）尚未设阈值强制拦截。

### 框架/插件隔离（重要）

框架代码（`packages/`、`apps/server/src/`、`apps/web/src/`）中**禁止**出现任何具体插件 ID 或插件名称。插件能力通过 `RuntimeManifest.capabilities` 与 `outputKind` 发现，详见 [`CLAUDE.md` Framework–Plugin Isolation Rule](../CLAUDE.md)。

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
3. 确保 CI 全部绿；`pnpm lint` 与 `pnpm test` 本地先跑过
4. PR 描述说明「为什么」与「如何验证」
5. 有破坏性变更时，在正文中标注 `BREAKING CHANGE:`

## Release Process

Covel 的发布由 Git tag 驱动。

1. 所有改动合并到 `main` 且 CI 通过
2. 将 [`CHANGELOG.md`](./CHANGELOG.md) 的 `[Unreleased]` 内容整理为 `## [<version>] - YYYY-MM-DD` 版本段落，补充升级说明
3. 将根目录与所有当前 workspace 的 `package.json` 统一为目标 SemVer，并同步 [`README.md`](../README.md) 和 [`README.zh-CN.md`](../README.zh-CN.md) 的版本徽标、Release 链接与当前版本说明。无需发布到 npm；插件 manifest 的独立版本不随 workspace 版本机械修改
4. 运行发布前检查，核对并暂存本次发布改动，再提交并打 tag：

   ```bash
   pnpm release:preflight
   RELEASE_VERSION=$(node -p "require('./package.json').version")
   # Review and stage only the release changes before committing.
   git commit -m "chore(release): v${RELEASE_VERSION}"
   git tag -a "v${RELEASE_VERSION}" -m "Covel v${RELEASE_VERSION}"
   git push origin main
   git push origin "v${RELEASE_VERSION}"
   ```

5. [`.github/workflows/release.yml`](../.github/workflows/release.yml) 将在 `v*` tag 推送时自动：
   - 校验 tag、提交 SHA、workspace 版本、CHANGELOG 与完整发布前检查
   - 构建并验证 Electron macOS arm64 `.dmg` / `.zip` 和 Windows x64 `.exe`
   - 产出未签名的 macOS 与 Windows 安装包；macOS 产物也未公证
   - 从 `docs/CHANGELOG.md` 抽取对应版本说明
   - 所有检查通过后发布或更新 GitHub Release

6. 在 Releases 页面检查正式发布页、release notes 与附件

### 代码签名

当前正式发布有意使用 unsigned 产物，不需要平台签名凭据。发布说明必须披露这一点，并说明首次启动可能触发 macOS Gatekeeper 或 Windows SmartScreen 提示。未来启用签名时，需要同时更新 electron-builder 配置与发布工作流；本地签名配置见 [`guide/desktop-packaging.md`](./guide/desktop-packaging.md)。

## 报告问题

请在 [Issues](https://github.com/AcKnEsS/covel/issues) 中使用对应模板提交 bug report 或 feature request。

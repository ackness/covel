# Contributing to Covel

感谢你愿意参与 Covel！本文档描述了贡献代码、问题与文档的流程。

> 🇬🇧 [English version](./CONTRIBUTING.en.md)

> 根目录 README 见 [`../README.md`](../README.md)。

## 开发环境

- Node.js ≥ 26
- pnpm 11.22.0（见根目录 `package.json` 的 `packageManager`）
- 可选：Docker（用于 PostgreSQL 模式）

```bash
pnpm install
cp llm.toml.example llm.toml   # 配置 LLM slot
cp .env.llm.example .env.llm   # 填写 API Key
pnpm dev                       # 同时启动前端与后端
```

### PostgreSQL 18 开发环境

Docker Compose 使用 PostgreSQL 18 + pgvector 0.8.6，并把数据写入新的
`pgdata18` 卷。原 PG17 `pgdata` 卷不会被挂载、迁移或删除；升级后第一次运行
`pnpm docker:build` 会初始化一个空的 PG18 开发数据库。

需要重建当前 PG18 开发数据库时运行以下命令。`docker:down-all` 会删除当前
Compose 项目的 `pgdata18` 卷及其中全部数据，但不会删除旧的 `pgdata` 卷：

```bash
pnpm docker:down-all
pnpm docker:build
```

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

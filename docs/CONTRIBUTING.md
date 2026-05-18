# Contributing to Covel

感谢你愿意参与 Covel！本文档描述了贡献代码、问题与文档的流程。

> 🇬🇧 [English version](./CONTRIBUTING.en.md)

> 根目录 README 见 [`../README.md`](../README.md)。

## 开发环境

- Node.js ≥ 22
- pnpm 10.33.2（见根目录 `package.json` 的 `packageManager`）
- 可选：Docker（用于 PostgreSQL 模式）

```bash
pnpm install
cp llm.toml.example llm.toml   # 配置 LLM slot
cp .env.llm.example .env.llm   # 填写 API Key
pnpm dev                       # 同时启动前端与后端
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

覆盖率目标 ≥ 80%（`pnpm test:coverage`）。

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
2. 更新 [`CHANGELOG.md`](./CHANGELOG.md) 顶部的 `[Unreleased]` 段落，迁移到新版本号
3. 统一版本号：

   ```bash
   # 所有 workspace package 版本同步（直接改 package.json 即可，无需发布到 npm）
   # 版本号遵循 semver：0.0.1-beta / 0.1.0 / 1.0.0 …
   ```

4. 运行发布前检查，提交并打 tag：

   ```bash
   pnpm release:preflight
   git commit -am "chore(release): v0.0.4"
   git tag v0.0.4
   git push origin main --tags
   ```

5. [`.github/workflows/release.yml`](../.github/workflows/release.yml) 将在 `v*` tag 推送时自动：
   - 在 macOS runner 上构建 Electron macOS arm64 `.dmg` / `.zip`
   - 从 `docs/CHANGELOG.md` 抽取对应版本说明
   - 直接发布 GitHub Release

6. 在 Releases 页面检查正式发布页、release notes 与附件

### 代码签名（可选）

- macOS：在仓库 Secrets 配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，并在 `apps/desktop/electron-builder.yml` 打开 notarize
- Windows：在 Secrets 配置 `CSC_LINK`（`.pfx`）、`CSC_KEY_PASSWORD`

无签名产物会被标记为 "unsigned"，首次运行时系统会警告。详见 [`apps/desktop/PACKAGING.md`](../apps/desktop/PACKAGING.md)。

## 报告问题

请在 [Issues](https://github.com/AcKnEsS/covel/issues) 中使用对应模板提交 bug report 或 feature request。

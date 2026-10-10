## Summary / 摘要

<!-- What this change does and why. Lead with the problem, then the fix.
     这次改动解决什么问题、怎么解决。先写问题，再写做法。 -->

## Type of change / 变更类型

- [ ] New feature / 新功能 (feat)
- [ ] Bug fix / Bug 修复 (fix)
- [ ] Refactor / 重构 (refactor)
- [ ] Documentation / 文档 (docs)
- [ ] Tests / 测试 (test)
- [ ] Tooling, CI, release / 工具链、CI、发布 (chore / ci)
- [ ] Performance / 性能 (perf)
- [ ] Breaking change / 破坏性变更 (BREAKING CHANGE)

## Breaking changes / 破坏性变更

<!-- Delete this section if nothing breaks. Covel targets the current contract only: no migrations or aliases.
     List the contracts, API shapes, or manifest fields that changed, and which development data
     (sessions, snapshots, queued jobs, worlds) must be recreated.
     没有破坏性变更就删掉本节。Covel 只支持当前契约，不做迁移和别名。
     列出变化的契约、API 结构或 manifest 字段，以及哪些开发数据（会话、快照、排队作业、世界）需要重建。 -->

## Verification / 验证方式

<!-- Tick what actually ran and note what was skipped and why. The pre-push hook covers
     `pnpm check`, `pnpm test`, and `pnpm e2e --list` in a clean checkout
     (for a documentation-only push: `pnpm check` and `pnpm test:docs`).
     只勾选真正跑过的项，没跑的写明原因。pre-push hook 会在干净检出里跑
     `pnpm check`、`pnpm test` 和 `pnpm e2e --list`
     （只改文档的推送：`pnpm check` 和 `pnpm test:docs`）。 -->

- [ ] `pnpm check` <!-- static gate: types, Oxlint, package boundaries, deps, manifests, i18n, workflows -->
- [ ] `pnpm test`
- [ ] `pnpm test:pg` <!-- store or database changes / 改动存储或数据库时 -->
- [ ] `pnpm e2e:smoke` / `pnpm e2e:extensions` / `pnpm e2e` <!-- UI or end-to-end flow changes / 改动界面或端到端流程时 -->
- [ ] `pnpm validate:plugin` / `pnpm validate:world` <!-- plugin or world package changes / 改动插件或世界包时 -->
- [ ] `pnpm e2e:verify` <!-- prompt, model-routing, or runtime behavior changes; needs .env.llm / 改动提示词、模型路由或 runtime 行为时 -->
- [ ] Manual check / 手动验证: …

**Not verified / 未验证:** <!-- What this PR does not prove, and the risk. / 本 PR 没有覆盖到的部分及其风险 -->

## Related issue / context / 关联

<!-- Closes #xxx, earlier PRs, design notes. / Closes #xxx、前序 PR、设计说明 -->

## Docs sync / 文档同步

<!-- The mapping from change type to page is in AGENTS.md "Documentation sync". Write "n/a" where nothing applies.
     改动类型与文档页的对应关系见 AGENTS.md 的 "Documentation sync"。不适用的写 n/a。 -->

- [ ] `docs/reference/` updated for changed contracts, APIs, tools, or protocol / 契约、API、工具或协议有变化时已更新 `docs/reference/`
- [ ] Guides and both READMEs updated; pages with an `.en.md` sibling changed together / 已更新相关指南和中英文 README；有 `.en.md` 的页面两份同步修改
- [ ] `docs/CHANGELOG.md` has an entry under `[Unreleased]` for user-visible changes / 用户可见的改动已写入 `docs/CHANGELOG.md` 的 `[Unreleased]`
- [ ] `AGENTS.md` updated if packages, root scripts, or conventions changed / 包结构、根脚本或约定有变化时已更新 `AGENTS.md`

<!-- New assets: 3 MiB per file; worlds/*/media/gallery/*.png originals: 4 MiB. Prefer WebP for display. -->

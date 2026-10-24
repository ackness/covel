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
     `pnpm check` in a clean checkout; docs-only adds `pnpm test:docs:packages`.
     `pnpm check:push` adds affected suites for source changes. Full requests/main/tags override docs-only;
     affected results are reused only for the same commit and comparison base; cache eviction must use
     the same coverage rule and retain unrelated bases/docs results. CI owns all verification:
     docs-only runs documentation tests after check; source, unknown scope and releases run all suites.
     Non-release CI also requires one Site/docs build, including on docs-only changes;
     the other build excludes those targets. Site uses parallel Turbo tasks with content-addressed
     outputs; cache changes need hit/miss and input-invalidation evidence (docs, SITE_BASE, config).
     PR cache isolation must remain intact. Release/explicit-commit runs only restore caches
     and disable setup-node's pnpm cache, including explicit-commit Site builds. Explicit cache saves
     require success, an authorized source, an exact-key miss, and the restore step's original key.
     Control-script sparse checkouts must retain required imports and comparison history.
     Desktop uses bundled Electron RunAsNode; verify target/actual versions, fuses and ASAR binding.
     Static checks and source tests/build run independently with separate cache namespaces;
     both must feed Verification. Preserve docs-only and release selection when splitting jobs.
     Missing or skipped required jobs cannot pass Verification or All checks pass.
     Tests reading files outside their package must declare those Turbo inputs.
     只勾选真正跑过的项，没跑的写明原因。pre-push hook 在干净检出里跑 `pnpm check`，
     纯文档另跑 `pnpm test:docs:packages`；`pnpm check:push` 为源码改动加上受影响的套件。
     显式全量检查及 main/tag 推送优先于纯文档短路径；受影响测试结果只在提交和比较基准相同时复用。
     缓存淘汰使用同一覆盖规则，保留不同基线及互不覆盖的文档结果。
     CI 统一负责验证：纯文档跑静态与文档检查，源码、未知范围和发布跑完整套件。
     非发布 CI（纯文档也包括）必须通过一次官网/文档站构建，其余构建排除这两个目标；
     Site 用 Turbo 并行构建并按内容复用产物；缓存改动需记录命中、未命中及输入失效验证（文档、SITE_BASE、配置）。
     PR 缓存隔离保持不变。发布和显式 commit 只恢复缓存，并关闭 setup-node 的 pnpm 缓存，
     包括显式 commit 的 Site 构建。显式保存须满足任务成功、来源获准、精确键未命中，并使用恢复步骤的原始键。
     控制脚本的稀疏检出保留所需导入及比较历史。桌面使用随包 Electron RunAsNode；核对目标/实际版本、fuse 和 ASAR 绑定。
     静态检查与源码测试、构建独立并行并使用不同缓存命名空间，均须纳入 Verification；
     拆分任务时保留纯文档和发布范围选择。必需任务缺失或跳过时，Verification 和 All checks pass 不得通过。
     测试读取包外文件时，必须声明对应的 Turbo 输入。 -->

- [ ] `pnpm check` <!-- static gate: types, Oxlint, package boundaries, deps, manifests, i18n, changelog fragments, workflows -->
- [ ] Tests of the changed packages (`pnpm check:push`, or `pnpm --filter <pkg> test`) / 改动包的测试
- [ ] `pnpm test` <!-- every suite; CI runs it / 全部测试，CI 会运行 -->
- [ ] `pnpm test:pg` <!-- store or database changes / 改动存储或数据库时 -->
- [ ] `pnpm e2e:smoke` / `pnpm e2e:extensions` / `pnpm e2e` <!-- UI or end-to-end flow changes / 改动界面或端到端流程时 -->
- [ ] `pnpm validate:plugin` / `pnpm validate:world` <!-- plugin or world package changes / 改动插件或世界包时 -->
- [ ] `pnpm e2e:verify` <!-- prompt, model-routing, or runtime behavior changes; needs .env.llm / 改动提示词、模型路由或 runtime 行为时 -->
- [ ] Packaged desktop runtime and lifecycle / 安装包自己的 Electron RunAsNode、SQLite、插件加载、设置读写、恢复与退出 <!-- runtime/packaging changes; record actual OS/arch / 运行时或打包改动，注明实际验证的平台和架构 -->
- [ ] macOS ZIP: actual packaged GUI, preload version, world/session-prep flow, reload and process-group exit / macOS ZIP：实际应用与 preload 版本、世界与开局流程、刷新及进程组退出 <!-- requires native macOS arm64 GUI; does not verify Gatekeeper, DMG installation or native window visibility / 需要原生 macOS arm64 GUI；不验证 Gatekeeper、DMG 安装或原生窗口可见性 -->
- [ ] Windows ZIP and self-extracting EXE: native preparation feedback, visible app window, world/session-prep flow, reload, extracted RunAsNode backend, size evidence and process-tree exit / Windows 实际分发文件：原生准备提示、可见窗口、世界与开局流程、刷新、解压后的 RunAsNode 后端、体积证据及进程树退出 <!-- needs interactive Windows; workflow code or renderer screenshots alone are not proof / 需要交互式 Windows；工作流代码或渲染器截图不能代替 -->
- [ ] Manual check / 手动验证: …

**Not verified / 未验证:** <!-- What this PR does not prove, and the risk. / 本 PR 没有覆盖到的部分及其风险 -->

## Related issue / context / 关联

<!-- Closes #xxx, earlier PRs, design notes. / Closes #xxx、前序 PR、设计说明 -->

## Docs sync / 文档同步

<!-- The mapping from change type to page is in AGENTS.md "Documentation sync". Write "n/a" where nothing applies.
     改动类型与文档页的对应关系见 AGENTS.md 的 "Documentation sync"。不适用的写 n/a。 -->

- [ ] `docs/reference/` updated for changed contracts, APIs, tools, or protocol / 契约、API、工具或协议有变化时已更新 `docs/reference/`
- [ ] Guides and both READMEs updated; pages with an `.en.md` sibling changed together / 已更新相关指南和中英文 README；有 `.en.md` 的页面两份同步修改
- [ ] A changelog fragment `docs/changelog.d/<slug>.md` for user-visible changes; `docs/CHANGELOG.md` is not edited / 用户可见的改动已新增 `docs/changelog.d/<slug>.md`，不直接改 `docs/CHANGELOG.md`
- [ ] `AGENTS.md` updated if packages, root scripts, or conventions changed / 包结构、根脚本或约定有变化时已更新 `AGENTS.md`

<!-- New assets: 3 MiB per file; the README demo GIF: 6 MiB; worlds/*/media/gallery/*.png originals: 4 MiB, each with a WebP of the same name. Portraits and scenes are WebP only. -->

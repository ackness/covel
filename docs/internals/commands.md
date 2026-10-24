# 命令

这一页列出仓库根目录下不那么常用的命令，以及 Git 钩子和 CI 各自检查什么。它写给改 Covel 源码的贡献者。每天都用的命令（`pnpm dev`、`pnpm check`、`pnpm test` 等）在根目录的 [`AGENTS.md`](../../AGENTS.md) 里。

这里的每条命令都应该照着写的样子能运行。改了某个根脚本或它的参数，就重新跑一遍，并在同一次改动里修正这一页。

## Dev and build

```bash
pnpm dev:electron     # desktop shell in development
pnpm --filter @covel/site dev    # the showcase website (apps/site) on port 5174
pnpm --filter @covel/site build  # its static build → apps/site/dist/
pnpm --filter @covel/docs dev    # the documentation site (apps/docs, pages in docs) on port 5175
pnpm --filter @covel/docs build  # its static build → apps/docs/dist/; a dead link fails it
pnpm exec turbo build --filter=@covel/site --filter=@covel/docs --concurrency=2 # parallel, cached site builds
pnpm build            # all Turbo build targets
pnpm build:electron   # production desktop installer → release/
pnpm format           # Prettier
pnpm clean            # remove build output of every package (turbo clean)
pnpm db:up            # start the PostgreSQL container only (needed before dev:pg / test:pg)
pnpm docker:up        # SQLite Compose stack (app only; docker/docker-compose.sqlite.yml)
pnpm docker:build     # the same, rebuilding the image first
pnpm docker:down      # stop the stack, keep the volume
pnpm docker:down-all  # stop the stack and DELETE the volume
pnpm docker:logs      # follow the stack's logs
pnpm docker:pg:up     # PostgreSQL Compose stack (postgres + app; docker/docker-compose.yml)
pnpm docker:pg:build  # the same, rebuilding the image first
pnpm docker:pg:down   # stop the stack, keep the volumes
pnpm docker:pg:down-all  # stop the stack and DELETE the volumes
pnpm docker:pg:logs   # follow the stack's logs
pnpm db:generate      # Drizzle migration generation for the server
pnpm db:studio        # Drizzle Studio
```

> [!CAUTION]
> `pnpm docker:down-all` 和 `pnpm docker:pg:down-all` 会删除数据卷，里面的数据库和应用数据一起消失。只想停掉容器时用 `pnpm docker:down` / `pnpm docker:pg:down`。

## Tests

```bash
pnpm test:coverage:runtime  # @covel/runtime tests with coverage; fails under the floor in its vitest.config.ts (CI runs it)
pnpm test:coverage          # Vitest workspaces plus the desktop Node tests, reports under each package's coverage/
pnpm e2e                    # all Playwright specs
pnpm e2e:ui                 # the same in the Playwright UI
pnpm e2e:extensions   # Playwright acceptance for a community plugin in an isolated home
pnpm e2e:verify       # API-driven real-LLM plugin harness against a running server (its keys come from .env.llm
                      # or the environment); uses the configured models, --slot overrides the story slot
pnpm e2e:replay       # replay the scripted sessions under tests/llm-replay/ without a model, each on a test
                      # server of its own, from a recording made on this machine (not committed); --record
                      # [session] records them first, against DEFAULT_BASE_URL with DEFAULT_API_KEY (or
                      # --upstream <origin>)
pnpm llm:replay       # record-and-replay proxy in front of a model endpoint, for repeating a scripted
                      # session without model calls: pnpm llm:replay --mode record --upstream <origin>
                      # --fixtures <dir>, then --mode replay --fixtures <dir>
pnpm llm:replay:diff  # pnpm llm:replay:diff <a.requests> <b.requests> shows where two runs differ
pnpm prompt:prefix    # per runtime of a recorded session: the size of each turn's first model request, how
                      # much of it repeats the previous turn's from the start (the part a provider's prompt
                      # cache can serve), and where the two first differ: pnpm prompt:prefix <covel.db>
                      # [--session <id>] [--show <runtimeId>] [--json]
pnpm test:runtime     # standalone runtime harness CLI (packages/test-runtime)
pnpm test:plugin-lifecycle  # install, authorize, run, and remove a community ZIP through the real API
pnpm test:tabletop-plugin   # the same for tabletop-rules packed under a different plugin ID
pnpm pack:test-plugin       # write the ZIP test:plugin-lifecycle uses to test-results/
pnpm pack:tabletop-plugin   # write the ZIP test:tabletop-plugin uses to test-results/
```

延伸阅读：

- 浏览器测试怎么写、怎么跑：[`e2e-testing.md`](./e2e-testing.md)。
- `e2e:verify`、`e2e:replay`、`llm:replay` 的参数和输出：[用真实模型验证](../ship/real-model.md)。
- `prompt:prefix` 报告里的数字是什么意思：[提示词结构](../reference/prompt-structure.md)。

## Authoring and packaging

```bash
pnpm describe:authoring  # what a world may contain for the scanned plugins: files, data contracts
                      # with the path each file goes to and an example, plugin IDs and settings
                      # (--json, --check validates plugin examples, --plugins <dir>)
pnpm validate:collection  # static check of a covel-collection.yaml directory
pnpm create-collection    # scaffold a collection: pnpm create-collection <id> [dir]
pnpm pack:collection      # zip a collection for offline import: pnpm pack:collection <dir> [out.zip]
pnpm i18n             # translation tooling for a plugin or world directory: status, extract,
                      # translate (configured model; --to <dir> keeps a plugin's translation
                      # outside its package), lock
pnpm i18n:add         # add a UI locale to the web app (apps/web/src/i18n/locales/README.md)
```

`pnpm create-plugin <name> [-t dir] [-r a:function,b:agent]` 从 `templates/` 生成一个插件。默认生成到用户插件目录；加 `--with-tools` 时生成到仓库的 `plugins/` 下，这个选项不能和 `-t`、`-r` 一起用。

延伸阅读：合集见[合集](../ship/collections.md)，翻译工具见 [i18n](../reference/i18n.md)。

## Individual checks

`pnpm check` 会把下面这些全跑一遍。反复修改时可以只跑其中一个。

```bash
pnpm check:i18n       # web + plugin i18n coverage + plugin READMEs; tool definitions are English;
                      # Chinese text in framework source only in recorded files; every label and
                      # text of a bundled plugin has a current Chinese translation;
                      # every t() fallback in web code equals the en-US catalog text
pnpm check:prompts    # plugin and template prompts are English; each *.zh.md variant matches its English prompt;
                      # it also prints style and structure warnings, which do not fail it
pnpm prompts:lock     # record an English / *.zh.md pair after both languages changed
pnpm check:boundaries # public entry points, declared deps, package direction, unused exports
pnpm deps:check       # Fallow: unused/unlisted deps and unresolved imports (.fallowrc.jsonc)
pnpm analyze          # Fallow report: dead code, duplication, complexity; exits non-zero
                      # while findings remain, so it is a report, not a gate
pnpm check:push --full  # every suite; --base <ref> measures from another branch
```

`pnpm analyze` 不在 `pnpm check` 里，它只是一份报告。提示词的写法规则见[提示词风格](../plugins/prompt-style.md)。

`pnpm check` 还包含这几项，同样可以单独运行：

```bash
pnpm check:oxlint     # Oxlint; a warning fails it
pnpm check:manifests  # pnpm validate:plugin on every bundled plugin
pnpm check:schemas    # the generated schema reference matches the Zod schemas (fix with pnpm schemas:generate)
pnpm check:changelog  # the fragments in docs/changelog.d/ are well formed
pnpm check:scripts    # scripts/tests/*.test.mjs under node --test
pnpm check:workflows  # actionlint on .github/workflows/
```

`check:scripts` 的 `ui-literal-baseline.test.mjs` 按文件统计 `apps/web/src` 的 JSX 文字和 `title`、`placeholder`、`aria-label`、`alt`、`label` 等文字属性。只计含中日韩文字或 English 单词的字面量；跳过 `/debug`、测试、stories 和语言 catalog，不计类名、id、URL 或 `t()` 的参数。检测器顶部列出完整规则。新文件的数量必须为零，已有文件不能超过 `scripts/tests/ui-literal-baseline.json` 的记录；减少或删除后也会失败，要求下调基线。

```bash
node --test scripts/tests/ui-literal-baseline.test.mjs
node scripts/tests/ui-literal-baseline.test.mjs --update
```

第一条命令通过时报告 5 个测试通过。第二条只接受数量减少，写入基线并报告 `Updated UI literal baseline (counts can only decrease).`；它不能用来接受新增文字。

服务端的 `instruction-language.test.ts` 固定 `COVEL_INSTRUCTION_LOCALE=en`，加载 Emberback 的 English 会话数据，为每个内置 runtime 选择正文并组装 context，不调用模型。它检查正文、固定扩展段、框架模板和组装后的指令；世界内容在组装前排除，不会连同数据块的框架说明一起被忽略。

```bash
pnpm --filter @covel/server exec vitest run tests/bootstrap/instruction-language.test.ts --maxWorkers=2
```

通过时报告 3 个测试通过。发现中日韩指令时，错误列出来源和行号；修正文或缺失的 English 模板，不增加例外。

`check:scripts` 还检查 `apps/*/src`、`packages/*/src` 和插件代码里的兼容措辞，跳过测试和归档。`legacy`、`compat`、`compatible`、`compatibility`、`backward(s)`、`old format`、`old decoder` 必须在同一行或上一行有 `ponytail:`，并同步[限制清单](./technical-debt.md)。只有少数当前 API 或领域术语可以写进 `scripts/tests/compat-wording.test.mjs` 的文件白名单，每项都要说明原因；过时分支应删除，描述当前行为的注释应改写。

## Release

```bash
pnpm changelog:release  # at release: pnpm changelog:release <version> [--date YYYY-MM-DD] moves the
                      # fragments into docs/CHANGELOG.md and deletes them (docs/changelog.d/README.md)
pnpm release:prepare  # pnpm release:prepare <version> [--dry-run] [--date YYYY-MM-DD]: sets the version in
                      # the root, apps/* and packages/* manifests and both README badges, then runs the
                      # changelog assembly; refuses a lower version or a dirty tree; no commit or tag
pnpm release:preflight  # static pre-tag gate: lockfile, imports, plugin/world/prompt structure
```

完整的发版清单在 [`desktop-packaging.md`](./desktop-packaging.md#release-checklist)。

## Git hooks and CI scope

一次改动会经过三道检查：提交时、推送时、拉取请求上。

| 什么时候               | 跑什么                                                                 | 不跑什么                     |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| 提交（pre-commit）     | 对改动的文件跑 Prettier 和 Oxlint                                      | 类型检查、测试               |
| 推送（pre-push，可选） | 在干净检出里安装依赖，跑 `pnpm check`；纯文档另跑文档测试              | 源码的测试套件               |
| `pnpm check:push`      | 和推送钩子一样，再加上受影响的包的测试和 `pnpm e2e --list`             | 不受影响的包                 |
| 拉取请求（CI）         | `pnpm check` 和官网/文档站构建；纯文档跑文档测试，其余跑全部测试和构建 | 纯文档不跑完整套件和其他构建 |

### 提交和推送时

- pre-commit 的配置在 `.pre-commit-config.yaml`。Oxlint 的规则在 `.oxlintrc.jsonc`，和 `pnpm check` 一样带 `--deny-warnings`，一条警告就算失败。它不做类型检查，类型检查由 `pnpm check` 做。
- `pnpm hooks:install` 安装 pre-push 钩子。它对每个被推送的提交做一次干净检出，安装依赖，再跑 `pnpm check`。源码推送不跑测试套件；纯文档推送另跑下述文档测试。CI 在源码拉取请求上并行跑所有测试，`main` 只接受拉取请求。
- `pnpm check:push` 用同样的方式检查 HEAD，并加上这次改动可能影响到的部分：自远端主分支以来改过的包、依赖它们的包的测试，以及 `pnpm e2e --list`。
- `COVEL_PUSH_CHECK=affected git push` 让钩子也这样做。

### 什么时候会跑全部测试

有的测试会读自己包以外的文件。`turbo.json` 里它的 `$TURBO_ROOT$` 输入写到了哪个文件，那个文件一改它就会跑，所以这些输入要保持准确。

读取文档的测试也遵守这条规则：shared 的测试跟踪环境变量参考页，runtime 跟踪 Hook 参考页，plugin-loader 跟踪插件指南和 create-plugin skill。源码和文档混合修改时，相关测试缓存会失效，不必把同一组文档测试再跑一遍。

下面任何一种情况，所有测试都会跑：

- 改动碰到了 lockfile、`turbo.json`、`vitest.base.ts`、根目录的 `package.json` 或 `tsconfig.json`。
- 改动碰到了一个没有任何规则覆盖的根目录文件（规则在 `scripts/lib/push-scope.mjs`）。
- 推送到 `main`，或者推送一个标签。
- 不知道远端主分支在哪里。
- 你主动要求：`COVEL_PUSH_CHECK=full git push` 或 `pnpm check:push --full`。

显式要求全部测试、推送 `main` 或 tag 时，纯文档也运行全部套件和 E2E 收集。

检出使用各个 worktree 共享的 Turbo 缓存，所以同样输入下跑过的任务会直接重放结果。通过检查的提交记录保留 12 小时，只在记录覆盖本次要求时跳过重复检查。受影响测试还要求实际比较基准相同：`--base` 缩小范围的结果不能代替从远端 main 起算的检查，也不能代替纯文档检查；完整测试记录可覆盖所有范围。新记录只淘汰它确实覆盖的旧记录，同一提交的不同基线和文档检查可以并存。

### 拉取请求上

CI（`.github/workflows/ci.yml`）统一处理文档、源码和混合改动，始终运行完整的 `pnpm check`。纯文档另跑文档测试；源码、无法确定范围的改动和发布运行全部测试。Web 单元测试、带 runtime 覆盖率下限的服务端测试、PostgreSQL 集成和浏览器冒烟测试仍在并行任务里。每次非发布 CI 调用 Site 构建官网和文档站一次；完整检查的其余构建排除这两个目标，独立的 `pnpm build` 不变。发布跳过 Site，运行 release preflight，并由平台打包任务构建。详见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

Site 用上面的 Turbo 命令并行运行两个独立构建；输入相同时直接恢复 `dist/`，必需任务仍要成功。输入包括站点配置、`docs/**`、`SITE_BASE`、构建环境文件、lockfile 和工具链；复制文档输出到官网的步骤在缓存之后进行。各任务只恢复一次缓存；普通 PR/main 运行在任务成功且精确键未命中时，用恢复步骤返回的原始键保存，PR 缓存保持 GitHub 的 ref 隔离。发布和显式 commit 请求的 Turbo、Electron 和 Chromium 缓存仅恢复，setup-node 的 pnpm 缓存关闭；显式 commit 的 Site 构建也遵守这一规则。桌面后端使用随包 Electron RunAsNode，不再下载或缓存独立 Node。Electron 缓存按 OS、架构和 lockfile 区分；发布未命中时重新下载且不保存。范围选择对发布和显式 commit 请求使用浅检出，因为它们不需要 diff；PR/main 保留比较所需的完整提交与树历史。控制脚本任务使用稀疏检出和 blob 过滤，不展开无关工作树内容。

`main` 只接受拉取请求（`Protect main` 规则集：不能直接推送、强制推送或删除）。CI 的 `Verification` 汇总所选任务，包括非发布 CI 的 Site；必需任务缺失、跳过、失败或取消都不能通过。`.github/workflows/gate.yml` 提供每个拉取请求都有的 `All checks pass`：它要求 `Verification` 成功，也保留其他检查的失败。重跑失败检查之后，也要重跑这一项。

### Documentation-only changes

纯文档改动走短路径：推送钩子和 `ci.yml` 都运行 `pnpm check`，再运行 `pnpm test:docs:packages`；CI 还通过 Site 构建官网和文档站。文档引用与技术债台账的脚本测试已在 `check:scripts` 中运行，不再重复。文档测试按包合并文件参数，同一包只启动一次测试 runner；包括 SDK README 与声明的 Zod peer 版本和导出子路径的同步检查。独立运行 `pnpm test:docs` 仍包含包测试和这两组脚本测试。检查历史提交时，推送钩子使用该提交实际提供的命令。

算作文档的文件（规则在 `scripts/lib/change-scope.mjs`）：

- `docs/**`
- 根目录下的 `*.md`
- 任何位置的 `README.md` / `README.*.md`
- 子目录里的 `AGENTS.md` / `CLAUDE.md`
- `.claude/skills/**`
- `.assets/**`
- `LICENSE`
- issue 和拉取请求模板

要注意的几点：

- 被加载器读取的 Markdown 是源码，不算文档：`PLUGIN.md`、`RUNTIME.md`、`WORLD.md` 和 `prompts/` 下的文件。
- 变更日志片段（`docs/changelog.d/` 下的文件）算文档。
- 读取文档的包测试必须写进根目录的 `test:docs:packages` 脚本，否则 `scripts/tests/change-scope.test.mjs` 会失败。

## Tailwind diagnostics

检查 Tailwind 类名时，通过 `apps/web/scripts/check-tailwind-canonical.mjs` 运行。

> [!WARNING]
> 不要给 `tailwind-lint` 加 `--fix`。早期版本曾把普通的 TypeScript 标识符当成类名改掉，把代码改坏。脚本保持只读，并过滤 `cssConflict` 诊断。

Tailwind 里带数字的标准工具类依赖默认的 `--spacing` 刻度。想全局覆盖这个变量之前，先检查那些尺寸写死的布局会不会跟着变。

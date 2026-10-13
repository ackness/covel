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
pnpm build            # all Turbo build targets
pnpm build:electron   # production desktop installer → release/
pnpm format           # Prettier
pnpm clean            # remove build output of every package (turbo clean)
pnpm db:up            # start the PostgreSQL container only (needed before dev:pg / test:pg)
pnpm docker:up        # Compose stack (postgres + app)
pnpm docker:build     # the same, rebuilding the image first
pnpm docker:down      # stop the stack, keep the volumes
pnpm docker:down-all  # stop the stack and DELETE the volumes
pnpm docker:logs      # follow the stack's logs
pnpm db:generate      # Drizzle migration generation for the server
pnpm db:studio        # Drizzle Studio
```

> [!CAUTION]
> `pnpm docker:down-all` 会删除数据卷，里面的数据库和应用数据一起消失。只想停掉容器时用 `pnpm docker:down`。

## Tests

```bash
pnpm test:coverage:runtime  # @covel/runtime tests with coverage; fails under the floor in its vitest.config.ts (CI runs it)
pnpm test:coverage          # Vitest workspaces plus the desktop Node tests, reports under each package's coverage/
pnpm e2e                    # all Playwright specs
pnpm e2e:ui                 # the same in the Playwright UI
pnpm e2e:extensions   # Playwright acceptance for a community plugin in an isolated home
pnpm e2e:verify       # API-driven real-LLM plugin harness against a running server (its keys come from .env.llm
                      # or the environment); uses the configured models, --slot overrides the story slot
pnpm e2e:replay       # replay the scripted sessions recorded under tests/llm-replay/ without a model, each on a
                      # test server of its own; --record [session] records them again after a world, plugin,
                      # prompt or model change, against DEFAULT_BASE_URL with DEFAULT_API_KEY (or
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
pnpm check:boundaries # workspace public entry points, declared deps, package direction
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

| 什么时候               | 跑什么                                                     | 不跑什么       |
| ---------------------- | ---------------------------------------------------------- | -------------- |
| 提交（pre-commit）     | 对改动的文件跑 Prettier 和 Oxlint                          | 类型检查、测试 |
| 推送（pre-push，可选） | 在一份干净的检出里安装依赖，然后跑 `pnpm check`            | 任何测试       |
| `pnpm check:push`      | 和推送钩子一样，再加上受影响的包的测试和 `pnpm e2e --list` | 不受影响的包   |
| 拉取请求（CI）         | `pnpm check`、所有测试、构建                               | 无             |

### 提交和推送时

- pre-commit 的配置在 `.pre-commit-config.yaml`。Oxlint 的规则在 `.oxlintrc.jsonc`，和 `pnpm check` 一样带 `--deny-warnings`，一条警告就算失败。它不做类型检查，类型检查由 `pnpm check` 做。
- `pnpm hooks:install` 安装 pre-push 钩子。它对每个被推送的提交做一次干净的检出，安装依赖，再跑 `pnpm check`。它不跑测试：CI 会在拉取请求上并行跑所有测试，而 `main` 只接受拉取请求。
- `pnpm check:push` 用同样的方式检查 HEAD，并加上这次改动可能影响到的部分：自远端主分支以来改过的包、依赖它们的包的测试，以及 `pnpm e2e --list`。
- `COVEL_PUSH_CHECK=affected git push` 让钩子也这样做。

### 什么时候会跑全部测试

有的测试会读自己包以外的文件。`turbo.json` 里它的 `$TURBO_ROOT$` 输入写到了哪个文件，那个文件一改它就会跑，所以这些输入要保持准确。

下面任何一种情况，所有测试都会跑：

- 改动碰到了 lockfile、`turbo.json`、`vitest.base.ts`、根目录的 `package.json` 或 `tsconfig.json`。
- 改动碰到了一个没有任何规则覆盖的根目录文件（规则在 `scripts/lib/push-scope.mjs`）。
- 推送到 `main`，或者推送一个标签。
- 不知道远端主分支在哪里。
- 你主动要求：`COVEL_PUSH_CHECK=full git push` 或 `pnpm check:push --full`。

检出使用各个 worktree 共享的 Turbo 缓存，所以同样输入下跑过的任务会直接重放结果。一个通过了检查的提交会被记住 12 小时，这期间重复推送不会再检查。

### 拉取请求上

CI（`.github/workflows/ci.yml`）跑全部内容：`pnpm check`、每一组测试和构建。Web 单元测试、带 runtime 覆盖率下限的服务端测试、PostgreSQL 集成测试和浏览器冒烟测试分在并行的任务里。详见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

`main` 只接受拉取请求（`Protect main` 规则集：不能直接推送、强制推送或删除）。CI、Docs 和 Site 三个工作流各自只在自己负责的路径变化时运行，所以 `.github/workflows/gate.yml` 提供了每个拉取请求都有的那一项检查：`All checks pass`。它等这个提交上的其他检查全部结束，只要有一项失败它就失败。重跑了某项失败的检查之后，也要重跑这一项。

### Documentation-only changes

只改文档的改动走一条短路径：推送钩子和 `.github/workflows/docs.yml` 都只跑 `pnpm check` 和 `pnpm test:docs`，`ci.yml` 不运行。

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
- 读取文档的测试必须写进根目录的 `test:docs` 脚本，否则 `scripts/tests/change-scope.test.mjs` 会失败。

## Tailwind diagnostics

检查 Tailwind 类名时，通过 `apps/web/scripts/check-tailwind-canonical.mjs` 运行。

> [!WARNING]
> 不要给 `tailwind-lint` 加 `--fix`。v0.12.1 会把普通的 TypeScript 标识符当成类名改掉，把代码改坏。只用它来读结果。

Tailwind 里带数字的标准工具类依赖默认的 `--spacing` 刻度。想全局覆盖这个变量之前，先检查那些尺寸写死的布局会不会跟着变。

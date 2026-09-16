# Covel 浏览器 E2E 测试指南

本文档说明当前保留的本地浏览器 E2E 路径。Docker 只负责 PostgreSQL
开发栈，不再维护单独的 E2E Docker compose。

## 发版前的玩家流程验收

先完成本地验证，再推送提交触发远端检查。远端 CI 用于复核和补充 Windows、macOS 等
平台差异；本地已知失败应先修复。顺序运行 `pnpm lint`、`pnpm test`、`pnpm e2e`，
避免共享构建目录的任务同时运行。发布前还需通过 `pnpm release:preflight`。

框架发布标签应与根目录、`apps/` 和 `packages/` 的包版本一致；插件与世界包可以独立
维护版本。页面与桌面 preload 从应用包读取版本，避免在翻译或运行时代码中另写版本常量。

涉及游玩或插件生命周期的改动，要在隔离数据目录中使用正式构建和真实模型验证玩家流程：

- 从选择世界、配置模型到创角提交，非法输入被拒绝后仍能修改和继续。
- 连续进行多个回合，检查正文、快捷回复、侧栏和自由输入；覆盖桌面和窄屏布局。
- 中断、失败、刷新和重试后能继续操作，已完成剧情不重复提交，回合数不重复增加。
- 保存后重启，恢复人物、故事、插件数据和设置，并再完成一个回合。
- 第三方插件以独立 ID 的 ZIP 安装，验证授权、拒绝、重复安装、启用、卸载和重新安装；
  确认已有存档可继续使用，确定性结算不会因重试或重启而重复执行。

记录实际模型、构建版本、流程结果和未覆盖的边界。默认 E2E 中跳过的真实模型用例不能
算作真实模型验证，接口返回成功也不能代替页面上的完整流程。最终发布后，再下载产物
核对版本、资源和启动结果。

## 快速开始

```bash
pnpm install
pnpm e2e
```

这组命令会运行 `tests/e2e/` 下全部 Chromium spec。只想跑一个文件或一个
测试名称时，直接把参数传给 Playwright：

```bash
pnpm exec playwright test tests/e2e/game-session.spec.ts
pnpm exec playwright test tests/e2e/game-session.spec.ts --grep "restore"
pnpm exec playwright test --project=chromium tests/e2e/i18n.spec.ts
```

默认套件不访问真实模型。需要验证会产生 provider 请求和费用的 AI 世界生成、三回合游戏
流程时显式启用：

```bash
cp llm.toml.example llm.toml
cp .env.llm.example .env.llm
LIVE_LLM_ENABLED=1 pnpm e2e
```

`pnpm e2e` 使用 Playwright。未设置 `E2E_BASE_URL` 时，Playwright 会启动一套隔离的
测试服务：Vite 使用 `http://127.0.0.1:5181`，runtime server 使用
`http://127.0.0.1:3101`，并强制使用临时 MemoryStore。测试不会复用 `pnpm dev` 的
5173/3001 进程，结束后会回收两棵进程树，因此旧 Vite 缓存和本地 SQLite 数据都不会
污染结果。`/api/*` 由测试 Vite 代理到 3101。

如果你已经启动了服务，显式指定 **Vite** 地址：

```bash
pnpm dev
E2E_BASE_URL=http://localhost:5173 pnpm e2e
```

显式设置 `E2E_BASE_URL` 后，Playwright 不再启动或回收任何服务。运行完整套件时，目标
server 必须使用 `STORE_BACKEND=memory`；只有不含 browser-checkpoint 用例的子集才可以
指向 SQLite/PostgreSQL。跑 **served-static 构建**（设了 `SERVE_STATIC` 的生产 / Docker
栈，SPA 由 server 自己托管）时，base URL 可以直接指向 server。

需要交互式调试时使用：

```bash
pnpm e2e:ui
```

`pnpm e2e:ui` 会打开 Playwright UI；也可以用
`pnpm exec playwright test --debug tests/e2e/game-session.spec.ts` 逐步跑单个
spec。Playwright 只配置了 `chromium` project。

## 编写 spec：共享辅助函数

`tests/e2e/helpers/player.ts` 提供会话类 spec 的公共动作与断言，新 spec 应直接复用，
不要再各自复制一份。

| 辅助函数                     | 用途                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `composer` / `composerInput` | 定位主输入框（`data-testid`，不依赖 DOM 顺序）                |
| `waitForTurnStarted`         | 等待异步 preflight 结束并确认回合已经启动                     |
| `waitForTurnIdle`            | 等待已启动的回合真正结束                                      |
| `sendPlayerMessage`          | 输入、发送玩家消息并确认回合启动                              |
| `expectPlayerCanAct`         | 断言回合结束后玩家一定有可用的操作入口                        |
| `useServerWorlds`            | 让需要跨页面/API 状态的 spec 显式使用服务端世界与 MemoryStore |

关键点：**回合状态要读 `data-executing`，不要用 `input:disabled` 推断**。点击前置操作后先等
`waitForTurnStarted`，再等 `waitForTurnIdle`；否则异步 preflight 尚未把状态切到执行中时，
对 `false` 的断言会提前成功。执行中的输入框
本来就是可用的（用于插话），用 `toBeEnabled()` 判断回合结束会立刻通过，等于没等。
输入框只在有必答块（表单 / 选择）时才禁用，这两种状态由 composer 上的
`data-executing` 与 `data-blocked` 分别表达。

`expectPlayerCanAct` 承载的是玩家操作可用性这条不变量：回合结束后，只要屏幕上没有必答块，
主输入框就必须能接受自由输入。建议类插件面板（行动引导、场景快捷回复等）属于可选快捷方式，
永远不应该锁住输入框——回归时这条断言会直接失败。

MemoryStore 默认向 Web 暴露 browser-private 模式：世界和会话权威数据位于当前浏览器的
`BrowserVault`，不会跨 Playwright test context 出现在 `/api/worlds`。需要在后续 test 或
直接 API 断言中复用世界的串行 spec，必须在首次导航前调用 `useServerWorlds(page)`，明确
切换到服务端世界目录与临时 MemoryStore；纯浏览器持久化语义应在同一 page/context 内验证。

## 插件流水线验证

插件级端到端验证使用 HTTP API 驱动完整 runtime 流水线：

```bash
npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts
```

常用参数：

```bash
# 指定 llm.toml 中的 slot
npx tsx --env-file=.env --env-file=.env.llm \
  scripts/e2e-plugin-verify.ts --slot e2e_local --turns 5

# 聚焦单个插件
npx tsx --env-file=.env --env-file=.env.llm \
  scripts/e2e-plugin-verify.ts --plugin guide --turns 2
```

详细参数和输出格式见 [`e2e-plugin-verify.md`](./e2e-plugin-verify.md)。

## 环境变量

| 变量                    | 默认值                  | 说明                                                      |
| ----------------------- | ----------------------- | --------------------------------------------------------- |
| `E2E_BASE_URL`          | `http://127.0.0.1:5181` | Playwright 页面导航地址；设值表示使用调用方管理的外部环境 |
| `E2E_MODEL_SLOT`        | `e2e`                   | `scripts/e2e-plugin-verify.ts` 使用的 slot                |
| `LIVE_LLM_ENABLED`      | `false`                 | 显式启用会访问真实 provider 的 Playwright/Vitest 流程     |
| `COVEL_STORY_BASE_URL`  | 已移除、无读取方        | 不会覆盖 slot；代理地址应直接写入 `llm.toml`              |
| `COVEL_PLUGIN_BASE_URL` | 已移除、无读取方        | 不会覆盖 slot；代理地址应直接写入 `llm.toml`              |
| `CI`                    | `false`                 | CI 模式下 Playwright 启用重试并限制 worker                |

## PostgreSQL 模式

需要用 PostgreSQL 后端跑本地服务时，先启动数据库：

```bash
pnpm db:up
pnpm dev:pg
E2E_BASE_URL=http://localhost:5173 pnpm e2e
```

清理数据库容器：

```bash
pnpm docker:down
```

## 输出位置

| 路径                  | 内容                            |
| --------------------- | ------------------------------- |
| `tests/e2e/artifacts` | Playwright trace / video 等产物 |
| `tests/e2e/report`    | HTML report                     |
| `debugs/e2e-logs`     | 插件验证脚本日志与 JSON 产物    |

这些目录已在 `.dockerignore` 中排除，不进入生产镜像上下文。

## 失败排查

- **端口已占用或页面打不开**：默认测试 Vite 是 `5181`、API 是 `3101`，且启用
  `strictPort`，不会静默漂移到错误服务。停止占用端口的进程后重试；若要使用自己启动的
  SPA，设置 `E2E_BASE_URL`，并自行保证后端类型符合目标 spec。
- **API health 等待超时**：默认运行检查 `http://127.0.0.1:3101/api/health`；外部环境则
  检查其实际 runtime 地址。PostgreSQL 流程先运行 `pnpm db:up` 和 `pnpm dev:pg`，再以
  `E2E_BASE_URL` 指向对应 SPA，并排除只支持 MemoryStore 的 spec。
- **模型/角色创建失败**：浏览器 live spec 使用应用配置的 `story` / `plugin` 等用途；
  `scripts/e2e-plugin-verify.ts` 才默认使用 `e2e`（或 `E2E_MODEL_SLOT`）。分别确认所需
  slot 存在且 `.env.llm` 已提供对应 key。
- **需要定位异步失败**：失败时 Playwright 保留 screenshot；首次重试才保留
  trace/video。查看 `tests/e2e/report`，用 `pnpm exec playwright show-report tests/e2e/report`
  打开 HTML 报告。
- **插件验证 artifact**：HTTP 验证脚本默认写入 `debugs/e2e-logs/`；若只想在终端
  调试，传 `--no-log`，若要保留会话和快照，传 `--keep`。

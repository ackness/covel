# Covel 浏览器 E2E 测试指南

本文档说明当前保留的本地浏览器 E2E 路径。Docker 只负责 PostgreSQL
开发栈，不再维护单独的 E2E Docker compose。

## 快速开始

```bash
pnpm install
cp llm.toml.example llm.toml
cp .env.llm.example .env.llm
pnpm e2e
```

这组命令会运行 `tests/e2e/` 下全部 Chromium spec。只想跑一个文件或一个
测试名称时，直接把参数传给 Playwright：

```bash
pnpm exec playwright test tests/e2e/game-session.spec.ts
pnpm exec playwright test tests/e2e/game-session.spec.ts --grep "restore"
pnpm exec playwright test --project=chromium tests/e2e/i18n.spec.ts
```

`pnpm e2e` 使用 Playwright。未设置 `E2E_BASE_URL` 时，Playwright 会自动执行
`pnpm dev`，等待 `http://localhost:3001/api/health` 可用后开始测试；**页面导航则指向
Vite 的 `http://localhost:5173`**（`pnpm dev` 下 server 不服务 SPA，3001 的页面路由是裸
404；`/api/*` 由 Vite 代理回 3001）。

如果你已经启动了服务，显式指定 **Vite** 地址：

```bash
pnpm dev
E2E_BASE_URL=http://localhost:5173 pnpm e2e
```

只有跑 **served-static 构建**（设了 `SERVE_STATIC` 的生产 / Docker 栈，SPA 由 server 自己
托管）时才该指向 3001。

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

| 辅助函数                     | 用途                                           |
| ---------------------------- | ---------------------------------------------- |
| `composer` / `composerInput` | 定位主输入框（`data-testid`，不依赖 DOM 顺序） |
| `waitForTurnIdle`            | 等待回合真正结束                               |
| `sendPlayerMessage`          | 输入并发送一条玩家消息                         |
| `expectPlayerCanAct`         | 断言回合结束后玩家一定有可用的操作入口         |

关键点：**回合状态要读 `data-executing`，不要用 `input:disabled` 推断**。执行中的输入框
本来就是可用的（用于插话），用 `toBeEnabled()` 判断回合结束会立刻通过，等于没等。
输入框只在有必答块（表单 / 选择）时才禁用，这两种状态由 composer 上的
`data-executing` 与 `data-blocked` 分别表达。

`expectPlayerCanAct` 承载的是玩家操作可用性这条不变量：回合结束后，只要屏幕上没有必答块，
主输入框就必须能接受自由输入。建议类插件面板（行动引导、场景快捷回复等）属于可选快捷方式，
永远不应该锁住输入框——回归时这条断言会直接失败。

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

| 变量                    | 默认值                  | 说明                                                           |
| ----------------------- | ----------------------- | -------------------------------------------------------------- |
| `E2E_BASE_URL`          | `http://localhost:5173` | Playwright 页面导航地址（Vite）。设了它就不再自动起 `pnpm dev` |
| `E2E_MODEL_SLOT`        | `e2e`                   | `scripts/e2e-plugin-verify.ts` 使用的 slot                     |
| `COVEL_STORY_BASE_URL`  | 仅登记、未读取          | 不会覆盖 slot；代理地址应直接写入 `llm.toml`                   |
| `COVEL_PLUGIN_BASE_URL` | 仅登记、未读取          | 不会覆盖 slot；代理地址应直接写入 `llm.toml`                   |
| `CI`                    | `false`                 | CI 模式下 Playwright 启用重试并限制 worker                     |

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

- **端口已占用或页面打不开**：默认 Vite 是 `5173`、API 是 `3001`。运行
  `pnpm stop` 后重试；若已有服务，设置 `E2E_BASE_URL` 指向实际的 SPA 地址。
  设置该变量后 Playwright 不会自动启动 `pnpm dev`。
- **API health 等待超时**：确认 `http://localhost:3001/api/health` 可访问；若使用
  PostgreSQL，先运行 `pnpm db:up` 再运行 `pnpm dev:pg`。
- **模型/角色创建失败**：浏览器 live spec 使用应用配置的 `story` / `plugin` 等用途；
  `scripts/e2e-plugin-verify.ts` 才默认使用 `e2e`（或 `E2E_MODEL_SLOT`）。分别确认所需
  slot 存在且 `.env.llm` 已提供对应 key。
- **需要定位异步失败**：失败时 Playwright 保留 screenshot；首次重试才保留
  trace/video。查看 `tests/e2e/report`，用 `pnpm exec playwright show-report tests/e2e/report`
  打开 HTML 报告。
- **插件验证 artifact**：HTTP 验证脚本默认写入 `debugs/e2e-logs/`；若只想在终端
  调试，传 `--no-log`，若要保留会话和快照，传 `--keep`。

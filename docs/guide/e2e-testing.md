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

`pnpm e2e` 使用 Playwright。未设置 `E2E_BASE_URL` 时，Playwright 会自动执行
`pnpm dev`，等待 `http://localhost:3001/api/health` 可用后开始测试。

如果你已经启动了服务，可以显式指定地址：

```bash
pnpm dev
E2E_BASE_URL=http://localhost:3001 pnpm e2e
```

需要交互式调试时使用：

```bash
pnpm e2e:ui
```

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

| 变量             | 默认值                  | 说明                                       |
| ---------------- | ----------------------- | ------------------------------------------ |
| `E2E_BASE_URL`   | `http://localhost:3001` | Playwright 访问的应用地址                  |
| `E2E_MODEL_SLOT` | `e2e`                   | `scripts/e2e-plugin-verify.ts` 使用的 slot |
| `CI`             | `false`                 | CI 模式下 Playwright 启用重试并限制 worker |

## PostgreSQL 模式

需要用 PostgreSQL 后端跑本地服务时，先启动数据库：

```bash
pnpm db:up
pnpm dev:pg
E2E_BASE_URL=http://localhost:3001 pnpm e2e
```

清理数据库容器：

```bash
pnpm db:down
```

## 输出位置

| 路径                  | 内容                            |
| --------------------- | ------------------------------- |
| `tests/e2e/artifacts` | Playwright trace / video 等产物 |
| `tests/e2e/report`    | HTML report                     |
| `debugs/e2e-logs`     | 插件验证脚本日志与 JSON 产物    |

这些目录已在 `.dockerignore` 中排除，不进入生产镜像上下文。

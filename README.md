# Covel

AI RPG 插件化框架 —— 通过插件驱动的 Kernel 编排 LLM 调用、上下文组装和回合执行，提供交互式叙事/游戏体验。

核心理念：**插件承载玩法逻辑，Kernel 提供原语和编排。**

## 特性

- **插件化架构** — Runtime / Tool / Hook / Context / Proposal 五大执行原语，Plugin Package 是分发单元
- **优先级调度** — 0-1000 优先级排序，相同优先级并行执行，支持后台任务
- **多 LLM Provider** — DeepSeek、Qwen (DashScope)、OpenAI、Anthropic，Preset 路由 + Slot 绑定
- **提交链** — `proposal → validate → commit`，插件不直接写数据库
- **Schema 驱动 UI** — 三层渲染：自定义组件 → JSON Schema 自动生成 → Raw JSON
- **可观测性** — 完整 trace 链路，前端调试页面，可选 Langfuse 对接
- **玩家数据主权** — 所有 LLM 交互透明可查，API Key 仅存浏览器端

## 快速开始

### 前提条件

| 工具 | 版本 | 说明 |
|------|------|------|
| [Node.js](https://nodejs.org/) | >= 20.19 | 运行时 |
| [pnpm](https://pnpm.io/) | 10.7+ | 包管理器（`corepack enable pnpm`） |
| [Docker](https://www.docker.com/) | 24+ | 数据库 / 生产部署 |

### 方式一：本地开发

```bash
# 1. 克隆仓库
git clone <repo-url> covel && cd covel

# 2. 安装依赖
pnpm install

# 3. 启动 PostgreSQL（可选，开发模式有内存存储）
pnpm db:up

# 4. 配置 LLM 密钥
cp .env.llm.example .env.llm
# 编辑 .env.llm，填入至少一个 provider 的 API key

# 5. 启动开发服务
pnpm dev
```

访问：
- 前端：http://localhost:5173
- API：http://localhost:3001
- 调试页：http://localhost:5173/debug

> 开发模式下前端通过 Vite Proxy 代理 API 请求到后端，无需额外配置。

### 方式二：Docker Compose 部署

一键启动前端 + 后端 + 数据库：

```bash
# 1. 配置环境变量（必须，Docker Compose 会读取这两个文件）
cp .env.example .env
cp .env.llm.example .env.llm
# 编辑 .env.llm，填入 API key

# 2. 构建并启动
docker compose -f docker/docker-compose.yml up -d --build

# 3. 查看日志
docker compose -f docker/docker-compose.yml logs -f app
```

访问：http://localhost:3001

> Docker 模式下前端静态文件由后端 Hono 服务直接托管，单端口即可。

停止服务：

```bash
docker compose -f docker/docker-compose.yml down        # 保留数据
docker compose -f docker/docker-compose.yml down -v      # 清除数据卷
```

### LLM Provider 配置

Covel 支持两种方式配置 LLM API Key：

**方式 A：浏览器端**（推荐）
- 启动后在 UI 设置面板中输入 API Key
- Key 仅存储在浏览器 `localStorage`，每次请求通过 `X-Provider-Keys` Header 传递
- 服务端不持久化任何 Key

**方式 B：服务端环境变量**
- 适用于本地开发或信任的私有部署
- 编辑 `.env.llm`，开发服务器自动加载
- Docker 部署通过 `env_file` 注入

支持的 Provider：

| Provider | 环境变量 | 默认 Preset |
|----------|----------|-------------|
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat`（heavy slot） |
| DashScope (Qwen) | `DASHSCOPE_API_KEY` | `dashscope-qwen-flash`（fast slot） |
| OpenAI | `OPENAI_API_KEY` | 需自定义 Preset |
| Anthropic | `ANTHROPIC_API_KEY` | 需自定义 Preset |

Model Slot 系统：
- `heavy` — 主叙事，复杂推理（必须配置）
- `fast` — 插件默认，轻量判断
- `balance` — 裁判插件，复杂逻辑
- `image` — 图片生成（可选）

未配置的 Slot 自动回退到 `heavy`。

## 项目结构

```
covel/
├── apps/
│   ├── web/                React 19 + Vite 8 + TailwindCSS v4 + TanStack Router
│   └── server/             Hono API + Drizzle ORM + pg-boss
├── packages/
│   ├── shared/             共享类型与契约
│   ├── ai-provider/        多 Provider LLM 抽象（Preset 路由）
│   ├── runtime/            Runtime 执行引擎（LLM tool-calling loop + 预算控制）
│   ├── context/            统一 Context 构建（TurnContextStore + PromptAssembler）
│   ├── kernel/             编排内核（调度、工具执行、提案、渲染）
│   ├── plugin-runtime/     插件加载器、注册表（Tool/Hook/Runtime/Command）
│   ├── store/              数据抽象（Memory / IndexedDB / PostgreSQL）
│   └── plugin-test-utils/  插件测试工具
├── plugins/
│   ├── core-persona/       叙事者/AI 人格配置（priority 100）
│   ├── core-narrator/      主叙事生成（priority 400）
│   ├── core-combat/        回合制战斗（priority 420）
│   ├── core-init-wizard/   新手引导（priority 450）
│   ├── core-char-tracker/  角色识别（priority 600）
│   ├── core-guide/         故事引导与选项面板（priority 600）
│   ├── core-inventory/     物品/装备管理（priority 600）
│   ├── core-quest/         任务追踪（priority 600）
│   ├── core-dice/          随机/骰子
│   ├── core-memory/        记忆摘要
│   └── core-world-state/   世界状态追踪
├── docker/
│   ├── Dockerfile          多阶段构建（deps → build-web → production）
│   └── docker-compose.yml  PostgreSQL + App 一键部署
├── docs/
│   └── system-architecture-v0/  架构设计文档
└── plans/                  实现方案
```

## 常用命令

```bash
# ── 开发 ─────────────────────────────────────────────────────────
pnpm dev                  # 同时启动前端 (5173) 和后端 (3001)
pnpm dev:web              # 仅启动前端
pnpm dev:server           # 仅启动后端

# ── 构建 ─────────────────────────────────────────────────────────
pnpm build                # 构建所有包
pnpm lint                 # 类型检查 (tsc --noEmit)
pnpm clean                # 清理 dist 目录

# ── 数据库 ───────────────────────────────────────────────────────
pnpm db:up                # 启动 PostgreSQL 容器
pnpm db:down              # 停止 PostgreSQL 容器
pnpm db:generate          # 生成 Drizzle 迁移
pnpm db:migrate           # 执行迁移
pnpm db:studio            # Drizzle Studio

# ── 测试 ─────────────────────────────────────────────────────────
pnpm --filter @covel/kernel test
pnpm --filter @covel/plugin-runtime test
pnpm --filter @covel/runtime test
pnpm --filter @covel/ai-provider test
pnpm --filter @covel/store test
# 添加 --watch 进入监听模式

# ── Docker ───────────────────────────────────────────────────────
docker compose -f docker/docker-compose.yml up -d --build   # 构建并启动
docker compose -f docker/docker-compose.yml logs -f app     # 查看日志
docker compose -f docker/docker-compose.yml down            # 停止
```

## 核心架构

### Kernel 执行管线

每个回合（Turn）经过固定管线：

```
用户输入/事件
  → Trigger Router（事件类型识别、Runtime 候选过滤）
  → Priority Scheduler（0-1000 优先级排序、依赖拓扑）
  → [For each priority group:]
      → Context Assembly（TurnContextStore + PromptAssembler）
      → Runtime Runner（加载 PLUGIN.md、绑定 Provider/Tools/Hooks、LLM 循环）
      → Tool/Hook Loop（白名单工具、生命周期 Hook）
      → Proposal Collector（归一化为 KernelProposalEnvelope）
      → TurnContextStore.ingest()（结果注入供后续 Runtime 使用）
  → Validation / Policy（Schema + 权限 + 冲突检测）
  → Commit（State / Event / Record / Snapshot）
  → Render（消息块 + 面板更新 + 副作用）
```

### 插件系统

插件声明 `plugin.json` Manifest，推荐结构：

```
plugin/
  plugin.json      Manifest（能力声明、元数据、i18n、blockSchemas）
  PLUGIN.md        Runtime 指令（= LLM agent 技能提示词）
  schemas/         输入/输出 Schema
  server/          Runtime / Tool / Hook 实现
  client/          UI Slot 扩展
```

默认游戏循环：
```
core-persona (100, 上下文注入)
  → core-narrator (400, 叙事)
  → core-combat (420, 战斗，条件触发)
  → core-init-wizard (450, 首轮)
  → guide / tracker / inventory / quest (600, 并行)
  → background (900+)
```

### 可观测性

- **Trace 链路**：`traceId → runId → branchId → turnId → runtimeId → pluginId`
- **前端调试页**：Session Timeline / Runtime Inspector / Prompt Viewer / Data Explorer
- **Langfuse 集成**：可选，通过 `TraceExporter` 上报到外部 Trace 平台

## 文档

详细架构文档位于 `docs/system-architecture-v0/`：

1. [Framework Architecture](docs/system-architecture-v0/framework-architecture.md) — 整体架构设计
2. [Execution Flow](docs/system-architecture-v0/execution-flow.md) — 执行流程图解
3. [Runtime Kernel Spec](docs/system-architecture-v0/runtime-kernel-spec.md) — Kernel 实现规格
4. [Public Plugin API Spec](docs/system-architecture-v0/public-plugin-api-spec.md) — 插件 API 契约

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19, Vite 8, TailwindCSS v4, TanStack Router, Radix UI |
| 后端 | Hono, Node.js, tsx |
| 数据库 | PostgreSQL 17, Drizzle ORM |
| 任务队列 | pg-boss |
| AI | OpenAI / Anthropic / DeepSeek / DashScope (Qwen) |
| 构建 | pnpm workspaces, Turborepo |
| 部署 | Docker, Docker Compose |
| 语言 | TypeScript (strict, ESM-only, ES2022) |

## License

Private — 暂未开源。

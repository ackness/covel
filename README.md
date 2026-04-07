# Covel

**插件驱动的 AI RPG 框架** — Kernel 负责调度与编排，Plugin 承载所有玩法逻辑。

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-≥20.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.7-f69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#license)

---

## 概览

Covel 是一个基于插件架构的 AI 交互式叙事引擎，你可以把它理解为"为 AI 角色扮演游戏设计的插件平台"。

核心设计哲学：**Kernel 只提供五大执行原语（Runtime / Tool / Hook / Context / Proposal），所有叙事和玩法逻辑都由插件实现**。这意味着游戏机制完全可以被增减、替换，甚至在会话中途热切换。

**支持的 LLM**：DeepSeek · Qwen (DashScope) · OpenAI · Anthropic — 通过 `llm.toml` 配置 Slot，无需改代码切换模型。

---

## 核心特性

**插件化执行内核**
每个回合走固定的优先级管线：触发路由 → 并发调度 → 上下文组装 → LLM 推理循环 → 提案提交。插件通过声明优先级加入管线，0 = 最先执行，同优先级并行。

**多 Provider LLM 抽象**
Slot 绑定机制 + 模型能力自动识别（内置 2597 模型的 LiteLLM 数据库）。`image` 在 input = 视觉输入，在 output = 图像生成；方向性设计明确区分模态含义。

**Schema 驱动 UI**
插件通过 `blockSchemas` 声明数据结构，前端三层降级渲染：自定义 React 组件 → JSON Schema 自动生成 → Raw JSON。

**玩家数据主权**
API Key 仅存浏览器端（`X-Provider-Keys` header），服务端不持久化。支持本地 IndexedDB 和服务端 PostgreSQL 两种存储模式，通过 `STORE_BACKEND` 环境变量切换，前端在启动时自动感知。

**完整可观测性**
完整 trace 链路（`traceId → runId → turnId → runtimeId → pluginId`），前端内置 Debug 页：Session Timeline · Runtime Inspector · Prompt Viewer · Data Explorer。可选 Langfuse 集成。

---

## 快速开始

### 前提条件

| 工具 | 版本 |
|------|------|
| [Node.js](https://nodejs.org/) | >= 20.19 |
| [pnpm](https://pnpm.io/) | 10.7+（`corepack enable pnpm`）|
| [Docker](https://www.docker.com/) | 24+（生产部署时需要）|

### 本地开发

```bash
# 1. 克隆并安装依赖
git clone <repo-url> covel && cd covel
pnpm install

# 2. 配置 LLM（必须）
cp llm.toml.example llm.toml    # 编辑：填写模型 ID 和端点
cp .env.llm.example .env.llm    # 编辑：填写对应 provider 的 API Key

# 3. 启动开发服务（内存存储，无需数据库）
pnpm dev
```

访问 `http://localhost:5173`，调试页在 `http://localhost:5173/debug`。

> Vite Dev Server 自动代理 API 请求到 `:3001`，无需额外配置。

### 使用 PostgreSQL（持久化存储）

```bash
cp .env.example .env   # 检查数据库连接参数

pnpm db:up             # 启动 PostgreSQL 容器
pnpm dev:pg            # 以 STORE_BACKEND=pg 启动服务器
pnpm dev:web           # 另开终端启动前端
```

### Docker 一键部署

```bash
cp .env.example .env
cp llm.toml.example llm.toml && cp .env.llm.example .env.llm
# 编辑 llm.toml 和 .env.llm 填入模型和 Key

pnpm docker:build      # 构建并启动（前端 + 后端 + PostgreSQL）
pnpm docker:logs       # 查看日志
```

访问 `http://localhost:3001`（静态文件由 Hono 托管，单端口）。

```bash
pnpm docker:down       # 停止（保留数据卷）
```

---

## LLM 配置

### `llm.toml` — 模型 Slot 配置

```toml
# 第一个 Slot 自动成为 "default"，原始名也可访问
[slots.story]
provider = "deepseek"
model    = "deepseek-chat"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"

[slots.fast]
provider = "dashscope"
model    = "qwen3.5-flash"
baseUrl  = "https://dashscope.aliyuncs.com/compatible-mode/v1"
protocol = "openai-chat-v1"
fallback = "story"   # 此 Slot 失败时回退到 story
```

### `.env.llm` — API Key

```bash
DEEPSEEK_API_KEY=sk-xxx
DASHSCOPE_API_KEY=sk-xxx
# OPENAI_API_KEY=sk-xxx
# ANTHROPIC_API_KEY=sk-ant-xxx
```

**Slot 角色约定**（未配置的 Slot 自动回退到 `default`）：

| Slot 名 | 用途 |
|---------|------|
| `default` | 主叙事、复杂推理（第一个 Slot 自动担任）|
| `fast` | 插件默认、轻量判断 |
| `balance` | 裁判类插件、复杂逻辑 |
| `image` | 图像生成（可选）|

支持的协议：`openai-chat-v1` · `openai-responses-v1` · `anthropic-messages-v1`

---

## 插件系统

每个插件是一个目录，最小结构只需两个文件：

```
plugins/my-plugin/
  plugin.json       # Manifest：能力声明、元数据、UI blockSchemas
  PLUGIN.md         # Runtime 指令（= LLM agent 的技能提示词）
  server/           # Runtime / Tool / Hook 实现（可选）
  client/           # UI Slot 扩展（可选）
```

**默认游戏循环**（按优先级）：

```
core-persona     (100)  叙事者人格注入
core-narrator    (400)  主叙事生成
core-combat      (420)  战斗（事件触发）
core-init-wizard (450)  角色创建引导
─── 并行组 ──────(600)  角色追踪 / 故事引导 / 物品管理 / 任务追踪
core-memory      (900)  记忆摘要（每 N 轮）
```

插件触发模式：`always` · `interval(N)` · `manual` · `event(条件)`

插件只能通过 **Proposal** 写数据（`state.patch` · `record.upsert` · `event.emit` · `narrative.append`），不直接访问数据库。

---

## 存储后端

```
STORE_BACKEND=memory    # 默认，开发/测试用，进程重启数据清空
STORE_BACKEND=pg        # 生产推荐，需要 DATABASE_URL
```

前端在启动时调用 `GET /api/health`，根据响应中的 `storeBackend` 字段自动选择 LocalDataService（IndexedDB）或 RemoteDataService（服务端 API）。

---

## 部署方式对比

| 方式 | 存储 | 适用场景 |
|------|------|---------|
| 本地开发（memory）| 进程内存 | 快速原型、插件开发 |
| 本地开发（pg）| PostgreSQL | 需要持久化的开发调试 |
| Docker Compose | PostgreSQL | 自托管生产环境 |
| Render 一键部署 | 浏览器 IndexedDB | 公开 Demo（`render.yaml` 已预配置）|

---

## 项目结构

```
covel/
├── apps/
│   ├── web/              React 19 + Vite 8 + TailwindCSS v4 + TanStack Router
│   └── server/           Hono API + Drizzle ORM
├── packages/
│   ├── shared/           共享类型与契约
│   ├── ai-provider/      多 Provider LLM 抽象（Preset 路由 + 2597 模型数据库）
│   ├── runtime/          Runtime 执行引擎（LLM tool-calling loop + 预算控制）
│   ├── context/          上下文构建（TurnContextStore + PromptAssembler）
│   ├── kernel/           编排内核（调度、工具执行、提案、渲染）
│   ├── plugin-runtime/   插件加载器与注册表
│   └── store/            数据抽象（Memory / IndexedDB / PostgreSQL）
├── plugins/              16 个核心玩法插件
├── worlds/               内置世界包（cloudmere / mistport / neonridge）
├── prompts/              外置提示词模板（locale-aware markdown）
└── docs/                 架构设计文档
```

依赖流向：

```
shared ← ai-provider ← runtime ← context ← kernel
                        plugin-runtime ──────────┘
                        store ← server（组合所有层）
```

---

## 常用命令

```bash
pnpm dev                                          # 前端 + 后端同时启动
pnpm dev:pg                                       # 仅后端，使用 PostgreSQL
pnpm build                                        # 构建所有包
pnpm lint                                         # 类型检查（tsc --noEmit）

pnpm --filter @covel/kernel test                  # 单包测试
pnpm --filter @covel/ai-provider update-model-db  # 更新模型数据库

pnpm e2e                                          # E2E 测试（Playwright）
pnpm e2e:ui                                       # Playwright UI 模式
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19, Vite 8, TailwindCSS v4, TanStack Router, Radix UI |
| 后端 | Hono, Node.js, tsx |
| 数据库 | PostgreSQL 17, Drizzle ORM |
| AI 接入 | OpenAI / Anthropic / DeepSeek / DashScope (Qwen) |
| 构建工具 | pnpm workspaces, Turborepo |
| 部署 | Docker, Docker Compose, Render |
| 语言 | TypeScript（strict, ESM-only, ES2022）|

---

## 文档

架构文档位于 `docs/system-architecture-v0/`（推荐阅读顺序）：

1. `framework-architecture.md` — 整体分层架构设计
2. `execution-flow.md` — 回合执行流程详解
3. `runtime-kernel-spec.md` — Kernel 实现规格
4. `public-plugin-api-spec.md` — 插件 API 契约

另见：`docs/prompt-externalization-spec.md`（提示词外置规范）· `docs/world-package-spec.md`（世界包规范）

---

## License

Private — 暂未开源。

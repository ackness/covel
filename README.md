# Covel

**用 Agent 编排一切的 AI 角色扮演游戏框架。**
叙事、行动引导、NPC 关系、世界知识、角色卡 —— 每个玩法机制都是一个**自主 Agent**，自己决定何时触发、读什么上下文、调什么工具、写什么状态。一个回合可以多个 Agent 串联协作。

[![Version](https://img.shields.io/badge/version-v0.0.1-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stage](https://img.shields.io/badge/stage-early--access-orange)]()

[English](./README.en.md) · 中文

![Covel demo](./.assets/images/demo.gif)

> ⚠️ **早期阶段**：API、数据格式、插件 frontmatter 都会随版本破坏性变化。目前只有 macOS Apple Silicon 预编译包。请勿存放重要存档。

---

## Covel 是什么

主流 AI RPG（SillyTavern / RisuAI 等）的核心是**一次 LLM 调用** —— 把角色卡、lorebook、提示模板拼成一个大 prompt 发出去。

Covel 把"一次调用"拆成 **Agentic Pipeline**：

```
Trigger → Priority Schedule → [Agent₁ → Agent₂ → … → Agentₙ] → Validate → Commit → SSE
                              ↑ 每个 Agent 独立决定触发、上下文、工具与写入
```

**结果**：玩法复杂度沉淀在插件里，而不是塞进一个怪物级 system prompt。叙事、NPC 关系、知识典籍、角色创建都可装可卸。

## 快速开始

### A. 下载试玩（macOS Apple Silicon）

到 [Releases](https://github.com/AcKnEsS/covel/releases) 下载 `Covel-electron-<version>-mac-arm64.dmg`，安装后进 Settings 填一个 LLM API Key 即可。

**配置文件位置**（首次启动自动创建）：

```
~/.covel/
├── config.toml      ← 数据目录指针 + 日志轮转
├── llm.toml         ← 模型 / provider / baseUrl
├── keys.env         ← API Key（一行一个 KEY=VALUE，权限 0600）
└── data/
    ├── covel.db     ← SQLite
    ├── worlds/      ← 自定义世界
    └── logs/        ← electron / server 日志
```

应用内 Settings 面板和这些文件双向同步，喜欢哪种用哪种。完整字段参考 → [`docs/guide/desktop-config.md`](./docs/guide/desktop-config.md)。

### B. 从源码跑（Node ≥ 22, pnpm 10+）

```bash
pnpm install
cp llm.toml.example llm.toml        # 模型与端点
cp .env.llm.example .env.llm        # provider API Key
pnpm dev                            # web :5173 + server :3001 (SQLite)
```

打开 http://localhost:5173，调试页在 `/debug`。

**配置文件位置**（与桌面版**不同**，不要混淆）：

| 文件 | 位置 | 作用 |
|------|------|------|
| `llm.toml` | 仓库根 | 模型 slot 配置 |
| `.env.llm` | 仓库根 | provider API Key（dev server 启动时加载） |
| Web 端 LLM Key | `localStorage: covel:keys` | 浏览器内 Settings 面板写入 |
| Web 端用户偏好 | `localStorage: covel:settings` | 同上 |
| SQLite | `./data/covel.db` | 设 `STORE_BACKEND=memory` 可用纯内存 |

> Windows / Intel Mac / Linux 暂无官方包，需要自行构建。Tauri 壳暂时搁置。

## 内置插件

| 插件 | 类型 | 作用 |
|------|:-:|------|
| `narrator`     | Agent    | 主叙事 |
| `guide`        | Agent    | 行动引导 + 选项生成 |
| `npc-graph`    | Agent    | NPC 关系图抽取 + 2-hop 检索 |
| `codex`        | Agent    | 世界知识典籍 |
| `char-creator` | Agent    | 角色卡创建流程 |
| `world-init`   | Agent    | 世界维度初始化 |
| `pregame`      | Function | 开局前置（不走 LLM） |
| `memory`       | UI       | 记忆面板 |

示例世界包:`cloudmere`、`mistport`、`neonridge`。

## 写一个插件

最小形态 = `PLUGIN.md` + `package.json`。frontmatter 声明触发与工具,markdown 正文就是 Agent 的 skill prompt:

```yaml
---
name: my-plugin/main
priority: 500
model: plugin
trigger: { type: scheduled, interval: 1 }
tools:
  builtin: [create-form, plugin-data-set]
---

你是一个 XXX agent。本回合需要……
```

完整教程 → [插件作者指南](./docs/guide/plugin-authoring.md)
现有插件可以参考 [`plugins/`](./plugins/) · [插件注册表](./docs/reference/plugins.md) · [工具注册表](./docs/reference/tools.md)

## 仓库结构

```
covel/
├── apps/
│   ├── web/              前端 (React 19 + Vite)
│   ├── server/           后端 (Hono + Drizzle)
│   └── desktop/          Electron 壳
├── packages/             内部包 (runtime / context / ai-provider / store / memory / tools / …)
├── plugins/              核心插件
├── worlds/               世界包
├── prompts/              外部化 prompt 模板
└── docs/                 参考文档与作者指南
```

pnpm workspaces + Turborepo · ESM-only · TypeScript strict
完整包清单见 [`CLAUDE.md`](./CLAUDE.md#monorepo-structure)

## 文档

| 主题 | 链接 |
|------|------|
| 架构与回合管线 | [`docs/architecture/flow.md`](./docs/architecture/flow.md) |
| 写插件         | [`docs/guide/plugin-authoring.md`](./docs/guide/plugin-authoring.md) |
| 插件 / 工具注册表 | [`docs/reference/plugins.md`](./docs/reference/plugins.md) · [`docs/reference/tools.md`](./docs/reference/tools.md) |
| API / SSE 协议 | [`docs/reference/api.md`](./docs/reference/api.md) · [`docs/reference/protocol.md`](./docs/reference/protocol.md) |
| 桌面端配置     | [`docs/guide/desktop-config.md`](./docs/guide/desktop-config.md) |
| 桌面打包       | [`apps/desktop/PACKAGING.md`](./apps/desktop/PACKAGING.md) |

完整索引 → [`docs/README.md`](./docs/README.md)

## 贡献与发布

- Issue / PR 都欢迎,先读 [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)
- 发版由 Git tag 驱动:推 `v*` tag → [`.github/workflows/release.yml`](./.github/workflows/release.yml) 自动在 macOS runner 构建 Electron arm64 安装包并发布 Release

## License

[MIT](./LICENSE) © 2026 Covel Contributors

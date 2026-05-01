# Covel

**现代化、agent 化的 AI RPG。每个机制都是一个插件，由你定义。**

[English](./README.md) · **简体中文**

[![Version](https://img.shields.io/badge/version-v0.0.2-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stage](https://img.shields.io/badge/stage-early--access-orange)]()

![Covel demo](./.assets/images/demo.gif)

> ⚠️ **早期阶段**：API、数据格式、插件 frontmatter 都会随版本破坏性变化。目前只有 macOS Apple Silicon 预编译包。请勿存放重要存档。

---

## Covel 是什么

Covel 是一款由 AI 驱动的角色扮演游戏 —— 叙事、NPC 关系、世界知识、角色创建、记忆，每一个玩法机制都是一个**自主 agent**，一个回合可以多个 agent 串联协作。每个 agent 都是一个插件：装一个、换一个、或者自己写一个。

## 玩起来是什么样

上面的 gif 只是一次普通的回合。叙事在写场景的同时，另外四个 agent 也在并行工作：

- **Narrator + Guide** —— 推动剧情、给出下一步行动选项
- **NPC Graph** —— 抽取人物关系，回答"谁认识谁"
- **Codex** —— 边玩边长出来的世界典籍
- **Memory** —— 贯穿整局的长程记忆

每个 agent 都是独立插件。可以禁用、可以替换、可以自己写。

## 快速开始

### 直接玩

到 [Releases](https://github.com/AcKnEsS/covel/releases) 下载最新的 **macOS Apple Silicon** 安装包 —— `Covel-electron-<version>-mac-arm64.dmg`。

打开 Settings 填一个 LLM API Key，从三个示例世界（`cloudmere` / `mistport` / `neonridge`）里挑一个，就能开始玩。

数据存放在 `~/.covel/` —— 配置、Key、SQLite、自定义世界、日志都在这。完整字段 → [`docs/guide/desktop-config.md`](./docs/guide/desktop-config.md)。

> Windows / Intel Mac / Linux 暂无官方包，需要自行构建。Tauri 壳暂时搁置。

### 从源码跑

```bash
pnpm install
cp llm.toml.example llm.toml        # 模型与端点
cp .env.llm.example .env.llm        # provider API Key
pnpm dev                            # web :5173 + server :3001 (SQLite)
```

打开 <http://localhost:5173>，调试页在 `/debug`。

需要 PostgreSQL、纯内存模式或自定义路径？参考 [`docs/guide/env-registry.md`](./docs/guide/env-registry.md)。

## 做自己的玩法

你不必写代码。本仓库内置了**两个 Claude Code skill**，把一段对话变成可用的插件或世界包：

- **`/create-plugin`** —— 描述你想要的 agent，skill 会生成一份 `PLUGIN.md`（frontmatter + skill prompt）和最小化的 `package.json`。
- **`/create-world`** —— 描述一个设定，skill 会产出可以直接放进 `~/.covel/worlds/` 的 `world.yaml` + `WORLD.md`。

在仓库根目录里打开 Claude Code，输入 `/create-plugin` 或 `/create-world` 即可开始对话。

> 官方插件 / 世界包共享社区在路线图上。现阶段欢迎用 Gist 或 fork 分享。

## 开发

适合手写插件、调试 runtime、或扩展 kernel 的人。

### 内置插件

| 插件 | 类型 | 作用 |
|------|:-:|------|
| `narrator`     | Agent    | 主叙事 |
| `guide`        | Agent    | 行动引导 + 选项生成 |
| `npc-graph`    | Agent    | NPC 关系图抽取 + 2-hop 检索 |
| `codex`        | Agent    | 世界知识典籍 |
| `char-creator` | Agent    | 角色卡创建流程 |
| `world-init`   | Agent    | 世界维度初始化 |
| `pregame`      | Function | 开局前置（不走 LLM）|
| `memory`       | UI       | 记忆面板 |

### 手写一个插件

最小形态 = `PLUGIN.md` + `package.json`。frontmatter 声明触发与工具，markdown 正文就是 agent 的 skill prompt：

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

完整教程 → [插件作者指南](./docs/guide/plugin-authoring.md)。现有插件在 [`plugins/`](./plugins/) 下，可以参考。另见：[插件注册表](./docs/reference/plugins.md) · [工具注册表](./docs/reference/tools.md)。

### 仓库结构

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

pnpm workspaces + Turborepo · ESM-only · TypeScript strict。完整包清单 → [`CLAUDE.md`](./CLAUDE.md#monorepo-structure)。

### 文档

| 主题 | 链接 |
|------|------|
| 架构与回合管线 | [`docs/architecture/flow.md`](./docs/architecture/flow.md) |
| 写插件 | [`docs/guide/plugin-authoring.md`](./docs/guide/plugin-authoring.md) |
| 插件 / 工具注册表 | [`docs/reference/plugins.md`](./docs/reference/plugins.md) · [`docs/reference/tools.md`](./docs/reference/tools.md) |
| API / SSE 协议 | [`docs/reference/api.md`](./docs/reference/api.md) · [`docs/reference/protocol.md`](./docs/reference/protocol.md) |
| 桌面端配置 | [`docs/guide/desktop-config.md`](./docs/guide/desktop-config.md) |
| 桌面打包 | [`apps/desktop/PACKAGING.md`](./apps/desktop/PACKAGING.md) |

完整索引 → [`docs/README.md`](./docs/README.md)。应用内 `/debug` 调试页提供会话时间线、runtime trace、prompt diff。

## 路线图

- Windows / Linux / Intel Mac 安装包
- 官方插件 / 世界包共享社区
- 桌面端内置插件市场
- Tauri 壳同步（目前搁置）

## 贡献与发布

- Issue / PR 都欢迎，先读 [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)。
- 发版由 Git tag 驱动：推 `v*` tag → [`.github/workflows/release.yml`](./.github/workflows/release.yml) 自动在 macOS runner 构建 Electron arm64 安装包并发布 Release。

## License

[MIT](./LICENSE) © 2026 Covel Contributors

# Covel

下一代 AI 角色扮演游戏的 Agent 编排平台。把叙事、NPC 关系、知识典籍、角色卡创建这些玩法机制都写成独立的插件 Agent —— **插件即功能**。

[![Version](https://img.shields.io/badge/version-v0.0.1--beta-8b5cf6)](https://github.com/AcKnEsS/covel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.en.md) · 中文

![Covel demo](./.assets/images/demo.gif)

> 项目处于非常早期的阶段，功能尚不稳定，**API、数据格式、插件 frontmatter 字段都会随版本出现破坏性改动**。目前只支持本地运行，且只提供 macOS Apple Silicon 的预编译测试版。不要用来存长期存档。

## 为什么做这个

主流的 AI RPG 工具（SillyTavern / RisuAI / 各式 ChatBot 壳）大多把"一次 LLM 调用"作为主体，角色卡、lorebook、prompt 模板被拼成一次大请求发出去。Covel 换了种思路：把每个游戏机制拆成**独立的 Agent**，由它自己决定何时触发、读哪些上下文、调哪些工具、写哪些状态。一个回合里可以多个 Agent 串联协作。

这带来两个性质：

- 功能由插件承载而不是写死在内核里。叙事、行动引导、NPC 关系图、世界知识、角色创建，都是可装可卸的独立包。
- AI RPG 的复杂度可以沉淀成插件。不用把所有规则塞进一个巨大的 system prompt，每个 Agent 只关心它自己那一块。

## 当前仓库里有什么

八个核心插件作为起点：

| 插件 | 作用 |
|------|------|
| `core-narrator` | 主叙事 |
| `core-guide` | 行动引导与选项生成 |
| `core-npc-graph` | NPC 关系图抽取 + 2-hop 检索 |
| `core-codex` | 世界知识典籍 |
| `core-char-creator` | 角色卡创建流程 |
| `core-world-init` | 世界维度初始化 |
| `core-pregame` | 开局前置（纯函数插件，不走 LLM） |
| `core-memory` | 记忆面板（纯 UI 插件） |

另外有三个示例世界包：`cloudmere`、`mistport`、`neonridge`。

插件的最小形态是 `PLUGIN.md` + `package.json`：frontmatter 声明触发条件、上下文注入、工具清单；markdown 正文就是这个 Agent 的 skill prompt。工具可以用内置的（表单、状态写入、记录追加 ……），也能自己实现 JS 工具。

## 界面

| 选择世界 | 主叙事 + 插件消息 | 调试页：Turn / Prompt / Trace |
|:-:|:-:|:-:|
| ![](./.assets/images/select.png) | ![](./.assets/images/session.jpg) | ![](./.assets/images/debugger.png) |

## 下载试玩

目前只提供 **macOS arm64**（Apple Silicon）的 Electron 预编译测试版，在 [Releases](https://github.com/AcKnEsS/covel/releases) 里能找到（`Covel-electron-<version>-mac-arm64.dmg`）。装好以后进 Settings 填 LLM API Key 就能跑。

Windows / Intel Mac / Linux 没有官方包，要用就得自己从源码构建。Tauri 版暂时搁置（编译链问题较多），不再对外发布。

桌面版数据目录、`config.toml`、`keys.env`、`llm.toml` 细节在 [`docs/guide/desktop-config.md`](./docs/guide/desktop-config.md)。

> 项目还在早期，Releases 里的包**随时可能下架、重置或改格式**。要稳定跟进请走源码构建路径。

## 从源码跑

前提是 Node.js ≥ 22 和 pnpm 10+：

```bash
pnpm install
cp llm.toml.example llm.toml        # 模型 ID 和端点
cp .env.llm.example .env.llm        # provider API Key
pnpm dev                            # 前端 5173 + 后端 3001，默认 SQLite（./data/covel.db）
```

打开 `http://localhost:5173`，调试页在 `/debug`。想跳过落盘（进程退出即清空），在 `.env` 里加 `STORE_BACKEND=memory` 即可。

### 本地构建桌面壳

```bash
pnpm dev:electron      # Electron 壳热重载
pnpm build:electron    # 当前平台 Electron 安装包 → release/
```

签名与公证细节见 [`apps/desktop/PACKAGING.md`](./apps/desktop/PACKAGING.md)。

## 写一个插件

最小示例：

```yaml
---
name: my-plugin/main
priority: 500
model: plugin
trigger:
  type: scheduled
  interval: 1
tools:
  builtin: [create-form, plugin-data-set]
---

你是一个 XXX agent。本回合需要……
```

详细写法见 [插件作者指南](./docs/guide/plugin-authoring.md)。已实现插件可以直接参考 [`plugins/`](./plugins/) 目录，或看 [插件注册表](./docs/reference/plugins.md) 和 [工具注册表](./docs/reference/tools.md)。

## 仓库结构

```
covel/
├── apps/
│   ├── web/              前端（React 19 + Vite）
│   ├── server/           后端（Hono + Drizzle）
│   └── desktop/          Electron 壳
├── packages/             内部包（runtime / context / ai-provider / store / memory / tools / …）
├── plugins/              核心插件
├── worlds/               世界包
├── prompts/              外部化 prompt 模板
└── docs/                 参考文档与作者指南
```

Monorepo 用 pnpm workspaces + Turborepo 管理。完整包清单与依赖关系见 [`CLAUDE.md`](./CLAUDE.md#monorepo-structure)。

## 文档

- 架构概览：[`docs/architecture/flow.md`](./docs/architecture/flow.md)
- 写插件：[`docs/guide/plugin-authoring.md`](./docs/guide/plugin-authoring.md)
- 插件 / 工具注册表：[`docs/reference/plugins.md`](./docs/reference/plugins.md) · [`docs/reference/tools.md`](./docs/reference/tools.md)
- API 与协议：[`docs/reference/api.md`](./docs/reference/api.md) · [`docs/reference/protocol.md`](./docs/reference/protocol.md)
- 桌面版配置：[`docs/guide/desktop-config.md`](./docs/guide/desktop-config.md)

完整索引在 [`docs/README.md`](./docs/README.md)。

## 贡献

还在早期阶段，Issue 和 PR 都欢迎，先读一下 [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)。

发版由 Git tag 触发：推 `v*` tag 会触发 [`.github/workflows/release.yml`](./.github/workflows/release.yml) 在 macOS runner 上构建 Electron arm64 dmg，生成 Release 草稿。其它平台暂不提供官方包。

## License

[MIT](./LICENSE) © 2026 Covel Contributors

# Covel

**现代化、agent 化的 AI RPG。每个机制都是一个插件，由你定义。**

[English](./README.md) · **简体中文**

[![Version](https://img.shields.io/badge/version-v0.0.17-8b5cf6)](https://github.com/ackness/covel/releases/tag/v0.0.17)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stage](https://img.shields.io/badge/stage-early--access-orange)](<>)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ackness/covel)

![Covel 演示 —— 一局完整游戏，6 倍速](./.assets/images/demo.gif)

Covel 是一款 AI 驱动的 RPG，回合之间世界仍在运转：NPC 记录着对你的态度、世界典籍随游玩积累、记忆贯穿整局。支撑这一切的每个机制都是一个**以插件形式分发的自主 agent** —— 禁用一个、替换一个，或者自己写一个。

> **当前公开版本：v0.0.17**，早期阶段 —— API、数据格式、插件 frontmatter 可能随版本变化。官方预编译包面向 macOS Apple Silicon 与 Windows x64，其余平台从源码构建。

## 亮点

- 🎭 **舞台模式** —— 全屏视觉小说：场景背景、角色立绘、打字机对话框与选择肢浮层。走到没画过的新地点时，背景图会在会话中按需生成。
- 🤖 **多 agent 回合** —— 叙事 agent 写场景的同时，其他 agent 并行抽取 NPC 关系、扩写世界典籍、决定在场角色、维护长程记忆 —— 每一回合都是如此。
- 🧩 **一切皆插件** —— 内置 23 个 agent。一个插件就是一份 `PLUGIN.md`：YAML frontmatter 声明触发/工具/事件，Markdown 正文就是 agent 的提示词。
- 🌍 **两个旗舰世界** —— 一个黑暗奇幻悬疑、一个 GalGame 校园恋爱，都是精心手作、可直接 fork 的范例。
- 🔌 **自带模型** —— OpenAI / Anthropic / DeepSeek / Qwen 模型槽位。本地优先：SQLite 落盘，API 密钥绝不在服务端持久化。

## 两种玩法

|                 舞台模式（视觉小说）                 |                     叙事模式（文字）                      |
| :--------------------------------------------------: | :-------------------------------------------------------: |
| ![舞台模式](./.assets/images/readme/stage-mode.png)  |    ![叙事模式](./.assets/images/readme/text-mode.png)     |
| 背景、立绘与打字机对话；场景美术随探索自动解析与生成 | 经典叙事回合，内嵌选择肢与表单，每回合的 agent 时间线可见 |

世界声明自己的默认档（`defaultViewMode: stage`），游戏中可随时切换。

## 快速开始

### 直接玩

从 [Releases](https://github.com/ackness/covel/releases) 下载 **macOS Apple Silicon** 安装包，然后：打开设置 → 粘贴 LLM API 密钥 → 选一个世界 → 开玩。

你的数据都在 `~/.covel/`（配置、密钥、SQLite、自定义世界、日志）—— 详见[桌面配置指南](./docs/guide/desktop-config.md)。版本说明：[`docs/CHANGELOG.md`](./docs/CHANGELOG.md)。

### 从源码运行

```bash
pnpm install
cp llm.toml.example llm.toml        # 模型 ID 与端点
cp .env.llm.example .env.llm        # provider API 密钥
pnpm dev                            # web :5173 + server :3001（SQLite）
```

打开 <http://localhost:5173>，调试工具在 `/debug`。PostgreSQL、内存模式等其它选项：[环境变量注册表](./docs/guide/env-registry.md)。

## 内置世界

![选择世界](./.assets/images/readme/select-world.png)

- **雾港·裂潮纪（Mistport Chronicles）** —— 传统叙事模式，黑暗奇幻悬疑。被浓雾包裹的港口，每次退潮都露出不同的遗迹；公会长失踪，四方势力争夺一把通往深处之物的钥匙。中英双语，内置种子角色与调查向记忆维度。
- **遥风学园（Haruka Academy）** —— GalGame 舞台模式，校园恋爱日常。海边高中的社团、考试、传闻与未说出口的喜欢，由八名角色的群像展开 —— 立绘与场景美术开箱即含。

## 创造你自己的

在本仓库中打开 Claude Code，使用内置技能：

- **`/create-world`** —— 描述一个设定，得到校验通过的 `world.yaml` + `WORLD.md` + 世界数据，可直接放进 `~/.covel/worlds/`。
- **`/create-plugin`** —— 描述你想要的 agent，得到校验通过的 `PLUGIN.md` + `package.json`。

插件与世界包的官方分享社区在路线图上 —— 目前可通过 Gist 或 fork 分享。

## 开发

- [插件编写指南](./docs/guide/plugin-authoring.md) —— 从这里开始；[`plugins/`](./plugins/) 下的内置插件都是可运行的参考
- [架构与回合管线](./docs/architecture/flow.md) —— 一个回合如何流经触发 → 调度 → agents → 提交
- 参考：[插件注册表](./docs/reference/plugins.md) · [工具注册表](./docs/reference/tools.md) · [HTTP API](./docs/reference/api.md) · [完整文档索引](./docs/README.md)

pnpm workspaces + Turborepo · ESM-only · TypeScript strict · React 19 + Hono + Drizzle。仓库布局与包清单 → [`CLAUDE.md`](./CLAUDE.md#monorepo-structure)。

## 路线图

- Windows / Linux / Intel Mac 构建
- 插件与世界包的官方分享社区
- 桌面应用内置插件市场

## 贡献与许可

欢迎 Issue 和 PR —— 请先阅读 [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)。发布由 Git 标签驱动：推送 `v*` 标签即由 [GitHub Actions](./.github/workflows/release.yml) 构建并发布 macOS 安装包。

[MIT](./LICENSE) © 2026 Covel Contributors

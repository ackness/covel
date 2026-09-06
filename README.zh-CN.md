# Covel

**模块化、agent 化的 AI RPG。用插件组合玩法，用可移植世界包交付设定。**

[English](./README.md) · **简体中文**

[![Version](https://img.shields.io/badge/version-v0.0.32-8b5cf6)](https://github.com/ackness/covel/releases/tag/v0.0.32)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stage](https://img.shields.io/badge/stage-early--access-orange)](./docs/CHANGELOG.md)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ackness/covel)

![Covel 演示 —— 一局完整游戏，6 倍速](./.assets/images/demo.gif)

Covel 是一套 AI RPG 框架，也是一间可以直接游玩的工作室：NPC 关系、世界典籍、任务、行囊、记忆、舞台调度和媒体都会随回合演化。它有三层清晰分工：**内核提供原语与编排**，**插件提供行为**，**世界包提供设定、资源与默认插件组合**。

> **发布版本：v0.0.32**，早期阶段。API、世界数据和插件 manifest 可能随版本变化。当前二进制面向 macOS Apple Silicon 与 Windows x64，且尚未签名；升级前请阅读 [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)并备份自定义内容。

## 亮点

- 🎭 **舞台模式** —— 全屏视觉小说：场景背景、角色立绘、打字机对话框与选择肢浮层。走到没画过的新地点时，背景图会在会话中按需生成。
- ⚙️ **可组合的插件 runtime** —— 在一条能力驱动的管线中组合 LLM agent、确定性函数、UI 面板、数据 schema、事件和生命周期 hook。
- 🎲 **内置 RPG 玩法** —— 预掷骰判定（可视化回执）、自动跟踪的任务日志、玩家可直接操作的行囊、逐 NPC 好感度。全部是可选插件；世界包可以预置任务、开局装备与初始好感。
- 🧩 **插件保持可替换** —— 内核通过 `capabilities` 和 `outputKind` 发现能力，框架代码不按具体插件 ID 分支。
- 🌍 **可移植世界包** —— 用同一套 `WorldData` 导入协议携带世界观、角色 schema、主要角色、规则、记忆块、任务、物品、立绘、场景与插件默认值。
- 🔄 **共享 WorldIR** —— 回合后先生成一次插件中立事实投影，任务、行囊、好感、图鉴与关系插件复用同一份证据，不再各自重读故事。
- 🔌 **自带模型** —— OpenAI / Anthropic / DeepSeek / Qwen 模型槽位。本地优先：SQLite 落盘；Web 模式将 API 密钥存入浏览器 localStorage，桌面模式将密钥以明文保存到 `~/.covel/keys.env`。

## 两种玩法

|                 舞台模式（视觉小说）                 |                      叙事模式（文字）                       |
| :--------------------------------------------------: | :---------------------------------------------------------: |
| ![舞台模式](./.assets/images/readme/stage-mode.png)  |     ![叙事模式](./.assets/images/readme/text-mode.png)      |
| 背景、立绘与打字机对话；场景美术随探索自动解析与生成 | 经典叙事回合，内嵌行动建议与表单，每回合的 agent 时间线可见 |

世界声明自己的默认档（`defaultViewMode: stage`），游戏中可随时切换。

## 三层怎样配合

| 层级       | 负责什么             | 常见内容                                                            |
| ---------- | -------------------- | ------------------------------------------------------------------- |
| **内核**   | 稳定原语与编排       | 调度、上下文装配、工具、提案、校验、持久化、渲染                    |
| **插件包** | 可复用的玩法行为     | agent/function runtime、UI、schema、工具、事件、投影、生命周期 hook |
| **世界包** | 可移植设定与产品组合 | 世界观、角色、规则、插件策略/设置、记忆块、WorldData、立绘、场景    |

这条边界让三者可以独立演进：世界可以换叙事者或不启用任务系统而无需修改内核；插件可以服务多个世界而无需知道世界 ID；世界作者也可以加入题材专属数据而无需 fork 插件。

## 插件是能力包

插件不一定是一个自主 agent。它可以只有一个 runtime，也可以由多个 runtime 协作；可以完全不调用 LLM，也可以只声明 UI 或数据契约。

| 形态                 | 职责                                       | 内置示例                                              |
| -------------------- | ------------------------------------------ | ----------------------------------------------------- |
| **Agent runtime**    | 用模型完成叙事或结构化抽取                 | `narrator`、`codex`、`core-quest`                     |
| **Function runtime** | 执行确定性、零 token 的游戏逻辑            | `pregame`、`dice-check/roller`、`scene-cast`          |
| **混合插件包**       | 组合确定性检索与 agent 抽取                | `npc-graph`、`dice-check`、图像生成插件               |
| **生命周期 hook**    | 在调度、模型、工具与提交边界执行横切策略   | `cost-gate`、`story-guard`、`director`                |
| **UI 与数据契约**    | 声明面板、记忆块、schema 或 WorldData 目标 | `memory`、`character-blueprint`、`character-presence` |

`PLUGIN.md` 的 frontmatter 声明调度、工具、事件、`capabilities` 与 `outputKind`（`story`、`plugin` 或 `system`）。只有 agent runtime 才会把 Markdown 正文作为模型指令。多 runtime 插件在根目录保留包级信息，实际执行 manifest 位于 `runtimes/*/PLUGIN.md`：

```text
plugins/npc-graph/
├── PLUGIN.md                         # 插件包身份与共享元数据
└── runtimes/
    ├── rag-retriever/PLUGIN.md       # 回合前确定性检索
    └── extractor/PLUGIN.md           # 回合后关系抽取 agent
```

内核通过声明式能力和类型化输出连接这些模块。因此叙事者、图像服务商、舞台导演或规则系统都能被替换，而无需在框架里为某个插件 ID 添加特例。

## 世界包让设定真正可玩

![AI 世界构筑器正在配置可移植世界包](./.assets/images/readme/world-package-builder.png)

世界包是可移植的内容层。`world.yaml` 描述身份、语言、呈现方式、角色属性、记忆块和期望的插件组合；`WORLD.md` 保存权威世界观；`data/world.data.yaml` 把类型化 source 映射到世界 metadata、角色、资料库、媒体索引或插件自己的 namespace。

```text
worlds/my-world/
├── world.yaml                        # 身份、pluginPolicy、pluginSettings
├── WORLD.md                          # 权威设定与开局前提
├── data/
│   ├── world.data.yaml               # 有序 source → schema → target 导入
│   ├── dimensions.yaml
│   └── rules/
├── characters/main-cast.json
└── media/
    ├── portraits/
    ├── scenes/
    └── 角色 presence 与场景索引
```

`pluginPolicy` 选择 preset，并把插件标为必需、推荐或排除；非必需项仍可由玩家调整。`pluginSettings` 提供低于玩家覆盖优先级的世界默认值。`memoryBlocks` 可以加入线索、嫌疑人、信号日志、倒计时等题材记忆，无需修改记忆系统。

`WorldData` 是统一导入协议，不是第二种世界格式。source 可以是 YAML、JSON、Markdown、文本或媒体，目标可以是通用角色/资料库，也可以是明确接受 WorldData 的插件 namespace。应用内 AI 构筑器生成的也是同一套标准包：它会根据结构化创作简报生成 manifest、世界观、维度、主要角色、资料库和规则。文件型世界包可以携带完整媒体；浏览器或 store 中的 AI 世界保留可移植文本回退，媒体仍由文件或资源存储承载。

## 贯穿界面、插件与世界包的 i18n

Covel 内置 `zh-CN`、`en-US` 与 `ru-RU` 三套界面词典。玩家选择的 locale 会统一用于界面标签、插件 metadata 与提示词、世界 metadata、角色字段和 WorldData source。短自然语言字段使用 `{ zh, en }` 这样的 `I18nText`；较长内容则使用独立的语言变体文件：

```text
apps/web/src/i18n/locales/ja-JP.json       # 应用界面词典
plugins/my-plugin/PLUGIN.ja.md             # 本地化的 agent 指令
worlds/my-world/WORLD.ja.md                 # 本地化的世界设定
worlds/my-world/characters/main-cast.ja.json
worlds/my-world/data/rules/core.ja.yaml
```

世界包通过 `defaultLocale` 与 `supportedLocales` 声明语言。加载器会优先读取当前语言的变体，缺失时回退到权威 source，因此只完成部分翻译也不会影响游玩。雾港展示了包含世界观、角色、规则和媒体 metadata 变体的中英双语世界包。**Emberback Relay** 则是内置的英文默认世界包（`defaultLocale: en-US`），manifest、设定、角色、规则、任务和其他开局内容均以英文提供。

玩家、世界作者和插件作者都可以按照 [i18n 指南](./docs/reference/i18n.md)自行加入新的语言支持。`apps/web/src/i18n/locales/` 中的完整 JSON 词典会在构建时自动发现并加入 Web 语言选项，无需手工注册；新增词典后需要重新构建，未随包提供对应翻译的 Electron 原生文案会回退英文。若要本地化内容，则可按需补充 `I18nText`、`PLUGIN.<lang>.md`、`WORLD.<lang>.md` 与 WorldData source 变体。只翻译自然语言内容，稳定 ID、capability、工具、路径和调度配置继续以权威定义为准。完成后可运行 `pnpm check:i18n` 校验。

## 端到端调试每个回合

![追踪检查器展开了叙事 runtime 与 LLM 请求](./.assets/images/readme/debug-trace.png)

内置追踪检查器先按会话与回合组织完整执行链，再展开每个 runtime 以及流程、LLM、工具、消息、块、状态和 hook 事件。展开 runtime 可以检查调用顺序、token、耗时、工具参数与结果；点开单个事件还能查看请求元数据、提示消息、可用工具定义和原始载荷。独立的会话数据与成本视图，让同一套工作区同时服务游戏 QA、插件开发和模型成本分析。

## 每一次判定都有回执

![判定回执、任务推进与装备变动落在这一回合里，右侧是任务日志](./.assets/images/readme/rpg-systems.png)

有风险的行动，判定用的骰子在叙事**动笔之前**就已经掷好，结果不会被行文倒推改写 —— 算式直接落在正文里：`19 + 2 = 21 vs DC 16`。任务推进、装备变动、好感升降也以同样方式回执在这一回合里，再沉淀进各自的面板。骰子、任务、行囊、好感是四个独立插件；世界包预置开局任务、初始装备与初始好感，也可以一个都不装。

## 回合之间延续了什么

![核心记忆面板](./.assets/images/readme/memory-panel.png)

游戏中随手打开侧栏，看到的是世界包与当前会话共同延续的状态：核心记忆（进行中的剧情、当前场景、主角状态）、NPC 关系图谱、世界典籍与在场角色。世界作者可以预置角色、规则、任务、物品、好感和媒体；插件让这些状态随游玩继续演化，再把相关部分带入后续回合。

## 快速开始

### 直接玩

从 [Releases](https://github.com/ackness/covel/releases) 下载 **macOS Apple Silicon** 或 **Windows x64** 安装包，然后：打开设置 → 粘贴 LLM API 密钥 → 选一个世界 → 开玩。

配置、密钥、SQLite、自定义世界和日志默认都在 `~/.covel/`；如果 `config.toml` 重定向了 `data_root`，数据也会位于那个独立目录。升级前请阅读[桌面配置指南](./docs/guide/desktop-config.md)和[`docs/CHANGELOG.md`](./docs/CHANGELOG.md)。

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

- **雾港·裂潮纪（Mistport Chronicles）** —— 传统叙事模式的黑暗奇幻调查。自定义插件组合、中英双语世界观、调查记忆、角色蓝图、规则与立绘，展示世界如何在不 fork 框架的前提下形成自己的玩法。
- **遥风学园（Haruka Academy）** —— 舞台模式的校园群像恋爱。对话策略、角色关系、题材记忆、透明立绘与日夜场景注册表，把同一套内核组合成视觉小说。
- **Emberback Relay** —— 默认语言为英文（`en-US`）的传统叙事科幻边境悬疑。潮汐锁定星球上的孤独中继站，收到一段来自七十二小时后、由玩家自己发出的求救。预置任务、行囊、好感、规则、角色蓝图、立绘与五项判定属性，是 RPG 插件套件的参考世界包。

## 创造你自己的

在世界选择页使用 **AI 创建世界**，即可把一份创作简报变成校验通过、可以直接游玩的世界包。先选择传统叙事或角色对话，再按需加入主要角色、资料库、规则、题材记忆与开局配置。

仓库作者也可以使用内置辅助工具：

- **`/create-world`** —— 生成并校验 `world.yaml`、`WORLD.md` 与 WorldData 文件。桌面版世界包放入 `<data_root>/worlds/`（默认 `~/.covel/data/worlds/`）；源码运行使用 `COVEL_USER_WORLDS_DIR`，开发模式在 `~/.covel/` 已存在时默认使用 `~/.covel/worlds/`。
- **`/create-plugin`** —— 按能力需求搭建 runtime manifest、handler、schema、工具、UI 与测试的正确组合。

插件与世界包的官方分享社区在路线图上 —— 目前可通过 Gist 或 fork 分享。

## 开发

- [插件编写指南](./docs/guide/plugin-authoring.md) —— 从这里开始；[`plugins/`](./plugins/) 下的内置插件都是可运行的参考
- [架构与回合管线](./docs/architecture/flow.md) —— 一个回合如何流经触发 → 调度 → agents → 提交
- 参考：[插件注册表](./docs/reference/plugins.md) · [工具注册表](./docs/reference/tools.md) · [HTTP API](./docs/reference/api.md) · [完整文档索引](./docs/README.md)

pnpm workspaces + Turborepo · ESM-only · TypeScript strict · React 19 + Hono + Drizzle。仓库布局与包清单 → [`CLAUDE.md`](./CLAUDE.md#monorepo-structure)。

## 路线图

- Linux / Intel Mac 构建（macOS arm64 与 Windows x64 已发布）
- 插件与世界包的官方分享社区
- 桌面应用内置插件市场

## 贡献与许可

欢迎 Issue 和 PR —— 请先阅读 [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)。发布由 Git 标签驱动：推送 `v*` 标签即由 [GitHub Actions](./.github/workflows/release.yml) 构建并发布 macOS 与 Windows 安装包。

[MIT](./LICENSE) © 2026 Covel Contributors

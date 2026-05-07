# Covel 文档

Covel 是一个插件驱动的 AI 交互式叙事引擎。根目录 [`README.md`](../README.md) 介绍项目定位和快速开始；本目录是开发、插件作者、世界包作者、第三方集成和 AI Agent 的文档入口。

> 🇬🇧 English overview: [`../README.md`](../README.md)

## Start Here

| 你要做什么               | 入口                                                                               | 接着看                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 第一次跑项目             | [`../README.md`](../README.md)                                                     | [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                                                             |
| 写插件                   | [`guide/plugin-authoring.md`](./guide/plugin-authoring.md)                         | [`reference/plugins.md`](./reference/plugins.md), [`reference/tools.md`](./reference/tools.md)                     |
| 写零代码插件             | [`guide/plugin-authoring-zero-code.md`](./guide/plugin-authoring-zero-code.md)     | [`guide/plugin-authoring-agent.md`](./guide/plugin-authoring-agent.md)                                             |
| 给插件加 UI              | [`guide/plugin-ui-runtime-guidelines.md`](./guide/plugin-ui-runtime-guidelines.md) | [`reference/ui-panels.md`](./reference/ui-panels.md), [`reference/ui-components.md`](./reference/ui-components.md) |
| 做世界包、角色卡、媒体包 | [`reference/world-data.md`](./reference/world-data.md)                             | [`devs/docs/world-data-filesystem/README.md`](../devs/docs/world-data-filesystem/README.md)                        |
| 调 HTTP API 或自动化测试 | [`reference/api.md`](./reference/api.md)                                           | [`reference/protocol.md`](./reference/protocol.md), [`guide/e2e-plugin-verify.md`](./guide/e2e-plugin-verify.md)   |
| 理解回合执行管线         | [`architecture/flow.md`](./architecture/flow.md)                                   | [`reference/prompt-structure.md`](./reference/prompt-structure.md)                                                 |
| 做主题包                 | [`guide/themes.md`](./guide/themes.md)                                             | [`reference/theme-packages.md`](./reference/theme-packages.md)                                                     |
| 查一个术语               | [`glossary.md`](./glossary.md)                                                     | 对应 `reference/` 页面                                                                                             |
| 维护文档体系             | [`DOCS_STRATEGY.md`](./DOCS_STRATEGY.md)                                           | [`CONTRIBUTING.md#文档同步`](./CONTRIBUTING.md#文档同步)                                                           |

## Docs Map

| 目录                               | 读者                               | 内容规则                                                                                    |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| [`guide/`](./guide/)               | 插件作者、主题作者、贡献者         | 面向任务的教程和操作步骤。先讲如何做，再链接参考页。                                        |
| [`reference/`](./reference/)       | 框架开发者、第三方开发者、AI Agent | 权威契约：API、协议、frontmatter、工具、URI、schema、数据形状。字段枚举必须来自代码或测试。 |
| [`architecture/`](./architecture/) | 框架维护者、深入贡献者             | 运行机制、模块边界、历史决策和慢变设计。                                                    |
| [`devs/docs/`](../devs/docs/)      | 设计草案、审计、迁移计划           | 未必是当前稳定契约；引用时需要回到 `docs/reference/` 或代码确认。                           |
| [`docs/design/`](./design/)        | UI 设计与组件观感维护者            | 静态设计资产和视觉规范。                                                                    |

## Search Map

给第三方开发者和 AI Agent 的代码搜索入口：

| 问题                                 | 优先搜索                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PLUGIN.md` 字段有哪些               | `packages/shared/src/schemas/plugin.ts`, `packages/plugin-loader/src/parse-plugin-md.ts`, `docs/reference/plugins.md`                                                    |
| world data 字段和 URI 怎么写         | `packages/shared/src/schemas/world-data.ts`, `apps/server/src/world-data/target-uri.ts`, `apps/server/src/world-data/schema-registry.ts`, `docs/reference/world-data.md` |
| 某个 HTTP endpoint 的真实行为        | `apps/server/src/routes/api/`, `docs/reference/api.md`                                                                                                                   |
| SSE / action 事件怎么消费            | `packages/shared/src/types/protocol.ts`, `apps/web/src/services/`, `docs/reference/protocol.md`                                                                          |
| LLM tool 从哪里注册                  | `packages/tools/src/`, `docs/reference/tools.md`                                                                                                                         |
| prompt 注入和 cache_control 怎么工作 | `packages/context/src/`, `packages/runtime/src/turn-executor.ts`, `docs/reference/prompt-structure.md`                                                                   |
| 插件 UI 组件可用 props               | `apps/web/src/components/json-render/`, `docs/reference/ui-components.md`                                                                                                |
| 存储事务、media、ledger 行为         | `packages/store/src/`, `apps/server/src/world-data/session-import.ts`, `docs/reference/transactions.md`, `docs/reference/media-store.md`                                 |

## Current Structure

```text
docs/
├── README.md                  # 文档总入口
├── DOCS_STRATEGY.md           # 文档组织、站点拆分和发布策略
├── CHANGELOG.md               # 版本发布记录
├── CONTRIBUTING.md / .en.md   # 贡献指南
├── glossary.md                # 术语表
├── guide/                     # how-to 教程
├── reference/                 # 权威框架契约
├── architecture/              # 架构与历史决策
└── design/                    # UI 设计资产
```

## Documentation Rules

- 影响框架能力的代码改动必须同步更新对应 `reference/` 页面，常见范围包括 API、协议、插件 frontmatter、工具、UI slot、world data descriptor、主题包和存储契约。
- `reference/` 写当前真实契约；`guide/` 写推荐路径；`architecture/` 写设计原因和模块关系；`devs/docs/` 写草案、审计和迁移计划。
- 字段枚举、URI grammar、默认值和错误条件优先从 `packages/shared/src/schemas/**`、`packages/shared/src/types/**`、server route、runtime 实现和测试中提取。
- 面向 AI Agent 的页面需要保留可搜索的英文标识符，例如 `worldData`, `PLUGIN.md`, `plugin://`, `plugin:`, `RuntimeManifest`, `DataStore`。
- 文档站点和仓库拆分策略见 [`DOCS_STRATEGY.md`](./DOCS_STRATEGY.md)。

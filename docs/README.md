# Covel 文档

Covel 是一个插件驱动的 AI 交互式叙事引擎。根目录 [`README.md`](../README.md) 介绍项目定位和快速开始；本目录是开发、插件作者、世界包作者、第三方集成和 AI Agent 的文档入口。

> 🇬🇧 English overview: [`../README.md`](../README.md)

文档随 `main` 分支的实现同步，不单独标注版本。框架版本以根 [`package.json`](../package.json) 为准，
插件与世界包可独立维护版本；协议/schema 版本和历史变更记录不随应用版本统一替换。文档与代码或测试不一致时，
以代码和测试为准，并在同一次改动中修正文档。

正在逐步建设[文档 v2](./v2/README.md)：按游玩、创建世界、开发插件、验证与分发组织阅读路径，
并提供[开发 Agent 工作指南](./v2/agent-workflow.md)。目前完整教程与权威契约仍使用下列现有文档。

## Start Here

| 你要做什么               | 入口                                                                               | 接着看                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 第一次跑项目             | [`../README.md`](../README.md)                                                     | [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                                                                                           |
| 升级版本                 | [`CHANGELOG.md`](./CHANGELOG.md)                                                   | 从 v0.0.42 之前升级另见 [`guide/upgrade-0.0.42.md`](./guide/upgrade-0.0.42.md)（[English](./guide/upgrade-0.0.42.en.md)）                        |
| 写插件                   | [`guide/plugin-authoring.md`](./guide/plugin-authoring.md)                         | [`reference/plugins.md`](./reference/plugins.md), [`reference/tools.md`](./reference/tools.md)                                                   |
| 写零代码插件             | [`guide/plugin-authoring-zero-code.md`](./guide/plugin-authoring-zero-code.md)     | [`guide/plugin-authoring-agent.md`](./guide/plugin-authoring-agent.md)                                                                           |
| 让插件之间协作           | [`reference/plugin-extensions.md`](./reference/plugin-extensions.md)               | [`reference/extension-points.md`](./reference/extension-points.md), [`reference/plugins.md`](./reference/plugins.md)                             |
| 给插件加 UI              | [`guide/plugin-ui-runtime-guidelines.md`](./guide/plugin-ui-runtime-guidelines.md) | [`reference/ui-panels.md`](./reference/ui-panels.md), [`reference/ui-components.md`](./reference/ui-components.md)                               |
| 做世界包、角色卡、媒体包 | [`reference/world-data.md`](./reference/world-data.md)                             | [`reference/world-model.md`](./reference/world-model.md), [`reference/media-store.md`](./reference/media-store.md)                               |
| 发布、安装世界与插件     | [`guide/collections.md`](./guide/collections.md)                                   | [`reference/plugin-installation.md`](./reference/plugin-installation.md), [`reference/world-installation.md`](./reference/world-installation.md) |
| 配置模型与环境变量       | [`reference/slots.md`](./reference/slots.md)                                       | [`guide/env-registry.md`](./guide/env-registry.md), [`guide/desktop-config.md`](./guide/desktop-config.md)                                       |
| 调 HTTP API 或自动化测试 | [`reference/api.md`](./reference/api.md)                                           | [`reference/protocol.md`](./reference/protocol.md), [`guide/e2e-plugin-verify.md`](./guide/e2e-plugin-verify.md)                                 |
| 理解设计理念             | [`architecture/design-principles.md`](./architecture/design-principles.md)         | [`guide/plugin-authoring.md`](./guide/plugin-authoring.md), [`glossary.md`](./glossary.md)                                                       |
| 理解回合执行管线         | [`architecture/flow.md`](./architecture/flow.md)                                   | [`reference/prompt-structure.md`](./reference/prompt-structure.md)                                                                               |
| 理解包边界与存储         | [`architecture/packages.md`](./architecture/packages.md)                           | [`architecture/storage.md`](./architecture/storage.md), [`reference/transactions.md`](./reference/transactions.md)                               |
| 理解安全边界             | [`architecture/security.md`](./architecture/security.md)                           | [`reference/api.md`](./reference/api.md), [`guide/env-registry.md`](./guide/env-registry.md)                                                     |
| 验收玩家流程与发布       | [`guide/e2e-testing.md`](./guide/e2e-testing.md)                                   | [`guide/plugin-testing.md`](./guide/plugin-testing.md), [`guide/desktop-packaging.md`](./guide/desktop-packaging.md)                             |
| 做主题包                 | [`guide/themes.md`](./guide/themes.md)                                             | [`reference/theme-packages.md`](./reference/theme-packages.md)                                                                                   |
| 查一个术语               | [`glossary.md`](./glossary.md)                                                     | 对应 `reference/` 页面                                                                                                                           |
| 维护文档体系             | [`DOCS_STRATEGY.md`](./DOCS_STRATEGY.md)                                           | [`CONTRIBUTING.md#文档同步`](./CONTRIBUTING.md#文档同步)                                                                                         |

## Docs Map

| 目录                               | 读者                               | 内容规则                                                                                    |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| [`guide/`](./guide/)               | 插件作者、主题作者、贡献者         | 面向任务的教程和操作步骤。先讲如何做，再链接参考页。                                        |
| [`reference/`](./reference/)       | 框架开发者、第三方开发者、AI Agent | 权威契约：API、协议、frontmatter、工具、URI、schema、数据形状。字段枚举必须来自代码或测试。 |
| [`architecture/`](./architecture/) | 框架维护者、深入贡献者             | 运行机制、模块边界、历史决策和慢变设计。                                                    |
| [`v2/`](./v2/README.md)            | 玩家、世界与插件作者、开发 Agent   | 新阅读路径和逐章迁移入口；明确标注已完成内容与后续方向。                                    |

任务计划、审查记录、实施日志、临时分析和交接材料属于开发过程资料，统一放在 `devs/docs/`，不进入正式文档树。

## Search Map

给第三方开发者和 AI Agent 的代码搜索入口：

| 问题                                 | 优先搜索                                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLUGIN.md` 字段有哪些               | `packages/shared/src/schemas/plugin-schemas.ts`（zod 真身，`plugin.ts` 只是 re-export 聚合点）, `packages/plugin-loader/src/parse-plugin-md.ts`, `docs/reference/plugins.md`           |
| world data 字段和 URI 怎么写         | `packages/shared/src/schemas/world-data.ts`, `apps/server/src/world-data/target-uri.ts`, `apps/server/src/world-data/schema-registry.ts`, `docs/reference/world-data.md`               |
| 包的作者信息在哪声明、在哪展示       | `packages/shared/src/schemas/package-info.ts`, `apps/web/src/components/shared/package-credits.tsx`, `docs/reference/plugins.md`                                                       |
| 某个 HTTP endpoint 的真实行为        | `apps/server/src/routes/api/`, `docs/reference/api.md`                                                                                                                                 |
| SSE / action 事件怎么消费            | `packages/shared/src/types/protocol.ts`, `apps/web/src/services/api/actions.ts`, `apps/web/src/services/subscription.ts`, `docs/reference/protocol.md`                                 |
| LLM tool 从哪里注册                  | `packages/tools/src/`, `docs/reference/tools.md`                                                                                                                                       |
| prompt 注入和 cache_control 怎么工作 | `packages/context/src/`, `packages/runtime/src/turn-executor/turn-executor.ts`, `packages/runtime/src/turn-executor/turn-runtime-execution.ts`, `docs/reference/prompt-structure.md`   |
| 插件 UI 组件可用 props               | `apps/web/src/lib/catalog/`, `apps/web/src/components/session/plugin-panel.tsx`, `apps/web/src/components/session/chat-messages/message-blocks.tsx`, `docs/reference/ui-components.md` |
| 存储事务、media、ledger 行为         | `packages/store/src/`, `packages/store/src/media-store/`, `apps/server/src/world-data/session-import/`, `docs/reference/transactions.md`, `docs/reference/media-store.md`              |
| 会话启用哪些插件、契约如何解析       | `packages/shared/src/plugin-selection.ts`, `packs/builtin.yaml`, `apps/server/src/config/plugin-packs.ts`, `docs/reference/plugins.md`                                                 |
| 扩展点、插件服务怎么声明和调用       | `packages/shared/src/extension-points/`, `packages/plugin-handlers-utils/src/plugin-api.ts`, `docs/reference/extension-points.md`, `docs/reference/plugin-extensions.md`               |
| 回合调度、stage、触发判定            | `packages/runtime/src/turn-executor/`, `packages/runtime/src/schedule/`, `packages/runtime/src/trigger/trigger.ts`, `docs/architecture/flow.md`                                        |
| 模型用途（slot）如何路由             | `packages/ai-provider/src/config/llm-schema.ts`, `llm.toml.example`, `docs/reference/slots.md`                                                                                         |
| 环境变量有哪些、默认值是什么         | `packages/shared/src/env/registry.ts`, `docs/guide/env-registry.md`                                                                                                                    |

世界图片与画廊内容资料见 [世界美术方向](./guide/world-art-direction.md#画廊资料与前端使用) 和 [角色立绘指南](./guide/world-portraits.md)。

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
└── v2/                        # 新阅读路径、Agent 指南与逐步迁移
```

## Documentation Rules

- 影响框架能力的代码改动必须同步更新对应 `reference/` 页面，常见范围包括 API、协议、插件 frontmatter、工具、UI slot、world data descriptor、主题包和存储契约。
- `reference/` 写当前真实契约；`guide/` 写推荐路径；`architecture/` 写设计原因和模块关系。
- 字段枚举、URI grammar、默认值和错误条件优先从 `packages/shared/src/schemas/**`、`packages/shared/src/types/**`、server route、runtime 实现和测试中提取。
- 面向 AI Agent 的页面需要保留可搜索的英文标识符，例如 `worldData`, `PLUGIN.md`, `plugin://`, `plugin:`, `RuntimeManifest`, `DataStore`。
- 任务计划、审查记录、实施日志、临时分析和交接材料放在 `devs/docs/`；其中形成稳定契约的部分再提炼到 `guide/`、`reference/` 或 `architecture/`。
- 文档站点和仓库拆分策略见 [`DOCS_STRATEGY.md`](./DOCS_STRATEGY.md)。

# Covel 文档

这个目录是 Covel 的全部文档，也是文档站的源文件：[`apps/docs`](../apps/docs/) 把它构建成站点，发布在官网的 `/docs/` 下。它按读者接触产品的顺序编排：先玩，再做世界，再做插件，再发给别人，最后是字段参考和内部原理。读者从[首页](./index.md)开始；本页写给找入口和编辑文档的人，不出现在站点上。

> English: the English edition is under [`en/`](./en/index.md); the project overview is [`../README.md`](../README.md).

文档随 `main` 分支的实现同步，不单独标注版本。框架版本以根 [`package.json`](../package.json) 为准，插件和世界包各自维护版本。文档与代码或测试不一致时，以代码和测试为准，并在同一次改动中修正文档。

## 从哪里开始

| 你要做什么         | 入口                                         | 接着看                                                                                               |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 先玩起来           | [安装与首次启动](./start/install.md)         | [连接模型](./start/models.md)、[第一局游戏](./start/first-session.md)                                |
| 升级版本           | [`CHANGELOG.md`](./CHANGELOG.md)             | [数据、备份与升级](./start/data-and-upgrade.md)                                                      |
| 做一个世界         | [第一个世界](./worlds/first-world.md)        | [世界数据](./reference/world-data.md)                                                                |
| 做一个插件         | [第一个插件](./plugins/first-plugin.md)      | [写插件要知道的规则](./plugins/essentials.md)、[插件字段](./reference/plugins.md)                    |
| 给插件加界面       | [给插件加界面](./plugins/ui.md)              | [面板](./reference/ui-panels.md)、[界面组件](./reference/ui-components.md)                           |
| 发给别人用         | [验证与分发](./ship/index.md)                | [合集](./ship/collections.md)                                                                        |
| 做主题             | [制作和分享主题](./recipes/themes.md)        | [主题包](./reference/theme-packages.md)                                                              |
| 配置模型和环境变量 | [模型用途](./reference/slots.md)             | [环境变量](./reference/env-registry.md)、[桌面配置](./reference/desktop-config.md)                   |
| 调 HTTP API        | [HTTP API](./reference/api.md)               | [SSE 协议](./reference/protocol.md)                                                                  |
| 理解它怎样运转     | [设计原则](./internals/design-principles.md) | [回合管线](./internals/flow.md)、[存储](./internals/storage.md)、[安全边界](./internals/security.md) |
| 参与开发           | [`CONTRIBUTING.md`](./CONTRIBUTING.md)       | [命令](./internals/commands.md)、[端到端测试](./internals/e2e-testing.md)                            |
| 查一个术语         | [术语表](./reference/glossary.md)            |                                                                                                      |
| 维护文档           | [页面清单](#页面清单)                        | [`AGENTS.md`](./AGENTS.md)、[`DOCS_STRATEGY.md`](./DOCS_STRATEGY.md)                                 |

## Search Map

想直接看代码时，从这里找入口：

| 问题                                 | 优先搜索                                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLUGIN.md` 字段有哪些               | `packages/shared/src/schemas/plugin-schemas.ts`（zod 真身，`plugin.ts` 只是 re-export 聚合点）, `packages/plugin-loader/src/parse-plugin-md.ts`, `docs/reference/plugins.md`           |
| world data 字段和 URI 怎么写         | `packages/shared/src/schemas/world-data.ts`, `packages/shared/src/world-data-target.ts`, `apps/server/src/world-data/schema-registry.ts`, `docs/reference/world-data.md`               |
| 包的作者信息在哪声明、在哪展示       | `packages/shared/src/schemas/package-info.ts`, `apps/web/src/components/shared/package-credits.tsx`, `docs/reference/plugins.md`                                                       |
| 某个 HTTP endpoint 的真实行为        | `apps/server/src/routes/api/`, `docs/reference/api.md`                                                                                                                                 |
| SSE / action 事件怎么消费            | `packages/shared/src/types/protocol.ts`, `apps/web/src/services/api/actions.ts`, `apps/web/src/services/subscription.ts`, `docs/reference/protocol.md`                                 |
| LLM tool 从哪里注册                  | `packages/tools/src/`, `docs/reference/tools.md`                                                                                                                                       |
| prompt 注入和 cache_control 怎么工作 | `packages/context/src/`, `packages/runtime/src/turn-executor/turn-executor.ts`, `packages/runtime/src/turn-executor/turn-runtime-execution.ts`, `docs/reference/prompt-structure.md`   |
| 插件 UI 组件可用 props               | `apps/web/src/lib/catalog/`, `apps/web/src/components/session/plugin-panel.tsx`, `apps/web/src/components/session/chat-messages/message-blocks.tsx`, `docs/reference/ui-components.md` |
| 存储事务、media、ledger 行为         | `packages/store/src/`, `packages/store/src/media-store/`, `apps/server/src/world-data/session-import/`, `docs/reference/transactions.md`, `docs/reference/media-store.md`              |
| 会话启用哪些插件、契约如何解析       | `packages/shared/src/plugin-selection.ts`, `packs/builtin.yaml`, `apps/server/src/config/plugin-packs.ts`, `docs/reference/plugins.md`                                                 |
| hook 有哪些事件、负载和上下文        | `packages/shared/src/types/hooks.ts`, `packages/runtime/src/hooks/types.ts`, `packages/runtime/src/hooks/wire-helpers.ts`, `docs/reference/hooks.md`                                   |
| 扩展点、插件服务怎么声明和调用       | `packages/shared/src/extension-points/`, `packages/plugin-handlers-utils/src/plugin-api.ts`, `docs/reference/extension-points.md`, `docs/reference/plugin-extensions.md`               |
| 回合调度、stage、触发判定            | `packages/runtime/src/turn-executor/`, `packages/runtime/src/schedule/`, `packages/runtime/src/trigger/trigger.ts`, `docs/internals/flow.md`                                           |
| 模型用途（slot）如何路由             | `packages/ai-provider/src/config/llm-schema.ts`, `llm.toml.example`, `docs/reference/slots.md`                                                                                         |
| 环境变量有哪些、默认值是什么         | `packages/shared/src/env/registry.ts`, `docs/reference/env-registry.md`                                                                                                                |

世界图片与画廊内容资料见 [世界美术方向](./worlds/art-direction.md#画廊资料与前端使用) 和 [角色立绘指南](./worlds/portraits.md)。

## 本地预览

```bash
pnpm --filter @covel/docs dev      # http://localhost:5175/docs/
pnpm --filter @covel/docs build    # 输出到 apps/docs/dist/，有失效链接时构建失败
```

## 页面清单

### 首页

- [`index.md`](./index.md)

### `start/` 开始：怎样从安装走到一局能继续的游戏

- [认识 Covel](./start/what-is-covel.md)
- [安装与首次启动](./start/install.md)
- [连接模型](./start/models.md)
- [第一局游戏](./start/first-session.md)
- [安装插件与世界包](./start/packages.md)
- [数据、备份与升级](./start/data-and-upgrade.md)
- [在公开体验站上玩](./start/hosted-trial.md)
- [从源码运行](./start/run-from-source.md)
- [在 Render 上部署体验站](./start/deploy-render.md)

### `builtin/` 内置插件与功能：装好之后自带什么

- [概览](./builtin/index.md)
- [叙事与记忆](./builtin/story.md)
- [RPG 玩法](./builtin/rpg.md)
- [角色与世界](./builtin/world.md)
- [舞台与声音](./builtin/stage.md)
- [应用自带的功能](./builtin/features.md)

增删内置插件、改它的设置项或面板时，同步更新这一章。

### `worlds/` 创建世界：怎样把一份设定做成可玩的世界

- [世界包是什么](./worlds/index.md)
- [第一个世界](./worlds/first-world.md)
- [导入 SillyTavern 内容](./worlds/import-sillytavern.md)
- [美术方向](./worlds/art-direction.md)
- [角色立绘](./worlds/portraits.md)
- [场景图](./worlds/scenes.md)

### `plugins/` 开发插件：怎样把一个需求做成独立的扩展

- [插件是什么](./plugins/index.md)
- [第一个插件](./plugins/first-plugin.md)
- [只写提示词的插件](./plugins/prompt-only.md)
- [带代码的插件](./plugins/local-code.md)
- [多个 runtime 与数据](./plugins/advanced.md)
- [给插件加界面](./plugins/ui.md)
- [写插件要知道的规则](./plugins/essentials.md)
- [提示词写法](./plugins/prompt-style.md)
- [深入测试](./plugins/testing.md)

`essentials.md`、`local-code.md` 和 `advanced.md` 里以 `---` 开头的完整清单示例，会被 `packages/plugin-loader/tests/authoring-guide-examples.test.ts` 当作真实插件加载。改这些示例后运行 `pnpm test:docs`。

### `ship/` 验证与分发：怎样证明别人安装后也能用

- [概览](./ship/index.md)
- [测试插件](./ship/test.md)
- [打包并试装](./ship/package.md)
- [用真实模型验证](./ship/real-model.md)
- [发布与更新](./ship/publish.md)
- [合集](./ship/collections.md)

### `recipes/` 常见任务：已有基础后，怎样完成一个具体需求

- [概览](./recipes/index.md)
- [给世界预置任务、物品和好感](./recipes/starting-content.md)
- [开局配点和掷骰判定](./recipes/point-buy.md)
- [制作和分享主题](./recipes/themes.md)

### `reference/` 参考：字段、默认值和报错是什么

- [概览](./reference/index.md)
- 世界：[世界数据](./reference/world-data.md)、[世界模型](./reference/world-model.md)、[动态维度](./reference/dynamic-dimensions.md)、[世界时间](./reference/world-time.md)、[世界包安装](./reference/world-installation.md)
- 插件：[插件字段](./reference/plugins.md)、[工具](./reference/tools.md)、[Hook](./reference/hooks.md)、[扩展点](./reference/extension-points.md)、[插件扩展与通信](./reference/plugin-extensions.md)、[提示词结构](./reference/prompt-structure.md)、[插件安装](./reference/plugin-installation.md)
- 界面：[面板](./reference/ui-panels.md)、[界面组件](./reference/ui-components.md)、[主题包](./reference/theme-packages.md)、[多语言](./reference/i18n.md)
- 模型与媒体：[模型用途](./reference/slots.md)、[评估模型](./reference/evaluation.md)、[图像生成](./reference/image-generation.md)、[媒体存储](./reference/media-store.md)
- 接口与配置：[HTTP API](./reference/api.md)、[SSE 协议](./reference/protocol.md)、[事务](./reference/transactions.md)、[设置存储](./reference/settings-store.md)、[环境变量](./reference/env-registry.md)、[桌面配置](./reference/desktop-config.md)、[术语表](./reference/glossary.md)
- 字段表 [`schema/`](./reference/schema/index.md)：由 `pnpm schemas:generate` 生成，不要手改

这些页面被测试读取，改动后运行 `pnpm test:docs`：`tools.md` 和 `ui-panels.md`（内置插件的工具和面板必须都列在表里）、`hooks.md`（事件表的顺序和写法）、`env-registry.md`（每个环境变量都要出现）。

### `internals/` 原理与维护：它为什么这样执行，问题出在哪一层

- [概览](./internals/index.md)
- 原理：[设计原则](./internals/design-principles.md)、[回合管线](./internals/flow.md)、[包的职责](./internals/packages.md)、[存储](./internals/storage.md)、[安全边界](./internals/security.md)、[NPC 关系图](./internals/npc-graph.md)、[已知的限制](./internals/technical-debt.md)
- 参与开发：[命令](./internals/commands.md)、[浏览器端到端测试](./internals/e2e-testing.md)、[桌面打包与发布](./internals/desktop-packaging.md)、[开发 Agent 的技能](./internals/skills.md)、[v0.0.42 升级指南](./internals/upgrade-0.0.42.md)

### 其他

- [用开发 Agent 完成任务](./agent-workflow.md)
- [更新日志](./releases.md)：正文是 `docs/CHANGELOG.md`，由站点在构建时并入，不要在这个文件里写条目

## 英文版

`en/` 是英文版，每个中文页面在同样的相对路径下有一个英文页面，站点上在 `/docs/en/`。它是译文，不是第二份源文件：先改中文页，再在同一次改动里把同样的修改写进 `en/` 下的页面。规则见 [`AGENTS.md`](./AGENTS.md) 的 “The English edition”。

英文版最初由模型从中文翻译而来（正文用 haiku，框图用 sonnet），界面文字对照了应用的英文词典。发现译得不对的地方，直接改 `en/` 下的页面即可。

## 添加一页

1. 在对应章节的目录里新建 Markdown 文件。
2. 在 [`apps/docs/.vitepress/config.ts`](../apps/docs/.vitepress/config.ts) 的侧边栏里加上它。
3. 在本页的页面清单里加上它。
4. 在 `en/` 的同一路径下写出英文页；如果加了新的侧边栏文字，在配置的 `EN` 表里加上它的英文。
5. 运行 `pnpm --filter @covel/docs build`，确认没有失效链接。

## 站点怎样处理这些 Markdown

同一份 Markdown 要在 GitHub 和站点上都能读，所以站点做了几件事：

- 指向站点之外的相对链接（源码、插件的 README、`CONTRIBUTING.md`、`CHANGELOG.md`）会变成 GitHub 上同一文件的链接。
- 标题的锚点按 GitHub 的规则生成，所以同一个 `#锚点` 在两边都能跳转。
- 正文里的 `<名字>` 和 `{{ 名字 }}` 按普通文字显示，不需要转义。
- ` ```mermaid ` 代码块会画成图。

## 不属于站点的文件

`docs/` 根下这几个文件不是站点页面，站点上指向它们的链接会打开 GitHub：

| 文件                           | 用途                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `README.md`                    | 本页                                                        |
| `AGENTS.md` / `CLAUDE.md`      | 文档的写作规则                                              |
| `DOCS_STRATEGY.md`             | 文档怎样组织                                                |
| `CONTRIBUTING.md` / `.en.md`   | 贡献指南                                                    |
| `CHANGELOG.md`、`changelog.d/` | 版本发布记录和待发布的条目（`pnpm changelog:preview` 预览） |
| `world-art-prompts.json`       | 内置世界改图时用过的提示词记录                              |

任务计划、审查记录、实施日志、临时分析和交接材料属于开发过程资料，统一放在 `devs/docs/`，不进入这个目录。

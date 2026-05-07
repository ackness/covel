# Guides

`guide/` 放任务型文档。这里的页面面向作者和贡献者，目标是让读者完成一个具体工作；字段全集、协议细节和边界条件放在 [`../reference/`](../reference/)。

## Plugin Authoring

| Goal                         | Start here                                                             | Reference                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 选择插件开发路径             | [`plugin-authoring.md`](./plugin-authoring.md)                         | [`../reference/plugins.md`](../reference/plugins.md)                                                                       |
| 写纯 `PLUGIN.md` 插件        | [`plugin-authoring-zero-code.md`](./plugin-authoring-zero-code.md)     | [`../reference/tools.md`](../reference/tools.md)                                                                           |
| 加本地 JS、RPC action、交互  | [`plugin-authoring-agent.md`](./plugin-authoring-agent.md)             | [`../reference/api.md`](../reference/api.md)                                                                               |
| 写复杂 TypeScript 插件和审批 | [`plugin-authoring-advanced.md`](./plugin-authoring-advanced.md)       | [`../reference/plugins.md`](../reference/plugins.md)                                                                       |
| 写插件 UI                    | [`plugin-ui-runtime-guidelines.md`](./plugin-ui-runtime-guidelines.md) | [`../reference/ui-panels.md`](../reference/ui-panels.md), [`../reference/ui-components.md`](../reference/ui-components.md) |
| 测试插件                     | [`plugin-testing.md`](./plugin-testing.md)                             | [`e2e-plugin-verify.md`](./e2e-plugin-verify.md)                                                                           |

## App And Runtime

| Goal                       | Start here                                 | Reference                                                          |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| 配置桌面版数据目录和 token | [`desktop-config.md`](./desktop-config.md) | [`../reference/api.md`](../reference/api.md)                       |
| 配置环境变量               | [`env-registry.md`](./env-registry.md)     | `packages/shared/src/env/registry.ts`                              |
| 做主题包                   | [`themes.md`](./themes.md)                 | [`../reference/theme-packages.md`](../reference/theme-packages.md) |
| 写外部 Agent skill         | [`skills.md`](./skills.md)                 | `skills/`                                                          |
| 做浏览器 E2E               | [`e2e-testing.md`](./e2e-testing.md)       | [`e2e-plugin-verify.md`](./e2e-plugin-verify.md)                   |

## Writing Rules

- 教程先给最小可运行例子，再解释可选能力。
- 每个 guide 页面都要链接到对应 reference 页面。
- 不在 guide 里维护字段全集；字段全集放 `reference/`，guide 只写常用路径。
- 涉及实际代码的文档要给出可搜索路径或测试命令。

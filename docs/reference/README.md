# Framework Reference

`reference/` 是 Covel 的权威契约层。这里记录 API、协议、插件 frontmatter、工具、world data、UI spec、存储和主题包的合法字段与边界。内容需要和 `packages/shared/src/schemas/**`、`packages/shared/src/types/**`、`@covel/runtime`、`apps/server/src/routes/api/`、`apps/web/src/**` 保持一致。

> 文档总入口见 [`../README.md`](../README.md)；任务型教程见 [`../guide/`](../guide/)。

## Index

| Area                         | Page                                                       | Code source                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API                     | [`api.md`](api.md)                                         | `apps/server/src/routes/api/`, `packages/shared/src/types/rpc.ts`                                                                                   |
| Framework discovery          | [`api.md`](api.md#插件管理)                                | `apps/server/src/routes/api/framework.ts`, `apps/server/src/routes/api/plugins.ts`                                                                  |
| Protocol                     | [`protocol.md`](protocol.md)                               | `packages/shared/src/types/protocol.ts`, `apps/web/src/services/api/actions.ts`, `apps/web/src/services/subscription.ts`                            |
| Internationalization         | [`i18n.md`](i18n.md)                                       | `packages/shared/src/utils/i18n.ts`, `apps/web/src/lib/i18n-text.ts`, `apps/web/src/i18n/`                                                          |
| Plugin manifest and registry | [`plugins.md`](plugins.md)                                 | `packages/shared/src/schemas/plugin.ts`, `packages/plugin-loader/src/`, `plugins/**/PLUGIN.md`                                                      |
| Extension points             | [`extension-points.md`](extension-points.md)               | `packages/shared/src/extension-points/`, `packages/runtime/src/plugin-extension-registration.ts`                                                    |
| Plugin communication         | [`plugin-extensions.md`](plugin-extensions.md)             | `packages/runtime/src/plugin-services.ts`, `apps/server/src/routes/api/plugin-rpc/`                                                                 |
| World Model                  | [`world-model.md`](world-model.md)                         | `packages/shared/src/schemas/world-model.ts`, `packages/shared/src/proposals/world-model.ts`, `packages/store/src/`                                 |
| Dynamic dimensions           | [`dynamic-dimensions.md`](dynamic-dimensions.md)           | `packages/shared/src/schemas/dimensions.ts`, `packages/runtime/src/commit/commit-dimensions.ts`, `plugins/world-init/runtimes/`                     |
| Model evaluation             | [`evaluation.md`](evaluation.md)                           | `packages/ai-provider/src/evaluation/`, `packages/ai-provider/src/adapters/evaluation.ts`                                                           |
| LLM tools                    | [`tools.md`](tools.md)                                     | `packages/tools/src/`, `packages/runtime/src/agent-loop/turn-agent-tool-loop.ts`, `packages/runtime/src/function-runtime/turn-function-runtime.ts`  |
| World data descriptor        | [`world-data.md`](world-data.md)                           | `packages/shared/src/schemas/world-data.ts`, `apps/server/src/world-data/`                                                                          |
| Schema field tables          | [`schema/`](schema/README.md)                              | Generated from `packages/shared/src/schemas/` by `pnpm schemas:generate`; do not edit by hand                                                       |
| UI panels                    | [`ui-panels.md`](ui-panels.md)                             | `apps/web/src/components/session/`, `apps/web/src/lib/catalog/`, `apps/web/src/services/api/`                                                       |
| UI components                | [`ui-components.md`](ui-components.md)                     | `apps/web/src/lib/catalog/`, `apps/web/src/components/session/plugin-panel.tsx`, `apps/web/src/components/session/chat-messages/message-blocks.tsx` |
| Prompt structure             | [`prompt-structure.md`](prompt-structure.md)               | `packages/context/src/`, `packages/runtime/src/turn-executor/turn-runtime-execution.ts`, `packages/runtime/src/turn-executor/session-context.ts`    |
| Theme packages               | [`theme-packages.md`](theme-packages.md)                   | `apps/web/src/lib/theme-*.ts`, `packages/settings/src/`                                                                                             |
| Store transactions           | [`transactions.md`](transactions.md)                       | `packages/store/src/`                                                                                                                               |
| Image generation             | [`image-generation.md`](image-generation.md)               | `plugins/scene-stage/`, `packages/runtime/src/function-runtime/runtime-images-context.ts`, `packages/ai-provider/src/gateway.ts`                    |
| Media store                  | [`media-store.md`](media-store.md)                         | `packages/store/src/media-store.ts`, `packages/store/src/media-store/`                                                                              |
| Storage architecture         | [`../architecture/storage.md`](../architecture/storage.md) | `packages/store/src/`, `apps/web/src/services/storage/`, desktop path helpers                                                                       |

## How To Use This Directory

- 查合法字段、枚举、URI、默认值和错误条件时先看 `reference/`。
- 查“怎么一步步写出来”时看 [`../guide/`](../guide/)。
- 查“为什么这么设计”时看 [`../architecture/`](../architecture/)。
- 如果 `reference/` 和代码不一致，代码和测试是当前事实，文档需要同步修正。

## Naming And URI Conventions

| Syntax                   | Meaning                                                                                       | Example                           |
| ------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------- |
| `contract:<contractId>`  | World Data 的 schema / target URI；由活动插件声明的 `contributes.data.*.accepts` 定位接收者。 | `contract:character.blueprints@1` |
| `contract:<id>+lorebook` | 导入数据契约时同时写入世界所有的 Lorebook 条目；仅用于支持该投影的目标。                      | `contract:world.rules@1+lorebook` |
| `world:metadata.<path>`  | 导入结果写入 `WorldRecord.metadata` 子路径的内核目标。                                        | `world:metadata.dimensions`       |
| `covel://...`            | 框架内置 schema URI。                                                                         | `covel://world/dimensions`        |

插件私有数据的 `plugin://` schema 与 `plugin:` 导入目标不是当前 World Data 作者契约；世界包应使用版本化数据契约。

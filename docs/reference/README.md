# Framework Reference

`reference/` 是 Covel 的权威契约层。这里记录 API、协议、插件 frontmatter、工具、world data、UI spec、存储和主题包的合法字段与边界。内容需要和 `packages/shared/src/schemas/**`、`packages/shared/src/types/**`、`@covel/runtime`、`apps/server/src/routes/api/`、`apps/web/src/**` 保持一致。

> 文档总入口见 [`../README.md`](../README.md)；任务型教程见 [`../guide/`](../guide/)。

## Index

| Area                         | Page                                                       | Code source                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API                     | [`api.md`](api.md)                                         | `apps/server/src/routes/api/`, `packages/shared/src/types/rpc.ts`                                                                                   |
| Framework discovery          | [`api.md`](api.md#插件管理)                                | `apps/server/src/routes/api/framework.ts`, `apps/server/src/routes/api/plugins.ts`                                                                  |
| Protocol                     | [`protocol.md`](protocol.md)                               | `packages/shared/src/types/protocol.ts`, `apps/web/src/services/api/actions.ts`, `apps/web/src/services/subscription.ts`                            |
| Plugin manifest and registry | [`plugins.md`](plugins.md)                                 | `packages/shared/src/schemas/plugin.ts`, `packages/plugin-loader/src/`, `plugins/**/PLUGIN.md`                                                      |
| LLM tools                    | [`tools.md`](tools.md)                                     | `packages/tools/src/`, `packages/runtime/src/agent-loop/turn-agent-tool-loop.ts`, `packages/runtime/src/function-runtime/turn-function-runtime.ts`  |
| World data descriptor        | [`world-data.md`](world-data.md)                           | `packages/shared/src/schemas/world-data.ts`, `apps/server/src/world-data/`                                                                          |
| UI panels                    | [`ui-panels.md`](ui-panels.md)                             | `apps/web/src/components/session/`, `apps/web/src/lib/catalog/`, `apps/web/src/services/api/`                                                       |
| UI components                | [`ui-components.md`](ui-components.md)                     | `apps/web/src/lib/catalog/`, `apps/web/src/components/session/plugin-panel.tsx`, `apps/web/src/components/session/chat-messages/message-blocks.tsx` |
| Prompt structure             | [`prompt-structure.md`](prompt-structure.md)               | `packages/context/src/`, `packages/runtime/src/turn-executor/turn-runtime-execution.ts`, `packages/runtime/src/turn-executor/session-context.ts`    |
| Theme packages               | [`theme-packages.md`](theme-packages.md)                   | `apps/web/src/lib/theme-*.ts`, `packages/settings/src/`                                                                                             |
| Store transactions           | [`transactions.md`](transactions.md)                       | `packages/store/src/`                                                                                                                               |
| Media store                  | [`media-store.md`](media-store.md)                         | `packages/store/src/media-store.ts`, `packages/store/src/media-store/`                                                                              |
| Storage architecture         | [`../architecture/storage.md`](../architecture/storage.md) | `packages/store/src/`, `apps/web/src/services/storage/`, desktop path helpers                                                                       |

## How To Use This Directory

- 查合法字段、枚举、URI、默认值和错误条件时先看 `reference/`。
- 查“怎么一步步写出来”时看 [`../guide/`](../guide/)。
- 查“为什么这么设计”时看 [`../architecture/`](../architecture/)。
- 如果 `reference/` 和代码不一致，代码和测试是当前事实，文档需要同步修正。

## Naming And URI Conventions

| Syntax                            | Meaning                                                                 | Example                                   |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `plugin://<pluginId>/<namespace>` | schema URI；声明数据应按哪个插件 namespace 的 schema 校验。             | `plugin://character-blueprint/blueprints` |
| `plugin:<pluginId>/<namespace>`   | world data target URI；声明导入结果写到哪个 `plugin_data` namespace。   | `plugin:character-blueprint/blueprints`   |
| `world:metadata.<path>`           | world data target URI；声明导入结果写入 `WorldRecord.metadata` 子路径。 | `world:metadata.dimensions`               |
| `covel://...`                     | 框架内置 schema URI。                                                   | `covel://world/dimensions`                |

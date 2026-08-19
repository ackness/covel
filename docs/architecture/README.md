# Architecture

`architecture/` 记录 Covel 的系统边界、执行流程和长期设计决策。这里解释“为什么”和“模块怎么连接”；字段全集和对外契约放在 [`../reference/`](../reference/)。

## Pages

| Page                                             | Use it for                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [`design-principles.md`](./design-principles.md) | 设计理念：内核提供原语 / 插件承载玩法、插头 vs 电器裁决、三种写法、可表达边界。 |
| [`flow.md`](./flow.md)                           | 端到端 turn pipeline、状态模型、插件执行、前后端数据流。                        |
| [`npc-graph.md`](./npc-graph.md)                 | `npc-graph` 插件、Graph-RAG、embedding、图数据与 UI 面板。                      |
| [`storage.md`](./storage.md)                     | DataStore 后端、事务与持久化边界。                                              |
| [`technical-debt.md`](./technical-debt.md)       | 当前有意保留的实现上限，以及触发升级的可观测条件。                              |

## Search Anchors

| Topic               | Code paths                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Turn execution      | `packages/runtime/src/turn-executor/`, `packages/runtime/src/schedule/`, `packages/runtime/src/trigger/trigger.ts` |
| Prompt assembly     | `packages/context/src/`, `docs/reference/prompt-structure.md`                                                      |
| Plugin loading      | `packages/plugin-loader/src/`, `plugins/**/PLUGIN.md`                                                              |
| Server API          | `apps/server/src/routes/api/`                                                                                      |
| Frontend session UI | `apps/web/src/components/session/`, `apps/web/src/services/`                                                       |
| Store backends      | `packages/store/src/`                                                                                              |

## Writing Rules

- 架构页需要说明模块边界、数据流、失败模式和对应 reference 页面。
- 历史设计可以保留，但当前契约要明确指向 `reference/` 或代码。
- 草案、审查和迁移计划放在 `devs/docs/`；实现落地后把面向维护者的稳定设计迁入本目录或 `reference/`。

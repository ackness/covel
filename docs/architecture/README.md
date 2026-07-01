# Architecture

`architecture/` 记录 Covel 的系统边界、执行流程和长期设计决策。这里解释“为什么”和“模块怎么连接”；字段全集和对外契约放在 [`../reference/`](../reference/)。

## Pages

| Page                                                         | Use it for                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [`design-principles.md`](./design-principles.md)             | 设计理念：内核提供原语 / 插件承载玩法、插头 vs 电器裁决、三种写法、可表达边界。 |
| [`flow.md`](./flow.md)                                       | 端到端 turn pipeline、状态模型、插件执行、前后端数据流。                        |
| [`npc-graph.md`](./npc-graph.md)                             | `npc-graph` 插件、Graph-RAG、embedding、图数据与 UI 面板。                      |
| [`changelog-session-state.md`](./changelog-session-state.md) | session state 和 narrative flow 的历史变更记录。                                |

## Search Anchors

| Topic               | Code paths                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn execution      | `packages/runtime/src/turn-executor.ts`, `packages/runtime/src/turn-runtime-execution.ts`, `packages/runtime/src/turn-executor/`, `packages/runtime/src/trigger.ts` |
| Prompt assembly     | `packages/context/src/`, `docs/reference/prompt-structure.md`                                                                                                       |
| Plugin loading      | `packages/plugin-loader/src/`, `plugins/**/PLUGIN.md`                                                                                                               |
| Server API          | `apps/server/src/routes/api/`                                                                                                                                       |
| Frontend session UI | `apps/web/src/components/session/`, `apps/web/src/services/`                                                                                                        |
| Store backends      | `packages/store/src/`                                                                                                                                               |

## Writing Rules

- 架构页需要说明模块边界、数据流、失败模式和对应 reference 页面。
- 历史设计可以保留，但当前契约要明确指向 `reference/` 或代码。
- 草案和迁移计划保持为内部资料；实现落地后把稳定部分迁入本目录或 `reference/`。

# 已知的限制

这一页列出源码里有意保留的限制。每一处都用一条 `ponytail:` 注释标在代码里；这里的每一行写明接受了什么限制，以及出现什么情况时该回头处理它。想知道“这里为什么写得这么简单”，或者准备改动其中一处的人，读这一页。

这是一份当前的清单，不是已修复问题的历史记录。用下面的命令找出当前所有的标记：

```bash
rg -n "ponytail:" apps packages plugins
```

当前源码里有 13 个标记，下面三张表每行对应一个。

> [!IMPORTANT]
> 增加或删除一条 `ponytail:` 注释时，在同一次改动里更新这一页。

## Kernel / runtime

| 位置                                                             | 接受的限制                                                                           | 什么时候重新考虑                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/runtime/src/schedule/effects.ts`                       | 对 `self` 字面量做字符串相等比较，可能把不同插件的 effects 误判为相同                | 误报的冲突多到值得把 `self` 解析成插件 ID                             |
| `packages/runtime/src/function-runtime/turn-function-runtime.ts` | 撤销只在新调用进入时检查；已经发出的外部效果可能在期限之后才结束                     | 原语需要协作式取消，或者需要用 worker 隔离迟到的外部效果              |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts`   | 带 `accepts` 的消费者每次都重新加载生产者声明的输出 schema                           | 性能分析显示重复的工作多到值得做每回合的 schema 缓存                  |
| `packages/runtime/src/retry/llm-slots.ts`                        | 所有 LLM provider 共用一个进程级的并发上限                                           | 互相独立的 provider 需要各自的容量                                    |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts`  | 恢复（resume）数据进入工具循环前不检查其中的 MediaRef；提交时才把要保存的内容规范化  | 一个恢复的 runtime 在任何 proposal 带上某个媒体引用之前就对它做了操作 |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts`  | 验收场景 12 和 19-25（plan/confirm 启用流程、持久化的审批授权）是 `it.todo`          | 启用解析器或持久化的审批授权排进了实现计划                            |
| `packages/events/src/event-bus.ts`                               | 接收顺序的状态按最近使用淘汰；被淘汰的流必须从序号 1 重新开始，它的会话会 reset 一次 | 多 pod 部署同时活跃的流多于上限，值得加每条状态的 TTL 或更大的上限    |
| `packages/store/src/media-store/filter.ts`                       | 按元数据过滤时扫描整个 `listAssets()`                                                | 单个会话的媒体数量多到值得把过滤条件下推到 SQL                        |

## Server

| 位置                                         | 接受的限制                                                     | 什么时候重新考虑                 |
| -------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| `apps/server/src/routes/api/turn-control.ts` | 用进程内的 map 记录，steer/abort 只对正在执行该回合的 pod 有效 | 多 pod 部署需要跨 pod 的回合控制 |

## Web UI

| 位置                                                                   | 接受的限制                                        | 什么时候重新考虑                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `apps/web/src/components/session/stage/StageSprites.tsx`               | 最多四个立绘对 `left`、`width` 这类布局属性做动画 | 登场角色更多或更频繁，值得改成基于 transform 的动画 |
| `apps/web/src/components/session/stage/stage-selectors.ts`             | 选项的 icon/color 字段目前没有使用者              | 有组件用到这些字段                                  |
| `apps/web/src/components/session/chat-messages/message-primitives.tsx` | Markdown 的软换行用字符串改写实现                 | 代码块的边界情况或其他转换多到值得改用解析器插件    |
| `apps/web/src/theme-system/token-schema.ts`                            | 氛围背景只接受 URL 和渐变，不能上传本地图片       | 上传的需求多到值得把图片存到设置数据之外            |

## Oversized modules

下面是超过 800 行的非测试源文件。800 行是 [AGENTS.md](../../AGENTS.md) 里的评审参考线，不是硬性上限。

- 只有当职责或维护成本确实需要时才拆分。长度本身不是缺陷。
- 行数会变。动手之前用 `wc -l` 重新量一次。
- 表里只统计 `apps/` 和 `packages/` 下的 TypeScript 源文件，不含测试，也不含 `packages/store/src/contract/` 里各存储后端共用的测试套件。

| File                                                          | Lines |
| ------------------------------------------------------------- | ----: |
| `packages/shared/src/schemas/plugin-schemas.ts`               |  1258 |
| `packages/ai-provider/src/gateway.ts`                         |  1225 |
| `apps/server/src/routes/api/actions.ts`                       |  1165 |
| `packages/runtime/src/turn-executor/turn-executor.ts`         |  1065 |
| `apps/server/src/world-data/session-import.ts`                |  1005 |
| `packages/settings/src/store.ts`                              |   996 |
| `apps/server/src/routes/api/plugin-rpc/runtime-job-worker.ts` |   996 |
| `apps/server/src/world-data/validate-world-package.ts`        |   988 |
| `packages/runtime/src/agent-loop/turn-agent-tool-loop.ts`     |   979 |
| `packages/store/src/types.ts`                                 |   976 |
| `apps/web/src/stores/session-store/actions.ts`                |   958 |
| `apps/web/src/services/data-service/local.ts`                 |   954 |
| `packages/plugin-handlers-utils/src/plugin-api.ts`            |   950 |
| `apps/server/src/routes/api/bootstrap.ts`                     |   944 |
| `packages/events/src/event-bus.ts`                            |   918 |
| `apps/server/src/routes/api/bootstrap/plugin-entry.ts`        |   889 |
| `packages/runtime/src/retry/llm-retry.ts`                     |   875 |
| `packages/runtime/src/interaction/interaction-submission.ts`  |   845 |
| `packages/plugin-handlers-utils/src/dimension-schemas.ts`     |   845 |
| `packages/runtime/src/commit/finalize-execution.ts`           |   838 |
| `apps/web/src/stores/session-store/reducer.ts`                |   837 |
| `apps/web/src/stores/session-store/sse-handler.ts`            |   827 |
| `packages/create/src/create-world.ts`                         |   823 |
| `packages/runtime/src/schedule/input-bindings.ts`             |   821 |
| `apps/server/src/routes/api/ai.ts`                            |   817 |
| `apps/server/src/routes/api/plugin-rpc/jobs.ts`               |   815 |
| `apps/server/src/routes/api/plugin-rpc/runtime-turn.ts`       |   803 |

这份清单跟着当前源码里的注释走。历史上的数量和行号不是当前的契约。

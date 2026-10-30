# 已知的限制

这一页列出源码里有意保留的限制。每一处都用一条 `ponytail:` 注释标在代码里；这里的每一行写明接受了什么限制，以及出现什么情况时该回头处理它。想知道“这里为什么写得这么简单”，或者准备改动其中一处的人，读这一页。

这是一份当前的清单，不是已修复问题的历史记录。用下面的命令找出当前所有的标记：

```bash
rg -n "ponytail:" apps packages plugins
```

> [!IMPORTANT]
> 增加或删除一条 `ponytail:` 注释时，在同一次改动里更新这一页。
> `pnpm check:scripts` 和 `pnpm test:docs` 检查每个标记在中英文清单里各有一行，也检查没有标记的条目是否已删除。

## Kernel / runtime

<!-- prettier-ignore -->
| 位置 | 接受的限制 | 什么时候重新考虑 |
| --- | --- | --- |
| `packages/runtime/src/schedule/effects.ts` | 对 `self` 字面量做字符串相等比较，可能把不同插件的 effects 误判为相同 | 误报的冲突多到值得把 `self` 解析成插件 ID |
| `packages/runtime/src/function-runtime/plugin-runtime-context.ts` | 撤销只在新调用进入时检查；已经发出的外部效果可能在期限之后才结束 | 原语需要协作式取消，或者需要用 worker 隔离迟到的外部效果 |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts` | 带 `accepts` 的消费者每次都重新加载生产者声明的输出 schema | 性能分析显示重复的工作多到值得做每回合的 schema 缓存 |
| `packages/shared/src/llm-slots.ts` | 所有 LLM provider 共用一个进程级的并发上限 | 互相独立的 provider 需要各自的容量 |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts` | 恢复（resume）数据进入工具循环前不检查其中的 MediaRef；提交时才把要保存的内容规范化 | 一个恢复的 runtime 在任何 proposal 带上某个媒体引用之前就对它做了操作 |
| `packages/runtime/tests/scheduling-acceptance-contract.test.ts` | 场景 12 的插件版本复核已经实现。恢复请求有审批预检，新输出有 schema 校验；但还没有按当前 spec 和审批版本复核保存的 continuation，也不按当前 effects 声明复核其中已缓冲的写入。场景 19-25（plan/confirm 启用流程、持久化的审批授权）仍是 `it.todo` | 启用解析器或持久化的审批授权排进了实现计划 |
| `packages/events/src/event-bus.ts` | 接收顺序的状态按最近使用淘汰；被淘汰的流必须从序号 1 重新开始，它的会话会 reset 一次。发送队列达到上限时丢掉的若是会话最后几帧，之后没有新帧，接收方就发现不了，也不会 reset。只读的 `headCursor` 也会建立会话跟踪状态，和订阅共用会话数上限 | 多 pod 部署同时活跃的流多于上限，值得加每条状态的 TTL 或更大的上限 |
| `packages/create/src/world-writer.ts` | 替换世界目录靠改名和失败时恢复，没有崩溃日志。进程在两次改名之间崩溃，会留下 `.covel-replaced-*/package` 备份，需要手动恢复 | 有人报告崩溃后世界丢失，或者留下了备份目录 |
| `packages/memory/src/archival-search.ts` | 关键词检索每次读出会话的整个可搜索归档，再排序 | 归档条目多到关键词检索明显变慢 |

## Storage

<!-- prettier-ignore -->
| 位置 | 接受的限制 | 什么时候重新考虑 |
| --- | --- | --- |
| `packages/store/src/media-store/pg.ts` | 按元数据查媒体时，先取出会话拥有的全部资产，再在 JS 里比较。PostgreSQL 和 SQLite（`packages/store/src/media-store/sqlite.ts`）都不把过滤下推到 SQL，以保持结果一致 | 单个会话的媒体多到几千条 |
| `packages/store/src/common/write-order-ddl.ts` | PostgreSQL 每次取写入序号都锁住会话的计数行，直到提交。删除会话时，记录变更的触发器逐行执行。`record_changes` 为每个记录键保留最后的变更序号，会话存续期间不清理，删除的键也保留 | 出现绕过会话锁的写入路径、删除大会话明显变慢，或者 `record_changes` 的体积成为问题 |
| `packages/store/src/sqlite/schema.ts` | `turn_messages` 在两个 SQL 后端都有六个二级索引，写入成本尚未测量。PostgreSQL（`packages/store/src/postgres/schema.ts`）的索引用数据库默认排序规则，查询却按 `id COLLATE "C"` 排序；索引前三列相同的行仍可能需要增量排序，实际计划待 `EXPLAIN` 确认。单列 `session_id` 索引虽是复合索引的前缀，仍然保留 | 长会话的写入变慢，或者 PostgreSQL 的 `EXPLAIN` 显示排序成本 |

## Server

<!-- prettier-ignore -->
| 位置 | 接受的限制 | 什么时候重新考虑 |
| --- | --- | --- |
| `apps/server/src/routes/api/turn-control.ts` | 用进程内的 map 记录，steer/abort 只对正在执行该回合的 pod 有效 | 多 pod 部署需要跨 pod 的回合控制 |
| `apps/server/src/lib/pg-event-transport.ts` | NOTIFY 不设超时，也没有取消查询的路径。连接半开时，发送会卡在 postgres.js，后续帧积压在事件总线的有界队列里；队列满后丢帧并写告警。只让等待超时，会把积压转移到客户端队列 | postgres.js 能真正取消查询，或者生产环境出现半开连接 |
| `apps/server/src/routes/api/session/delete-route.ts` | 会话删除成功、释放媒体占用却失败时，占用继续保护对应文件，失败只写日志。没有路由能为已删除的会话补做释放 | 日志里经常出现释放失败，或者磁盘被这些文件占满 |

## Web UI

| 位置                                                                   | 接受的限制                                        | 什么时候重新考虑                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `apps/web/src/components/session/stage/StageSprites.tsx`               | 最多四个立绘对 `left`、`width` 这类布局属性做动画 | 登场角色更多或更频繁，值得改成基于 transform 的动画 |
| `apps/web/src/components/session/chat-messages/message-primitives.tsx` | Markdown 的软换行用字符串改写实现                 | 代码块的边界情况或其他转换多到值得改用解析器插件    |
| `apps/web/src/theme-system/token-schema.ts`                            | 氛围背景只接受 URL 和渐变，不能上传本地图片       | 上传的需求多到值得把图片存到设置数据之外            |

## Oversized modules

下面是超过 800 行的非测试源文件。800 行只是本清单的统计门槛；[AGENTS.md](../../AGENTS.md) 要求按职责和维护成本拆分，不设行数上限。

- 只有当职责或维护成本确实需要时才拆分。长度本身不是缺陷。
- 行数会变。动手之前用 `wc -l` 重新量一次。
- 表里只统计 `apps/` 和 `packages/` 下的 TypeScript 源文件，不含测试，也不含 `packages/store/src/contract/` 里各存储后端共用的测试套件。

<!-- prettier-ignore -->
| File | Lines |
| --- | ---: |
| `apps/server/src/routes/api/actions.ts` | 1594 |
| `packages/runtime/src/agent-loop/turn-agent-tool-loop.ts` | 1496 |
| `apps/server/src/world-data/validate-world-package.ts` | 1359 |
| `packages/runtime/src/commit/finalize-execution.ts` | 1295 |
| `packages/ai-provider/src/gateway.ts` | 1266 |
| `packages/shared/src/schemas/plugin-schemas.ts` | 1246 |
| `packages/runtime/src/turn-executor/turn-executor.ts` | 1082 |
| `apps/server/src/routes/api/bootstrap.ts` | 1028 |
| `packages/store/src/types.ts` | 1026 |
| `apps/server/src/routes/api/plugin-rpc/runtime-job-worker.ts` | 1025 |
| `apps/server/src/world-data/session-import.ts` | 1009 |
| `packages/settings/src/store.ts` | 996 |
| `apps/web/src/stores/session-store/actions.ts` | 992 |
| `packages/events/src/event-bus.ts` | 982 |
| `packages/plugin-handlers-utils/src/plugin-api.ts` | 980 |
| `apps/server/src/world-data/session-import/planning.ts` | 926 |
| `apps/web/src/stores/session-store/reducer.ts` | 915 |
| `packages/runtime/src/retry/llm-retry.ts` | 903 |
| `packages/plugin-loader/src/load.ts` | 898 |
| `packages/shared/src/types/protocol.ts` | 872 |
| `apps/server/src/routes/api/plugin-rpc/jobs.ts` | 867 |
| `packages/runtime/src/interaction/interaction-submission.ts` | 863 |
| `apps/server/src/routes/api/plugin-rpc/runtime-turn.ts` | 861 |
| `packages/plugin-handlers-utils/src/dimension-schemas.ts` | 852 |
| `packages/create/src/create-world.ts` | 849 |
| `apps/server/src/routes/api/ai.ts` | 841 |
| `apps/server/src/routes/api/bootstrap/plugin-entry.ts` | 838 |
| `apps/desktop/src/main.ts` | 820 |
| `packages/runtime/src/turn-executor/turn-runtime-execution.ts` | 816 |

这份清单跟着当前源码里的注释走。历史上的数量和行号不是当前的契约。

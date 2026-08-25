# 静态证据索引

行号以 `codex/architecture-simplification-v2` 静态审计时版本为准。若后续格式化导致行号漂移，以列出的 symbol 为权威定位。

## 1. UI、创建与 workspace

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| start button 与 payload | `apps/web/src/components/session/session-prep-screen.tsx:203-220` | 防重复提交并把选中插件交给创建流程 |
| 创建、hydrate、发布、失败回滚 | `apps/web/src/stores/session-store/start-game.ts:87-154` | 只发布权威 mirror；失败删除半成品 session |
| start/action 主入口 | `apps/web/src/stores/session-store/actions.ts:133-177,248-305` | `start_session`、普通消息和命令统一经过 workspace |
| 表单提交 | `apps/web/src/stores/session-store/actions.ts:375-445` | submit RPC 与后续 narrative action 位于同 session FIFO |
| framework RPC 调用 | `apps/web/src/services/api/sessions.ts:192-221` | `submit-form` 显式 action |
| per-session FIFO | `apps/web/src/services/data-service/workspace.ts:1-159` | prepare -> stage -> mutate -> commit；remote no-op |
| 本地恢复 | `apps/web/src/services/data-service/local.ts:523-628` | pending commit 恢复、server mirror 重建、current clock 保留 |
| server checkpoint | `apps/server/src/routes/api/browser-workspace.ts:54-145,149-233` | scope/revision 校验、mirror 替换、commit export/cache |

## 2. Session 创建与插件激活

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| current clock 初始化 | `apps/server/src/routes/api/session.ts:365-400` | setup 是否存在决定 phase；未知 plugin 拒绝 |
| create transaction | `apps/server/src/routes/api/session.ts:408-467` | session、world import、blueprint fallback 同事务 |
| registry activation | `apps/server/src/routes/api/session.ts:488-490` | 创建完成后按解析集合激活 |
| core/requested 解析 | `apps/server/src/routes/api/session/plugins.ts:29-66` | 初始候选集合 |
| requires/conflicts | `apps/server/src/routes/api/session/plugins.ts:69-170` | 依赖展开、冲突解析、不满足依赖剔除 |
| world import | `apps/server/src/world-data/session-import.ts:40-130` | 当前 descriptor plan 与导入行为 |

## 3. Action 契约与 route

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| action 判别联合 | `apps/server/src/routes/api/actions/request.ts:16-39` | 五类 action；`retry_runtime` 必须有 id，`retry_turn` 空 payload |
| fail-closed validator | `apps/server/src/routes/api/actions/request.ts:150-254` | 每种 payload 独立校验，拒绝未知形态 |
| owner/status/plugin 检查 | `apps/server/src/routes/api/actions.ts:114-192` | 空消息仅用于 start/retry；非空 action 要求 active plugin |
| SSE write scope | `apps/server/src/routes/api/actions.ts:215-305` | 串行 writer、从事件目录派生的 forwarding whitelist、锁内订阅 |
| session lock 与 incarnation | `apps/server/src/routes/api/actions.ts:311-463` | 锁内重读 session，拒绝 stale 状态，按持久化插件同步 registry |
| execution identity | `apps/server/src/routes/api/actions.ts:536-566` | 规范 origin 与 retry 区分 |
| executeTurn deps | `apps/server/src/routes/api/actions.ts:575-657` | route 注入 prompt/runtime/store 等明确依赖 |
| finalize 输入 | `apps/server/src/routes/api/actions.ts:662-755` | 主/嵌套结果、journal、suspension、player write、clock 一次交给 finalize |
| commit barrier | `apps/server/src/routes/api/actions.ts:760-824` | snapshot、completion 和事件 teardown 位于正确提交边界 |
| background follower | `apps/server/src/routes/api/actions.ts:826-897` | 主锁释放后的后台执行 |
| opening continuation | `apps/server/src/routes/api/actions.ts:900-948` | setup -> playing 后恰好追加一次，retry 排除 |

## 4. Runtime 调度

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| current session load | `packages/runtime/src/turn-executor/session-state.ts:44-153` | 直接读取 phase/count/setupRuntimes，无旧字段推导 |
| count policy | `packages/runtime/src/turn-executor/execution-context.ts:7-30` | 只有 player + playing 满足计数策略 |
| runtime gate | `packages/runtime/src/turn-executor/scheduling.ts:128-196` | manual exact；setup pending/phase/auto；main trigger |
| stage 与 DAG | `packages/runtime/src/turn-executor/scheduling.ts:199-262` | setup 声明边；main 严格 barrier；cycle 无 fallback |
| DAG 算法 | `packages/runtime/src/schedule/dag-scheduler.ts:145-245` | Kahn levels、名称稳定排序、cycle 检测 |
| input binding | `packages/runtime/src/schedule/input-bindings.ts:258-390` | provider cardinality、schema compatibility、runtime gate |
| event chain | `packages/runtime/src/trigger/turn-event-chain.ts:137-242` | follower 扇出、background 延迟、per-turn 去重 |
| setup completion | `packages/runtime/src/turn-executor/pre-game-completion.ts:23-74` | 只收集 newly done；显式 done/skip；不直接写 store |
| turn orchestration | `packages/runtime/src/turn-executor/turn-executor.ts:650-825` | 调度、执行、fanout 和 completion 的主控制流 |

## 5. Setup manifests 与提交表单

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| pregame | `plugins/pregame/PLUGIN.md:2-19` | setup function、显式 auto |
| schema-gen | `plugins/world-init/runtimes/schema-gen/PLUGIN.md:2-27` | setup、after pregame、显式 auto |
| player-init | `plugins/char-creator/runtimes/player-init/PLUGIN.md:2-46` | setup、needs 两个 runtime、input injection |
| player guard | `plugins/char-creator/runtimes/player-init/guard.js:25-118` | 已有玩家/提交的确定性创建；无提交时生成表单 |
| submit validation | `packages/runtime/src/rpc-defaults/submit-form.ts:379-429` | 字段、interaction、payload 校验 |
| submit transaction | `packages/runtime/src/rpc-defaults/submit-form.ts:450-521` | committed interaction 查找、幂等、player input 保存 |
| trusted dispatch lock | `apps/server/src/routes/api/plugin-rpc.ts:748-835` | session lock、current session/incarnation 校验 |

## 6. Prompt 与输出规范化

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| prompt variables | `packages/context/src/prompt-internals.ts:345-395` | inputs/world/session/player/userSettings |
| current user/cue | `packages/context/src/prompt-internals.ts:405-429` | 非空玩家消息或确定性的 execution cue |
| prompt 结构 | `packages/context/src/prompt-assembler.ts:330-385` | system、history、current user、depth、notes、budget |
| runtime prompt | `packages/runtime/src/agent-loop/turn-agent-runtime.ts:152-260` | history 过滤、settings、event directory、session context、prune/hook |
| output normalizer | `packages/runtime/src/commit/session-output-normalizer.ts` | runtime 输出转为统一 proposal |

## 7. Finalize、store 与快照

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| finalize contract | `packages/runtime/src/commit/finalize-execution.ts:284-302` | 所有提交输入和 clock decision |
| suspension 缓冲 | `packages/runtime/src/commit/finalize-execution.ts:348-362` | artifact 写入事务，事件延后 |
| required transaction | `packages/runtime/src/commit/finalize-execution.ts:403-481` | 所有结果、journal、extra write、suspension、clock 同事务；成功后事件 |
| session clock | `packages/runtime/src/commit/session-clock.ts:33-92` | count/setup 条件、logical ledger 幂等、三字段更新 |
| Session 类型 | `packages/shared/src/types/session.ts:18-30` | current clock 字段必填 |
| DataStore 类型 | `packages/store/src/types.ts:702-740` | root store 的必选 transaction contract |
| session mapper | `packages/store/src/common/mappers/session-mappers.ts:9-107` | current-only 严格映射 |
| snapshot mapper | `packages/store/src/common/mappers/snapshot-mappers.ts:53-87` | 只接受 schemaVersion 3 |
| artifact namespace | `packages/runtime/src/suspension-artifact.ts` | 保留字符串是校验 namespace，不是旧 API |

## 8. Protocol 与 Web 收敛

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| 事件目录 | `packages/shared/src/types/protocol.ts:382-475` | `CovelEventType` 和 metadata 穷举；无旧 alias |
| forwarded set | `packages/shared/src/types/protocol.ts:477-490` | server 转发集合从目录派生 |
| narrative/UI reducer | `apps/web/src/stores/session-store/sse-handler.ts:239-335` | delta、completed、interaction、ui、state |
| domain reducer | `apps/web/src/stores/session-store/sse-handler.ts:413-535` | completion、suspension、event、plugin data、character、assets |
| error/exhaustive | `apps/web/src/stores/session-store/sse-handler.ts:547-630` | 错误、proposal failure、显式忽略、穷举 default |
| shared reducers | `apps/web/src/stores/session-store/event-reducers.ts:49-107` | plugin-data、suspend、resume 收敛 |
| stream client | `apps/web/src/services/api/actions.ts:23-64` | data-only SSE 消费，无第二套状态协议 |

## 9. 传统与对话模式 manifests

| 证据 | 文件与范围 | 证明内容 |
| --- | --- | --- |
| RAG pre-turn | `plugins/npc-graph/runtimes/rag-retriever/PLUGIN.md:2-20` | scheduled pre-turn retrieval |
| traditional narrator | `plugins/narrator/PLUGIN.md:2-32` | narrative auto、capability、与 chat 冲突 |
| chat narrator | `plugins/chat-mode-narrator/PLUGIN.md:2-54` | narrative auto、同 capability、与传统模式冲突、对话依赖 |
| scene cast | `plugins/scene-cast/PLUGIN.md:2-25` | pre-turn scheduled |
| guide | `plugins/guide/PLUGIN.md:10-47` | post-turn、需要 narrative-engine、输入注入 |
| codex | `plugins/codex/PLUGIN.md:13-47` | post-turn、需要 narrative-engine、输入注入 |
| graph extractor | `plugins/npc-graph/runtimes/extractor/PLUGIN.md:9-57` | post-turn、需要 narrative-engine、输入注入 |
| character tracker | `plugins/char-creator/runtimes/character-tracker/PLUGIN.md:9-47` | post-turn、需要 narrative-engine、输入注入 |
| scene prompts | `plugins/scene-prompts/PLUGIN.md:10-49` | dialogue post-turn 与 capability gate |
| manual presence | `plugins/character-presence/PLUGIN.md:10-24` | stage-less manual；active 不等于 auto |
| manual rules | `plugins/living-world-rules/PLUGIN.md:10-24` | stage-less manual；active 不等于 auto |

## 10. 动态验证记录位置

验证命令和结果摘要记录在本目录 [README.md](./README.md) 的“动态验证基线”。这些命令在最后一次代码修复后、静态审计开始前运行。静态审计期间没有运行任何动态程序。

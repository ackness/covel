# 静态控制流与数据流

## 总览

```text
SessionPrepScreen
  -> DataService.createSession
  -> SessionWorkspace.hydrate
  -> publish authoritative mirror
  -> start_session / submit-form / send_message / retry_*
  -> POST /api/actions (session lock + closed payload validation)
  -> registry sync from persisted activePlugins
  -> load current session clock
  -> schedule setup/main/event runtimes
  -> assemble prompt + run agent/runtime
  -> normalize outputs into proposals
  -> finalizeExecution(one required transaction)
       proposals + journal + suspensions + player input + session clock
  -> post-commit Covel events
  -> SSE reducer / workspace checkpoint commit
```

本地数据路径在最外层多一层持久化协议：

```text
SessionWorkspace FIFO
  -> prepare authoritative checkpoint
  -> stage pending action id in BrowserVault
  -> mutate through server action
  -> fetch committed checkpoint
  -> atomically replace local authoritative state
```

commit 失败时 pending action id 保留；应用重启后先恢复该 commit，禁止直接上传一个更旧的本地镜像。remote workspace 不保存本地镜像，但保持相同接口和调用顺序。

## 分阶段核对

| 阶段 | 期望 | 实际实现 | 差异 | 影响 | 主要证据 |
| --- | --- | --- | --- | --- | --- |
| 准备页 | 创建期间防重复；只在 server 成功且镜像 hydrate 后发布 session | start button 有 in-flight 门禁；创建失败会删除半成品；发布发生在 workspace hydrate 后 | 无 | UI 不会看到未 hydrate 的 session | `session-prep-screen.tsx`、`start-game.ts` |
| 插件解析 | 由当前 manifest 的 requires/conflicts/capabilities 决定激活集合 | core + requested 展开 requires，解析 conflicts，再剔除无法满足依赖的插件 | 无 | 激活集合可复现，不依赖旧列表 fallback | `session/plugins.ts` |
| 会话创建 | current clock 一次写入；world data 与 blueprint 同事务 | `phase` 由 setup runtime 是否存在决定；`completedPlayerTurns=0`；setup 状态显式生成 | 无 | 创建后即可直接调度，无 lazy backfill | `session.ts`、`session-import.ts` |
| 本地工作区 | 同 session 串行，失败 commit 可恢复 | 每个 session 一个 FIFO；pending commit 持久化；server 重启后可从 checkpoint 重建瞬态 mirror | 无 | 消除 coordinator 竞态和时钟回退 | `workspace.ts`、`local.ts`、`browser-workspace.ts` |
| action 协议 | action 必须是闭合判别联合，未知字段和模糊语义 fail closed | `send_message`、`execute_command`、`start_session`、`retry_runtime`、`retry_turn` 各自独立验证 | 无 | 整回合重试不再借用缺省 `runtimeId` | `actions/request.ts` |
| action 入口 | owner/status/incarnation 校验和 session lock 在所有变更前完成 | route 在锁内重新读取 session，按持久化 `activePlugins` 同步 registry，并构造执行 identity | 无 | stale request 无法跨会话 incarnation 提交 | `actions.ts` |
| setup 调度 | 只运行显式 `stage: setup` 且 `auto: true` 的 pending runtime | setup gate 同时检查 session phase 和 runtime state；DAG 只使用声明的 after/needs 边 | 无 | 不再把旧 `scheduled` 隐式视为 `auto` | `scheduling.ts`、各 setup `PLUGIN.md` |
| main 调度 | stage barrier 明确；同层稳定；cycle fail closed | pre-turn -> narrative -> post-turn；层内按名称稳定排序；cycle 被跳过而非猜测顺序 | 无 | 执行顺序可审计 | `scheduling.ts`、`dag-scheduler.ts` |
| event follower | 当前回合去重；background 延后到主事务后 | 事件 follower 按名称扇出；background 在锁外后续执行；同 turn 防重复 | 无 | 主提交不会被后台工作拖入同一事务 | `turn-event-chain.ts`、`actions.ts` |
| prompt | setup、主叙事和 manual 空消息都得到确定输入 | 变量包含 inputs/world/session/player/settings；空消息使用 execution cue；历史按 runtime 过滤 | 无 | 不需要伪造用户消息 | `prompt-internals.ts`、`prompt-assembler.ts`、`turn-agent-runtime.ts` |
| output | runtime 输出先规范化，再统一 finalize | output normalizer 生成 proposal；route 汇总主 runtime、嵌套 follower 和附加写 | 无 | store 写不散落在 agent loop 中 | `session-output-normalizer.ts`、`actions.ts` |
| commit | 所有业务写和 clock 必须原子提交，事件只能在提交后发布 | `DataStore.withTransaction` 必选；finalize 无非事务分支；失败 settle 为 failed | 无 | 避免 proposal 已写但 clock 未推进等半提交 | `finalize-execution.ts`、`session-clock.ts`、`store/types.ts` |
| SSE | 事件类型封闭，前端 reducer 显式处理或显式忽略 | `CovelEventType`/metadata 穷举；server serial write；Web 对 completion、suspension、plugin data、character 等收敛 | 无 | 类型新增会触发编译或穷举审查 | `protocol.ts`、`sse-handler.ts`、`event-reducers.ts` |

## 权威状态边界

### Session clock

`Session` 的三个必填字段是唯一业务真值：

- `phase`: `setup | playing`
- `completedPlayerTurns`: 已成功提交的、满足计数策略的逻辑玩家回合数
- `setupRuntimes`: 每个 setup runtime 的 pending/done/waived/failed 状态

runtime 直接加载这三个字段。mapper 和 snapshot decoder 严格要求当前 schema，不从 `turnCount`、`preGameCompleted` 或旧快照推导。

### Execution identity

持久化 origin 只有 `player`、`continuation`、`manual`、`background`、`recursive`、`resume`。是否推进玩家回合由 execution context 的 count policy 决定，而不是从 action 名称、消息是否为空或 runtime 数量反推。

### Plugin activation

session 持久化 `activePlugins`。每次 action 在锁内把 runtime registry 同步到该集合；请求不能通过 payload 临时激活额外插件。capability 选择 narrative engine，manifest 决定 stage/needs/inject/event 关系。

### Finalize transaction

一次执行内下列写入共享同一 store transaction：

- 所有 runtime proposal 的规范化提交；
- execution journal/status；
- suspension artifact；
- 玩家输入等 route 附加写；
- logical-turn ledger；
- `completedPlayerTurns`、`phase`、`setupRuntimes`；
- 需要随提交生成的 export/checkpoint 数据。

只有事务成功后才发出 commit 相关事件。transaction callback 抛错时，业务写回滚，execution settle 为 failed，clock 不推进。

## 被删除的并行责任

- Web 不再同时维护 `session-workspace` 与 `workspace-coordinator` 两套串行器。
- server 不再提供单独的 `turn-count` 或 `execution-suspensions` API 来绕过 finalize。
- store 不再维护旧 clock 字段或 snapshot upgrade 链。
- runtime 不再在多个层次自行补写 setup 完成和 turn count。
- action route 不再用一个 payload 的缺省字段猜测两种 retry 操作。

因此当前主干的复杂度主要来自真实业务维度（setup DAG、runtime fanout、两种叙事模式、SSE），不再来自同一状态的多套兼容表示。

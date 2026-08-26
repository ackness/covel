# 静态逐轮模拟

## 前提

模拟使用包含 `pregame`、`world-init/schema-gen` 和 `char-creator/player-init` 的新会话。三者 manifest 均声明 `stage: setup` 和 `auto: true`：

1. `pregame` 无前置 setup 依赖。
2. `world-init/schema-gen` 在 `pregame` 后运行。
3. `char-creator/player-init` 需要前两者；没有表单提交时生成创建角色所需 UI，提交后确定性地创建玩家。

setup runtime 不执行 narrative engine。最后一个 setup runtime 成功后，server 检测到 phase 已变为 `playing`，再追加一次 opening continuation。该 continuation 才运行 main stages，并按玩家计数策略推进 `completedPlayerTurns`。

## Turn 0：创建会话与首次 setup

| 维度 | 内容 |
| --- | --- |
| 期望 | 创建时写入 current clock；激活插件集合固定；`start_session` 运行当前可运行 setup，不运行 narrator；若需要用户输入则停在 setup。 |
| 实际 | create transaction 写入 session/world/blueprint，registry 按持久化插件激活；`start_session` 以空 player message 进入同一 action 主干；setup scheduler 只选择 pending + auto + 依赖已满足的 runtime。角色资料缺失时 player-init 产出 form/UI，phase 保持 `setup`。 |
| 差异 | 无。setup 可以分多次 action 完成，这是表单交互所需的显式暂停，不是隐藏重试。 |
| 影响 | `completedPlayerTurns` 仍为 0；不会提前产生开场叙事；客户端从 SSE/checkpoint 得到可恢复的表单状态。 |
| 证据 | `session.ts`、`actions.ts`、`scheduling.ts`、三个 setup manifest、`player-init/guard.js`。 |

状态演进：

```text
before: session absent
create: phase=setup, completedPlayerTurns=0, setupRuntimes=pending
start_session:
  pregame -> done
  schema-gen -> done
  player-init -> waits for form / remains pending
after: phase=setup, completedPlayerTurns=0
```

## Turn 0b：提交角色表单并触发 opening continuation

| 维度 | 内容 |
| --- | --- |
| 期望 | 表单提交必须绑定已提交的 interaction，幂等保存玩家输入；随后继续 setup。player-init 成功后，phase 原子切到 `playing`，且恰好追加一个 opening continuation。 |
| 实际 | Web 在 session FIFO 内调用 framework `submit-form`；server 在 session lock 内重新校验 session/incarnation；RPC 校验字段并查找已提交 interaction，在事务中保存 player input。Web 把填充后的 narrative 作为下一 action；player-init guard 读取 submission，确定性创建玩家。finalize 把 setup runtime 标为 done 并更新 phase。action route 仅在“本次从 setup 进入 playing、最后执行成功、不是 retry”时追加一次 continuation。 |
| 差异 | 无。表单 RPC 与继续执行是两个明确提交点；不会用未提交表单直接驱动 runtime。 |
| 影响 | setup 完成不会与 opening narration 混在同一 proposal transaction；失败可分别重试；opening continuation 只产生一个 `execution.completed`。 |
| 证据 | `session-store/actions.ts`、`api/sessions.ts`、`plugin-rpc.ts`、`submit-form.ts`、`player-init/guard.js`、`actions.ts`。 |

状态演进：

```text
submit-form transaction:
  interaction validated -> player_inputs persisted

setup continuation transaction:
  player-init -> done
  phase: setup -> playing
  completedPlayerTurns: 0

opening continuation transaction:
  pre-turn -> narrative -> post-turn -> event followers
  logical player turn committed
  completedPlayerTurns: 0 -> 1
```

opening continuation 不接受请求 payload 直接指定；它是最后一个 setup commit 后的 server 内部控制流。`retry_runtime` 和 `retry_turn` 都不会意外生成第二个 opening continuation。

## Turn 1：第一个普通玩家回合

| 维度 | 内容 |
| --- | --- |
| 期望 | 玩家消息经过 session FIFO 和 closed action contract；所有 active main runtime 按 stage/DAG 执行；只在完整事务成功后把计数从 1 推到 2。 |
| 实际 | Web 的 `sendMessage` 在 workspace 中 prepare/stage；server 锁内验证 owner/status/incarnation，按持久化 activePlugins 同步 registry；pre-turn runtime 先执行，narrative capability 只选择一个引擎，post-turn 再执行，事件 follower 按触发链运行。所有 proposal、journal、suspension、附加写和 clock 一次提交。 |
| 差异 | 无。opening continuation 已是第一个计数回合，因此第一个普通玩家消息提交后计数为 2。 |
| 影响 | narrative 看到 Turn 0b 已提交的玩家、world、history 和 plugin data；任何 runtime/finalize 失败均不会部分推进 clock。 |
| 证据 | `workspace.ts`、`actions/request.ts`、`actions.ts`、`scheduling.ts`、`prompt-assembler.ts`、`finalize-execution.ts`、`session-clock.ts`。 |

## Turn 2：消费上一回合的派生状态

| 维度 | 内容 |
| --- | --- |
| 期望 | Turn 1 post-turn/event follower 的已提交状态能被 Turn 2 prompt 和 pre-turn runtime 读取；同一事件在同一 turn 不重复触发。 |
| 实际 | prompt assembler 从 store 加载已提交 history、world、player、plugin data 与 settings；runtime history 按 runtime 可见性过滤。event chain 使用 per-turn 去重并按名称稳定扇出；background follower 延迟到主事务完成后执行，并使用自己的 execution identity。 |
| 差异 | 无。background follower 与 Turn 2 主事务不是一个原子单元，这是显式设计边界。 |
| 影响 | 主回合延迟与后台派生解耦；后台失败不会撤销已成功的玩家回合，但有独立 journal/event 可观察。主回合成功后计数 2 -> 3。 |
| 证据 | `turn-agent-runtime.ts`、`prompt-internals.ts`、`turn-event-chain.ts`、`actions.ts`。 |

## Turn 3：稳定重复与恢复边界

| 维度 | 内容 |
| --- | --- |
| 期望 | 相同结构的下一回合不依赖旧字段或进程内临时计数；页面或 server 重启后仍从权威 checkpoint/session clock 继续。 |
| 实际 | runtime 每次直接加载 current session state；本地模式先恢复 pending commit，再用 authoritative checkpoint 重建 server mirror，并保留 checkpoint 中的 current clock；remote 模式直接从 store 读取。成功提交后计数 3 -> 4。 |
| 差异 | 无。旧浏览器 checkpoint 和旧数据库不兼容，按开发版策略直接拒绝而非升级。 |
| 影响 | 重启不会把回合数清零或重复 setup；错误的旧 schema 会尽早失败，避免静默污染。 |
| 证据 | `session-state.ts`、`local.ts`、`browser-workspace.ts`、`snapshot-mappers.ts`、`session-mappers.ts`。 |

## 传统叙事模式

传统模式激活 `narrator`，它提供 `narrative-engine` capability，并与 `chat-mode-narrator` 冲突。静态顺序为：

```text
pre-turn:
  npc-graph/rag-retriever
  scene-cast
narrative:
  narrator
post-turn:
  character-tracker
  codex
  guide
  npc-graph/extractor
event followers:
  manifest 声明的非 background / background follower
```

post-turn runtime 通过 `needs.capabilities: [narrative-engine]` 和 input injection 消费 narrative 产物。stage-less manual runtime（如 `character-presence`、`living-world-rules`）保持激活但不会因“已激活”被自动调度。

| 核对项 | 结论 |
| --- | --- |
| 唯一 narrative engine | plugin conflict + capability 保证，不依赖 if/else 猜测。 |
| 前后阶段 barrier | scheduler 明确实现，跨阶段不并行。 |
| 同层顺序 | DAG 层次后按 runtime name 稳定排序。 |
| cycle | fail closed 并跳过，不使用 priority fallback。 |
| commit | 所有同步 runtime 结果由同一 finalize transaction 提交。 |

## 对话模式

对话模式激活 `chat-mode-narrator`，它同样提供 `narrative-engine`，与传统 narrator 冲突，并要求对话插件集合。主干仍是同一个 action/scheduler/prompt/finalize/SSE；变化只在 manifest 数据：

```text
pre-turn -> chat-mode-narrator -> dialogue post-turn runtimes
                              -> stage-less event followers
                              -> background followers after main commit
```

`scene-prompts` 等 dialogue runtime 通过 capability 和 stage 声明进入 post-turn。对话事件 follower 通过 `CovelEventType` 目录进入事件链，而不是添加第二套 HTTP 或 commit 路径。

| 核对项 | 结论 |
| --- | --- |
| 模式切换 | 由插件 conflict/requires/capability 完成。 |
| action API | 与传统模式相同。 |
| session clock | 与传统模式相同。 |
| prompt 变量 | 共享 assembler；具体插件通过 inject/inputs 增补。 |
| SSE | 共享 `CovelEventType` 和 Web reducer。 |
| checkpoint | 共享 workspace prepare/commit 协议。 |

## 失败与重试模拟

- runtime 在 finalize 前失败：没有业务事务写入，clock 不推进。
- finalize callback 抛错：proposal、journal 附加写、suspension 和 clock 一起回滚，execution settle failed。
- checkpoint commit 下载失败：server 已提交结果不回滚；BrowserVault 保留 pending action id，下次操作前先恢复 commit。
- `retry_runtime`: 必须给出 `runtimeId`，只表达指定 runtime 的 manual retry。
- `retry_turn`: payload 必须为空，显式表达整回合重跑。
- setup retry/waive: 改变明确的 setup runtime 状态；不会通过旧 `preGameCompleted` 或 turn count 反推。
- resume: 使用 `resume` origin 和当前 suspension artifact；不走已删除的独立 suspension API。

上述路径的静态控制流均不需要 compatibility branch 才能完成。

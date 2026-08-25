# Findings 与死代码审计

## 分级标准

- P1：可能破坏数据原子性、跨会话隔离、回合计数或恢复正确性，阻止合并。
- P2：当前主流程存在语义歧义、重复路径或隐式兼容，阻止合并。
- P3：不影响当前正确性，但会增加维护成本或误导后续修改。

## 开放问题

没有开放的 P1/P2 问题。当前分支满足合并门禁。

## 审计中已修复

| 等级 | 原问题 | 风险 | 修复 | 复核证据 |
| --- | --- | --- | --- | --- |
| P1 | `DataStore.withTransaction` 可选，`finalizeExecution` 可降级为非事务写 | proposal、journal、suspension 与 clock 可能半提交 | 将 transaction 提升为 DataStore 必选能力；finalize 只允许一个 transaction；post-commit event 缓冲到成功后发布 | `packages/store/src/types.ts`、`packages/runtime/src/commit/finalize-execution.ts`；完整 test/build/lint 在修复后通过 |
| P2 | setup 把旧 `scheduled` 值折叠成当前 `auto` | 旧 manifest 可绕过新契约，实际调度与静态声明不一致 | 删除 folding，只接受显式 `auto` | `packages/runtime/src/turn-executor/scheduling.ts`、setup manifest；focused scheduling tests 通过 |
| P2 | `ProtocolEventType` 作为 `CovelEventType` 的兼容别名存在 | 新旧命名继续扩散，事件契约无法真正收敛 | 删除别名并更新生产引用、测试和文档 | `packages/shared/src/types/protocol.ts`；lint/test/build 通过 |
| P2 | 缺少 `runtimeId` 的 `retry_runtime` 被解释为整回合重试 | 同一 action 依靠可选字段承载两种命令，客户端错误可静默改变语义 | `retry_runtime` 要求 `runtimeId`；新增空 payload `retry_turn`；Web 两个入口分别调用 | `apps/server/src/routes/api/actions/request.ts`、`actions.ts`、Web action API/store；actions contract 19 tests passed |

## 已删除的兼容与重复路径

| 删除项 | 原责任 | 当前唯一责任归属 |
| --- | --- | --- |
| `apps/server/src/routes/api/turn-count.ts` | 单独读取/投影旧回合计数 | Session current clock + normal session/snapshot API |
| `apps/server/src/routes/api/execution-suspensions.ts` | 独立 suspension 路由 | runtime finalize transaction + resume route |
| `apps/web/src/services/session-workspace.ts` | 一套 workspace 协调 | `data-service/workspace.ts` 的 per-session FIFO |
| `apps/web/src/services/workspace-coordinator.ts` | 第二套顺序/提交协调 | 同上 |
| `apps/web/src/services/data-service/legacy-keys.ts` | 旧浏览器 key 兼容 | 当前 BrowserVault schema；旧缓存直接重建 |
| `apps/web/src/services/settings/legacy-cleanup.ts` | 启动期旧设置清理 | 当前设置 schema；开发期不做 lazy cleanup |
| store snapshot upgrade/旧 clock mapper | 旧 schema 回填 | Snapshot V3 与 current-only session mapper |

生产代码与当前文档扫描未发现 `turnCount`、`preGameCompleted`、旧 turn-count route 或旧 suspension route 的可达引用。唯一保留的字符串 `@covel/runtime/execution-suspensions` 位于 suspension artifact 的完整性 namespace 中；它不是 API、字段或兼容入口，修改它反而会改变当前 artifact 校验域，因此不属于死代码。

## 特别核对：看似重复但不是兼容层

### `KernelStore.withTransaction?`

transaction-bound store view 有意禁止嵌套开启 transaction，因此 kernel 内部窄接口仍用可选能力区分 root store 和 transaction view。对外 `DataStore.withTransaction` 已是必选。该差异表达当前事务边界，不是旧实现 fallback。

### `_jobs` durable ledger 与 `job-status` SSE

两者角色不同：前者是可恢复的持久化执行账本，后者是实时进度通知。Web 明确忽略不改变状态的进度事件，最终以 committed state / execution completion 收敛。当前不能在不改变可观察性的情况下直接删除任一方。

### `input.inject`

多个当前插件 manifest 使用 injection 把 narrative 或 session 数据接入 runtime。它是活跃的插件作者接口，不是仅为旧 manifest 保留的 shim。若未来要删除，必须先完成所有插件 manifest 的独立迁移，不能在逐轮主链清理中静默移除。

## P3 与后续候选

以下不阻止本次合并，且没有在代码冻结的静态审计阶段扩大修改范围：

1. 少量插件 manifest 的说明文字仍提到历史上的 priority fallback，而当前 scheduler 已只使用 stage/DAG。可在纯文档提交中统一措辞，不影响执行。
2. `apps/web/src/services/api/model-settings.ts` 仍包含旧 preset/secret 数据迁移。这是用户设置数据策略，不属于 session turn flow；开发版若允许重置设置，可独立删除并补充迁移边界测试。
3. `packages/shared/src/types/ui.ts` 和 server UI spec schema 仍表达旧 UI instruction/spec 输入。这是 UI 协议迁移项目，需先盘点所有插件 UI 生产者，再一次性删除。
4. subscription event 的旧 numeric cursor reset 属于订阅协议边界，可在确认没有外部消费者后独立收敛。

这些候选不参与当前回合调度、prompt、事务、时钟或 checkpoint 的正确性判定。把它们拆出是为了避免一次架构重构同时重置互不相关的数据协议。

## 代码量与复杂度结论

最终生产与测试整体 diff 为约 294 个文件、3707 行新增、4568 行删除，净减少约 861 行。新增主要来自明确契约、恢复测试和审计文档；删除主要来自兼容字段、旧升级路径、重复 coordinator、独立路由和可选依赖分支。

本轮精简的核心收益不是单纯减少行数，而是减少状态表示数量和提交入口数量：

- clock：多套派生/回填 -> 一套必填 current state；
- workspace：多 coordinator -> 每 session 一个 FIFO；
- commit：runtime 分散写 -> 一个必选 transaction；
- retry：可选字段重载 -> 两个闭合 action；
- protocol：旧别名 + 当前名 -> 一个事件类型目录。

剩余体量主要对应插件业务、两种叙事模式、持久化后端和恢复测试，暂未发现可在不损害明确业务能力的前提下继续大块删除的重复主链。

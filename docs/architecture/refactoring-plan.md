# Current-only 架构收敛计划

> 状态：已完成。代码重构、动态验证与 current-only 静态逐轮审计均已通过；本计划随重构提交合并到 `v0.0.27-dev`。

## 目标与边界

目标是把会话执行收敛到一套可直接读取的 current-only 契约：`phase`、`completedPlayerTurns`、`setupRuntimes` 是必填业务真值；持久化执行来源只使用 `player`、`continuation`、`manual`、`background`、`recursive`、`resume`。前端在每个 session 上只通过一个 `SessionWorkspace` 串行化 hydrate、行动和 checkpoint；挂起执行作为 runtime 产物，在 finalize transaction 中落库；审批和 memory 通过显式依赖注入构造。

非目标：不迁移既有数据库或快照，不保留旧 API/存储字段，不兼容旧浏览器缓存，不改变 setup retry/waive、logical-turn ledger、opening continuation 或后台 event follower 的业务语义。该分支仍处于开发期，破坏性删除优先于兼容分支。

## 现状问题

- 会话时钟曾同时维护旧字段与当前字段，导致 API、store、snapshot、UI 各自存在派生、回填和 fallback。
- Web 曾有多条工作区协调路径，hydrate、同步、提交的顺序责任分散。
- suspension 在执行期直接写 store，事务可见性与事件发射难以统一；memory/approval 有隐藏或冗余依赖。
- 复用的 Vitest 配置和 Turbo 输入声明重复，测试缓存边界不透明。

## 七个阶段

### 1. Web workspace 收敛

- **文件边界**：`apps/web/src/services/data-service/**`、session store 的 hydrate/action/checkpoint 调用点及其测试。
- **执行**：以 `SessionWorkspace` 作为每个 session 的唯一 FIFO，顺序执行远端同步、行动和提交；待下载的 actionId 先持久化到 `BrowserVault`，失败后必须恢复 commit 才能再次上传；remote 模式保持无状态实现。
- **风险与回滚**：错误地跨 session 串行会降低吞吐，错误的异常处理会漏掉 checkpoint；回滚为恢复先前 coordinator，仅在未合并前通过反向提交完成。
- **验收**：本地模式同 session 并发 action 的顺序、失败 commit 的跨 reload 恢复、服务器重启不重置既有时钟、hydrate 后读到权威状态；Web 单测与 lint 通过。

### 2. current-only contract 与 store

- **文件边界**：`packages/shared/src/{types,scheduling}/**`、`packages/store/src/**`、相关 contract tests。
- **执行**：删除 `turnCount`、`preGameCompleted`、旧 origin 标签、旧 schema/snapshot upgrade 与 lazy backfill；Session、SnapshotPayload、BrowserCheckpoint v2、store mapper/DDL 只表达并校验 current-only 字段。
- **风险与回滚**：已有数据库、快照和浏览器缓存将不可读取；开发版用重新创建数据和 clean profile 解决。回滚为切回重构前分支，不在代码中恢复双写。
- **验收**：类型层要求时钟三字段；Memory/SQLite/PG contract tests 无旧列或旧 origin；snapshot 仅接受当前 schema。

### 3. Runtime 与 server 收敛

- **文件边界**：`packages/runtime/src/**`、`apps/server/src/routes/api/**`、对应测试。
- **执行**：调度和计数直接读取 current clock；actions、plugin-rpc、resume 和 snapshot route 只传规范 origin；删除旧回合计数、状态快照路由及 response projection。
- **风险与回滚**：setup 完成与 opening continuation 的两事务语义、logical-turn 幂等计数可能被破坏。回滚只允许撤回本阶段提交；不得重新引入旧字段。
- **验收**：setup retry/waive、opening continuation、后台 follower、recursive/resume 的 focused tests；`completedPlayerTurns` 只在 player logical turn 成功提交后推进。

### 4. Suspension、DI 与 approval

- **文件边界**：`packages/runtime/src/{suspension-artifact,agent-loop,function-runtime,commit,resume}/**`、`apps/server/src/routes/api/**`、`packages/approval/**`。
- **执行**：runtime 附加非持久 suspension artifact，finalizer 在 transaction 内保存，commit 后再发 `turn.suspended`；memorySystem 从 Hono context 注入；审批管道只保留规则决策，不保存 session allow。
- **风险与回滚**：rollback 后的幽灵 suspension/event、resume 丢失 execution identity。回滚必须以整阶段提交为单位，不能部分恢复旧直写。
- **验收**：suspend/rollback/resume、approval deny、memory 注入的 focused tests；检查不存在 transaction 前的 suspension 写入或事件。

### 5. 工程配置收敛

- **文件边界**：根 `vitest.base.ts`、各 package `vitest.config.ts`、`turbo.json`。
- **执行**：共享 Vitest 基础配置，Turbo 为真正读取的根输入显式声明依赖，移除重复配置。
- **风险与回滚**：缓存未失效或 package 解析改变；回滚为恢复独立配置文件。
- **验收**：Turbo dry-run 显示正确 inputs，至少 shared/runtime/server/web 测试可从新配置运行。

### 6. 文档与契约同步

- **文件边界**：`CLAUDE.md`、`docs/architecture/**`、`docs/reference/**`、`docs/guide/**`、受影响插件 `PLUGIN.md`。
- **执行**：把 API 示例、session/snapshot 字段、UI 回合显示、自动快照节奏、SSE 描述和 e2e 断言全部写成 current-only；保留 background follower 作为事件调度角色，但不再把它写成 persisted origin。
- **风险与回滚**：文档先于代码完成时会误导读者；以最终 `rg` 和代码审查为准，不修改历史 CHANGELOG。
- **验收**：文档不把旧时钟、V1/V2 snapshot、旧状态快照 API 或 `origin: follower` 描述为现行契约。

### 7. 验证、静态审计与合并

- **文件边界**：不新增产品代码；使用仓库既有测试、lint 与 `.claude/skills/covel-static-turn-audit/`。
- **执行**：先运行分层 package tests，再运行 workspace lint/test；完成后按 skill 的完整流程做静态审计，修复所有 blocker 后复跑；审计无问题才把 worktree 分支合并到 `v0.0.27-dev`。
- **风险与回滚**：全量验证可能暴露并行阶段的接口缺口；先修复并回归最小相关测试，再运行全套。合并前保留 worktree 分支作为可回退点。
- **验收**：`git diff --check`、全量 lint/test、静态审计均通过；合并提交只包含本计划范围内变更，目标分支为 `v0.0.27-dev`。

## 交付判据

完成不等于代码删减完成：必须确认没有 current-path 回填或 dual-write，没有旧 session/snapshot API 文档，所有 setup 状态读取 `setupRuntimes`，所有 UI 回合与 snapshot cadence 使用 `completedPlayerTurns`，且静态审计后再合并。

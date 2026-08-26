# Current-only 架构重构静态审计

## 结论

本次审计覆盖新建会话、插件激活、setup、表单提交、opening continuation、前三个普通玩家回合、传统叙事模式、对话模式、prompt 组装、事务提交、SSE 收敛和死代码扫描。

审计结论：**通过**。

- 没有开放的 P1/P2 正确性问题。
- 会话业务时钟只有 `phase`、`completedPlayerTurns`、`setupRuntimes` 一套真值。
- 同一 session 的浏览器工作区操作只有一个 FIFO；本地 checkpoint 的 prepare/commit 可跨重启恢复。
- 一次执行的 proposal、journal、suspension、玩家输入附加写和 session clock 在同一个必选事务中提交。
- setup 与普通主循环具有显式边界；setup 完成后的 opening continuation 恰好运行一次。
- 传统模式和对话模式依赖同一调度、prompt、commit、SSE 主干，只由 capability、manifest 和事件 follower 改变具体 runtime 集合。
- 旧回合字段、旧快照升级、旧回合计数路由、旧 suspension 路由和旧 Web coordinator 已从生产路径移除。

## 审计对象

- 分支：`codex/architecture-simplification-v2`
- 基线：`v0.0.27-dev` 上的 `1e2d9eab`
- 工作树：`/Users/wuyong/.codex/worktrees/architecture-simplification-v2/covel`
- 审计方式：依据 `.claude/skills/covel-static-turn-audit/SKILL.md`，只做静态代码、manifest、类型、测试契约和文档证据核对。
- 审计期间限制：未启动应用、未运行测试或构建、未调用模型；审计文档只通过补丁写入。

## 起始动作与会话形态

起始动作统一定义为新会话创建后，前端通过 `start_session` 进入执行主干。若存在未完成 setup runtime，该动作只运行 setup；当最后一个 setup runtime 提交完成后，server 自动追加一次 opening continuation。没有 setup runtime 的会话直接处于 `playing`，首次 `start_session` 就是玩家计数回合。

本地模式额外经过 `SessionWorkspace` 的 prepare/stage/mutate/commit 协议；remote 模式使用相同 action 和 server 执行协议，但 workspace commit 是无状态实现。两种模式从 server action route 起共享完全相同的调度和事务语义。

## 审计过程中发现并修复的问题

审计不是只记录现状。本轮曾离开静态阶段，修复并重新完成动态验证，然后从头重新进入静态审计：

1. `DataStore.withTransaction` 曾为可选，finalize 存在非事务降级路径。现已改为必选事务能力，finalize 不再允许降级。
2. setup manifest 曾把 `scheduled` 兼容折叠为 `auto`，事件类型曾保留旧别名。两者已删除，当前契约只接受显式 `auto` 和 `CovelEventType`。
3. `retry_runtime` 曾同时表达单 runtime 重试与整回合重试。现拆分为需要 `runtimeId` 的 `retry_runtime` 和空 payload 的 `retry_turn`。

详细等级、影响和证据见 [03-findings-and-dead-code.md](./03-findings-and-dead-code.md)。

## 动态验证基线

以下命令均在最后一次兼容性清理完成后、进入本次静态阶段之前实际运行并成功：

- `mise exec -- pnpm lint`：20/20 task 成功。
- `mise exec -- pnpm test`：45/45 task 成功；store 套件 803 passed、1 skipped。
- `mise exec -- pnpm build`：4/4 task 成功；desktop staged server smoke 在有、无 `llm.toml` 两种环境均通过。
- `mise exec -- pnpm check:i18n`：Web、插件、handler、world、README 扫描全部通过。
- actions contract focused test：19 tests passed。
- runtime normalize/scheduling focused tests：23 passed、11 todo。
- `pnpm deps:check`：退出码 0；只报告既有配置提示。
- `git diff --check`：通过。

## 文档索引

- [01-static-flow-map.md](./01-static-flow-map.md)：从 UI 到 store 的静态控制流和数据流。
- [02-turn-simulation.md](./02-turn-simulation.md)：Turn 0、Turn 0b、Turn 1/2/3、传统与对话模式模拟。
- [03-findings-and-dead-code.md](./03-findings-and-dead-code.md)：问题分级、已修复项、死代码和后续候选。
- [04-evidence-index.md](./04-evidence-index.md)：文件、符号和行区间证据索引。

## 适用边界

本项目仍处于开发期，本次结论明确不承诺读取旧数据库、旧快照、旧浏览器缓存或旧 action payload。旧数据应重建，不在 runtime 中保留迁移和 fallback。模型设置迁移、旧 UI 指令协议等不属于“会话逐轮执行”主链，已作为独立后续清理候选记录，避免把另一项数据重置工程隐含并入本次提交。

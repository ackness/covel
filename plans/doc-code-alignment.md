# 文档与代码对齐计划

日期：2026-04-02
分支：claude/dreamy-einstein

## 目标

修复架构文档（`docs/system-architecture-v0/`）与实际代码实现之间的不一致。
原则：代码已实现的 → 更新文档；文档承诺但未实现的 → 补全代码。

---

## A. 文档需要更新（代码正确，文档过时）

### A1. runtime-kernel-spec.md 仍使用 phase 描述调度

代码已完全采用 priority 调度（0-1000），但文档多处仍描述 phase 系统：
- §3.1 "按 phase、priority 和 budget 调度" → 应为 "按 priority 和 budget 调度"
- §4 "首轮默认 gameplay profile" 仍引用 phase → 应改为 priority 描述
- §5.2 排序规则第一条是 phase → 应改为 priority-first
- §5.2 "首轮 phase: pre_story/story/post_story/background" → 删除
- §5.4 "首轮支持: story/plugin/background" → 改为 kind 描述
- §8 RuntimeContextView.runtime 包含 `phase: string` → 应为 `priority: number`
- §10.6 "同一阶段先按依赖拓扑分层" → "同一优先级先按依赖拓扑分层"

### A2. Model Slot 系统在规格文档中缺失

代码中 `@covel/ai-provider` 已实现完整的 slot 系统（heavy/fast/balance/image），
但 runtime-kernel-spec.md 和 public-plugin-api-spec.md 完全未提及。
需在两份文档中新增 Model Slot 章节。

### A3. 依赖拓扑分组文档缺失

`runtime-scheduler.ts` 在同一 priority 组内使用 Kahn 算法按插件依赖做拓扑分层。
这个能力在 CLAUDE.md 和 framework-architecture.md 中未说明（runtime-kernel-spec §10.6 提及但用的是 phase 术语）。

### A4. Background 阈值机制未在规格文档中说明

代码使用 `backgroundThreshold`（默认 800）将高 priority 的 runtime 分流为异步后台任务。
runtime-kernel-spec.md 未描述此机制。

### A5. Session-scoped plugin activation 未在规格文档中说明

代码已实现 `SessionPluginScope`、`ScopedRuntimeRegistry` 等，CLAUDE.md 已更新，
但 runtime-kernel-spec.md 和 public-plugin-api-spec.md 未涵盖。

---

## B. 代码需要实现（文档承诺但未实现）

### B1. Hook 生命周期：缺少 TurnStart/TurnStop/PreStateCommit/PostStateCommit

类型已声明 6 个 HookEvent，代码仅在 tool-executor.ts 中触发 PreToolUse/PostToolUse。
需在 kernel.ts 的 executeTurn 中补全其余 4 个 hook 触发点。

### B2. Runtime 去重：同一 runtime 每轮只执行一次

runtime-kernel-spec §10.1 要求去重，代码中 trigger-router 和 scheduler 无此逻辑。
需在 routeTrigger 或 buildExecutionPlan 中添加去重。

### B3. Locale 4 层回退

文档要求：KernelInput.locale → run.defaultLocale → world.defaultLocale → zh-CN
代码仅有：input.locale ?? "zh-CN"
需在 kernel.ts executeTurn 中实现完整回退链。

### B4. Proposal 冲突检测增强 — scope 隔离

runtime-kernel-spec §10.1 要求 scope 隔离优先 + 拓扑层优先级。
代码仅检测同 key 冲突。需增强 proposal-validator.ts。

---

## C. 插件 manifest 清理

### C1. 移除所有 plugin.json 中的 `phase` 字段

所有核心插件仍声明 `"phase": "..."` 字段。既然 priority 已完全取代 phase，
且 `phase` 在 PublicRuntimeSpec 中已标记 @deprecated，应从所有 manifest 中移除。

---

## 执行顺序

1. **Phase 1（并行）**: A1 + C1 — 文档更新 + manifest 清理
2. **Phase 2（并行）**: A2 + A3 + A4 + A5 — 文档补全
3. **Phase 3（并行）**: B1 + B2 + B3 + B4 — 代码实现
4. **Phase 4**: 验证 — 运行测试确保无破坏性变更

# core-quest

维护会话中的任务日志：从共享的 WorldIR 抽取中登记明确出现的任务，推进目标勾选与完成 / 失败状态，不调用模型；右栏可见、变更有消息提示。

## 运行时结构

- `PLUGIN.md`：插件级元信息，本身不是可执行 runtime。
- `runtimes/vocabulary/`：pre-turn function runtime，把进行中的任务名与未完成目标原文作为 `world-ir.vocabulary@1` 发布给事实抽取，让它用同一名称报告进展。
- `runtimes/log/`：post-turn function runtime，读取本轮 WorldIR 的 `quest_change` 事件并登记 / 推进任务。
- `lib/world-ir.js`：把任务事件映射为任务更新，并把事件里的任务名对齐到已有任务。
- `lib/upsert-quests.js`：按名合并的批量任务登记 / 推进逻辑。
- `schemas/quests.schema.json`：`quests` namespace 的世界包导入 schema。
- `ui/quest-log-panel.json`：右侧任务面板（按状态分组，目标以 ✓/☐ 勾选 chip 展示）。
- `ui/quest-changes-block.json`：聊天区本回合任务变更块。

## 数据与行为

- 读取本轮 WorldIR；抽取失败的回合不运行。只有 `accepted` 事件能新建任务；`progressed` / `completed` / `failed` 必须对上已有任务（规范化后同名，或唯一的包含关系匹配），对不上就忽略，避免改写过的任务名生成重复任务。新目标取自 `objectives`，本轮完成的目标取自 `completedObjectives`。事件的固定字段由 `world-ir` 约定并校验。
- 任务写入 `plugin_data[core-quest][quests]`，按 `name` 去重合并：已有任务只推进（目标按稳定 `id`、规范化文本、保守语义兜底依次匹配；命中后保留原文并更新勾选），不存在则创建。
- 世界包可经 `worldData` 向 `quests` namespace 预置主线 / 支线任务，按同名合并推进；它们也会出现在 vocabulary 里。
- 本回合变更摘要（新任务 / 推进 / 完成 / 失败）写入 `message` namespace，驱动消息块。
- 没有任务信号的回合跳过写入。

## 开发

修改 WorldIR 映射、合并规则或 UI spec 后，运行本包测试。

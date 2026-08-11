# core-quest

维护会话中的任务日志：从叙事中登记明确出现的任务，推进目标勾选与完成 / 失败状态，右栏可见、变更有消息提示。

## 运行时结构

- `PLUGIN.md`：叙事后执行的 agent runtime。
- `tools/upsert-quests.js`：按名合并的批量任务登记 / 推进工具。
- `schemas/quests.schema.json`：`quests` namespace 的世界包导入 schema。
- `ui/quest-log-panel.json`：右侧任务面板（按状态分组，目标以 ✓/☐ 勾选 chip 展示）。
- `ui/quest-changes-block.json`：聊天区本回合任务变更块。

## 数据与行为

- 读取最新叙事和已有任务摘要（`input.inject`），叙事引擎失败的回合不运行。
- 任务写入 `plugin_data[core-quest][quests]`，按 `name` 去重合并：已有任务只推进（目标按稳定 `id`、规范化文本、保守语义兜底依次匹配；命中后保留原文并更新勾选），不存在则创建。
- 世界包可经 `worldData` 向 `quests` namespace 预置主线 / 支线任务，工具按同名合并推进。
- 本回合变更摘要（新任务 / 推进 / 完成 / 失败）写入 `message` namespace，驱动消息块。
- 没有任务信号的回合跳过写入。

## 开发

修改判定规则、工具 schema 或 UI spec 后，运行本包测试。

# affinity

维护玩家与 NPC 之间的数值好感度：每回合从叙事中读出明确互动的增量，右栏展示分数进度条与档位，变更在聊天区以消息卡提示。

## 分工边界

本插件**只管玩家↔NPC 的数值好感**（分数、档位、变更历史）：

- NPC 与 NPC 之间的结构化关系（节点、边、阵营）归关系图谱（npc-graph）。
- 散文式的人物羁绊与情感描述归记忆系统的 `character_relationships` 记忆块。

三者互补不重复。

## 运行时结构

- `PLUGIN.md`：叙事后执行的 agent runtime（`stage: post-turn`，按 `narrative-engine` capability 门控）。
- `tier-metadata.js`：分数范围、六档 tier 与展示元数据的唯一来源。
- `tools/update-affinity.js`：按名字去重的批量好感变更工具。
- `server/index.js`：entry 模块，注册本地工具。
- `schemas/affinity.schema.json`：worldData 导入形状。
- `ui/affinity-panel.json`：右侧好感面板。
- `ui/affinity-toast.json`：聊天区变更消息卡。

## 数据与行为

- 好感记录写入 `plugin_data[affinity][affinity]`，key 为稳定短 ID（`shortIdBatch` 生成，或世界预置的 `id`），按 NPC 名字大小写不敏感去重。
- `score` 累计并 clamp 在 [-100, 100]；档位阈值：≤ -60 敌视 / -59..-20 冷淡 / -19..19 中立 / 20..59 友好 / 60..84 亲密 / ≥ 85 挚爱。`tier` / `tierLabel` / `tierColor` / `scoreBar`（进度条用的 [0,200] 位移值，中点为中立）每次写入时由工具重新派生。
- `history` 追加 `{turn, delta, reason}`，只保留最近 10 条。
- 本回合变更同时写入 `message` namespace（`__turnId` + `changes`），供聊天区消息卡渲染。
- 没有明确互动的回合不调用工具、不产生任何写入。

## 世界预置

世界包可通过 `worldData` 向 `affinity` namespace 预置关键 NPC 的初始好感，形状为 `{ id, name, score, notes? }`（见 `schemas/affinity.schema.json`）。预置记录没有 history / tier 等派生字段——工具在首次变更时容错并补齐；面板在首次变更前只显示名字与原始分数。

## 开发

修改计分规则、工具 schema 或 UI spec 后，运行本包测试。

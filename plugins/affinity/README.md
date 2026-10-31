# affinity

维护玩家与 NPC 之间的数值好感度：每回合从叙事中读出明确互动的增量，右栏展示分数进度条与档位，变更在聊天区以消息卡提示。

## 分工边界

本插件**只管玩家↔NPC 的数值好感**（分数、档位、变更历史）：

- NPC 与 NPC 之间的结构化关系（节点、边、阵营）归关系图谱（npc-graph）。
- 散文式的人物羁绊、互动与承诺归记忆系统；记忆不维护另一份当前分数或路线阶段。

三者互补不重复。

## 运行时结构

- `PLUGIN.md`：叙事后执行的 agent runtime（`stage: post-turn`，通过必需的 `world-ir-provider@1` 输入读取本轮事实）。
- `tier-metadata.js`：分数范围、六档 tier 与展示元数据的唯一来源。
- `tools/update-affinity.js`：按名字去重的批量好感变更工具。
- `server/index.js`：entry 模块，注册本地工具与 `prompt.segment@1/current-affinity`。
- `server/current-affinity.js`：只读当前分数投影，供所有 story runtime 使用。
- `schemas/affinity.schema.json`：`affinity` 数据集与 worldData 导入共用的 schema。
- `ui/affinity-panel.json`：右侧好感面板。
- `ui/affinity-toast.json`：聊天区变更消息卡。

## 数据与行为

- 好感记录写入 `affinity` 数据集（`plugin_data[affinity][affinity]`），新记录用 `set`，提交时按 schema 校验最终记录；key 为稳定短 ID（`shortIdBatch` 生成，或世界预置的 `id`），按 NPC 名字大小写不敏感去重。
- 已有记录的 `score` 以 `inc` 累计并 clamp 在 [-100, 100]，派生展示字段以 `merge` 写入；档位阈值：≤ -60 敌视 / -59..-20 冷淡 / -19..19 中立 / 20..59 友好 / 60..84 亲密 / ≥ 85 挚爱。`tier` / `tierLabel` / `tierColor` / `scoreBar`（进度条用的 [0,200] 位移值，中点为中立）每次写入时由工具重新派生。
- `history` 追加 `{turn, delta, reason}`，只保留最近 10 条，以 `merge` 整数组写入。并发提交时分数增量会累加，展示字段和历史仍取工具读取时算出的预测值，可能暂时落后于最终分数。
- 名字先按会话角色的名字和别名解析（`resolveCharacter`）：模型用别名称呼某个角色时，变更记在该角色名下的同一条记录上，不会多出一条。不在世界模型里的名字按原样匹配。
- 本回合变更同时写入 `message` namespace（`__turnId` + `changes`），供聊天区消息卡渲染。
- 没有明确互动的回合不调用工具、不产生任何写入。

## 叙事读取

`prompt.segment@1/current-affinity` 从提供者自己的 `ctx.pluginData.list("affinity")` 读取已提交状态，按规范姓名输出 `{canonicalName, score}`，设定 `audience: story`、`volatility: turn`。预置记录没有 tier 也可读取；不输出 ID、时间戳、notes、history 或可能落后于分数的派生档位。JSON 经过 `modelFacingJson` 与标签转义；说明明确标注数据不是指令、不是恋爱阶段，也不会自动推进路线。分数行最多占 8000 字符，整条省略并注明数量；未列出不等于 0。

投影不调用模型、不提出写入，也不复制到角色字段。关闭插件就没有该投影。实际分数变化仍由原有 post-turn agent 判断并提交；下一次执行读取新值。

## 世界预置

世界包可通过 `worldData` 向 `affinity` namespace 预置关键 NPC 的初始好感，形状为 `{ id, name, score, notes? }`（见 `schemas/affinity.schema.json`）。预置记录没有 history / tier 等派生字段——工具在首次变更时容错并补齐；面板在首次变更前只显示名字与原始分数。

遥风学园的八名主要角色都在此持有唯一好感分数。五人的恋爱阶段、信任与压力由「心之路线」持有；三名支持角色的非恋爱关系、信任与压力留在角色资料。好感档位不会把支持角色变成恋爱路线。

世界预置和同步替换按数据集的 `set` 校验；权威来源移除预置记录时允许 `delete`。同步仍受 schema 与大小限制，`force` 不绕过这些规则。

## 开发

修改计分规则、工具 schema 或 UI spec 后，运行本包测试。

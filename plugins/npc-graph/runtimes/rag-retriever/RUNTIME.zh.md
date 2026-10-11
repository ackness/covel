---
---

NPC 关系图检索器（function runtime）。

每个游戏回合开始前自动运行：

1. 读取本会话的 NPC 节点与边（`plugin_data[nodes/edges]`），由边在内存里建邻接表
2. 优先在 `playerMessage` 中匹配节点名字（含别名）；没有命中时，用本回合 `scene-cast@1`（场景舞台的在场角色）的可选 `currentCast` 输入按完整姓名或别名唯一匹配人物。图节点 ID 与角色 ID 不作等同假设；未安装场景插件时仍按玩家输入检索。
3. 对命中节点做 2-hop BFS，仅沿当前有效的最新关系遍历，过期关系不扩展召回范围。
4. 只保留有效区间仍开放的边（`invalidAt === undefined`）；被新版本取代的旧边留在库里溯源，但不注入 prompt
5. 按最近度（`validAt` 降序）和强度绝对值排序，截取 top-20
6. 输出 `npcContext` 字段（markdown 列表），由 `narrator` 通过 input.inject 消费

当图为空或无命中时，输出 `npcContext: ""` 且 `narrator` 的 prompt 会自然跳过对应段落。

本 runtime 不调用 LLM 或嵌入服务。当前演员仅提供检索候选，不声称完成代词消歧。输入绑定负责本回合执行顺序与数据传递，无需读取另一插件的未提交存储。

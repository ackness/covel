---
name: npc-graph/rag-retriever
description:
  zh: 当你提到某个人时，帮助故事想起相关人物和关系。
  en: When you mention someone, helps the story remember related people and relationships.
pluginType: plugin
# Narrator-prep layer — the `pre-turn` stage runs before the `narrative` stage,
# so narrator's inject of `npcContext` is populated by the time it runs.
stage: pre-turn
capabilities: [npc-graph, graph-rag]
inputs:
  currentCast:
    from:
      capability: scene-cast
      cardinality: one
    select: /speakers
    required: false
    accepts: ./schemas/current-cast.json
tags:
  - role:retrieval
  - data:relationship-graph
  - cost:function
outputKind: plugin
runtimeType: function
handler: ./handler.js
trigger:
  type: scheduled
  interval: 1
---

NPC 关系图检索器（function runtime）。

每个游戏回合开始前自动运行：

1. 读取本会话的 NPC 节点、边与邻接索引（`plugin_data[nodes/edges/index]`）
2. 优先在 `playerMessage` 中匹配节点名字（含别名）；没有命中时，用本轮 `scene-cast` 的可选 `currentCast` 输入按完整姓名或别名唯一匹配人物。图节点 ID 与角色 ID 不作等同假设；未安装场景插件时仍按玩家输入检索。
3. 对命中节点做 2-hop BFS，合并 `by-source` 与 `by-target` 索引，仅沿当前有效的最新关系遍历，过期关系不扩展召回范围。
4. 只保留有效区间仍开放的边（`invalidAt === undefined`）；被新版本取代的旧边留在库里溯源，但不注入 prompt
5. 按最近度（`validAt` 降序）和强度绝对值排序，截取 top-20
6. 输出 `npcContext` 字段（markdown 列表），由 `narrator` 通过 input.inject 消费

当图为空或无命中时，输出 `npcContext: ""` 且 `narrator` 的 prompt 会自然跳过对应段落。

本 runtime 不调用 LLM 或嵌入服务。当前演员仅提供检索候选，不声称完成代词消歧。输入绑定负责本轮执行顺序与数据传递，无需读取另一插件的未提交存储。

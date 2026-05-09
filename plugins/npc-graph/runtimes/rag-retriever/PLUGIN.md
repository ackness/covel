---
name: npc-graph/rag-retriever
description:
  zh: 当你提到某个人时，帮助故事想起相关人物和关系。
  en: When you mention someone, helps the story remember related people and relationships.
pluginType: plugin
# Narrator-prep layer — runs before narrator (500) so narrator's inject
# of `npcContext` is populated. Leaves 100–499 free for future prep
# runtimes (embeddings, lore retrieval, etc.) that could share this layer.
priority: 400
capabilities: [npc-graph, graph-rag]
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
relations: {}
---

NPC 关系图检索器（function runtime）。

每个游戏回合开始前自动运行：

1. 读取本会话的 NPC 节点、边与邻接索引（`plugin_data[nodes/edges/index]`）
2. 在 `playerMessage` 与最近几条 narrator 消息中字符串匹配节点名字（含别名）
3. 对命中节点做 2-hop BFS，合并 `by-source` 与 `by-target` 索引
4. 过滤掉 `invalidAt` 已到期的边
5. 按最近度（`validAt` 降序）和强度绝对值排序，截取 top-20
6. 输出 `npcContext` 字段（markdown 列表），由 `narrator` 通过 input.inject 消费

当图为空或无命中时，输出 `npcContext: ""` 且 `narrator` 的 prompt 会自然跳过对应段落。

本 runtime 不进行向量嵌入或语义检索 —— Phase 3.5 将在 framework 层暴露 gateway 访问后升级为混合检索。

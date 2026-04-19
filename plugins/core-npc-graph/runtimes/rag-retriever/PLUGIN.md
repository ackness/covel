---
name: core-npc-graph/rag-retriever
description:
  zh: NPC 关系图检索器 — 在每个叙事回合开始前，从玩家当前输入中提取被提及的人物，并沿关系图 2-hop 扩展，把相关事实注入 narrator 上下文。无 LLM 调用。
  en: NPC graph retriever — before each narrative turn, extracts mentioned characters from the player's input, expands along the graph up to 2 hops, and injects relevant facts into the narrator context. No LLM calls.
pluginType: plugin
priority: 490
capabilities: [npc-graph, graph-rag]
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
2. 在 `playerMessage` 与最近几条 narrator 消息中字符串匹配节点名字（含别名）
3. 对命中节点做 2-hop BFS，合并 `by-source` 与 `by-target` 索引
4. 过滤掉 `invalidAt` 已到期的边
5. 按最近度（`validAt` 降序）和强度绝对值排序，截取 top-20
6. 输出 `npcContext` 字段（markdown 列表），由 `core-narrator` 通过 input.inject 消费

当图为空或无命中时，输出 `npcContext: ""` 且 `core-narrator` 的 prompt 会自然跳过对应段落。

本 runtime 不进行向量嵌入或语义检索 —— Phase 3.5 将在 framework 层暴露 gateway 访问后升级为混合检索。

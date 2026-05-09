---
name: npc-graph/rag-retriever
description:
  zh: 当你提到某个人时，帮助故事想起相关人物和关系。
  en: When you mention someone, helps the story remember related people and relationships.
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

NPC graph retriever (function runtime).

Runs automatically before every narrative turn:

1. Reads this session's NPC nodes, edges, and adjacency indices (`plugin_data[nodes/edges/index]`)
2. String-matches node names (including aliases) against `playerMessage` and the most recent narrator messages
3. Performs a 2-hop BFS from the hit nodes, merging the `by-source` and `by-target` indices
4. Filters out edges whose `invalidAt` has already expired
5. Sorts by recency (`validAt` descending) and absolute strength, taking the top 20
6. Emits `npcContext` (a markdown list) for `narrator` to consume via `input.inject`

When the graph is empty or no node was hit, the output is `npcContext: ""` and the `narrator` prompt naturally skips the corresponding section.

This runtime does NOT perform vector embedding or semantic retrieval — Phase 3.5 will upgrade it to hybrid retrieval once the framework exposes gateway access.

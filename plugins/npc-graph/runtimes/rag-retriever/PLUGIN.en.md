---
name: npc-graph/rag-retriever
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

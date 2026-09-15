---
name: npc-graph
displayName:
  zh: 关系图谱
  en: Relationship Graph
description:
  zh: 记录人物之间的关系，让故事提到相关人物时更连贯。
  en: Tracks relationships between characters so the story stays consistent when people are mentioned again.
pluginType: plugin
entry: ./server/index.js
relations:
  requires:
    - world-ir
---

# Relationship Tracker

`upsert-npc-graph` reads its own buffered node, edge and adjacency writes from earlier
calls in the same execution. Multiple calls commit together at the execution
boundary; shared-node adjacency and relationship version history are preserved.

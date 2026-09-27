---
id: npc-graph
kind: plugin
displayName:
  zh: 关系图谱
  en: Relationship Graph
description:
  zh: 记录人物之间的关系，让故事提到相关人物时更连贯。
  en: >-
    Tracks relationships between characters so the story stays consistent when
    people are mentioned again.
tags:
  - "data:relationship-graph"
  - "cost:llm"
  - "ui:right-panel"
  - "cost:function"
provides:
  - npc-graph@1
  - graph-rag@1
requires:
  - world-ir-provider@1
optional:
  - scene-cast@1
entry: ./server/index.js
contributes:
  ui:
    right:
      - ./runtimes/extractor/ui/npc-graph-panel.json
  tools:
    - upsert-npc-graph
    - list-npc-graph
---

# Relationship Tracker

`upsert-npc-graph` reads its own buffered node, edge and adjacency writes from earlier
calls in the same execution. Multiple calls commit together at the execution
boundary; shared-node adjacency and relationship version history are preserved.

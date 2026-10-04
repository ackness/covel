---
id: npc-graph
kind: plugin
version: 0.0.35
displayName: Relationship Graph
description: >-
  Tracks relationships between characters so the story stays consistent when
  people are mentioned again.
tags:
  - "data:relationship-graph"
  - "cost:llm"
  - "ui:right-panel"
  - "cost:function"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
provides:
  - npc-graph@1
  - graph-rag@1
requires:
  - world-ir-provider@1
optional:
  - scene-cast@1
contracts:
  graph-rag@1:
    schema: ./schemas/graph-rag.schema.json
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

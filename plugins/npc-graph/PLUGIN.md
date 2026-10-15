---
version: 0.0.38
displayName: Relationship Graph
description: >-
  Tracks relationships between characters so the story stays consistent when
  people are mentioned again.
tags:
  - "data:relationship-graph"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
requires:
  - world-ir-provider@1
contracts:
  graph-rag@1:
    schema: ./schemas/graph-rag.schema.json
contributes:
  ui:
    right:
      - ./runtimes/extractor/ui/npc-graph-panel.json
  tools:
    - upsert-npc-graph
---

# Relationship Tracker

`upsert-npc-graph` reads its own buffered node and edge writes from earlier
calls in the same execution. Multiple calls commit together at the execution
boundary; relationship version history is preserved.

---
version: 0.0.42
displayName: Relationships
description: >-
  Keeps track of who is connected to whom, so the story remembers the people
  you have met and how they relate.
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

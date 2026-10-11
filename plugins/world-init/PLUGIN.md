---
id: world-init
kind: core
version: 0.0.38
displayName: World Dimensions
description: Initializes character attributes and authored dimensions,
  maintaining evolving state.
tags:
  - "data:world-data"
  - "data:characters"
  - "cost:llm"
  - "ui:right-panel"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
provides:
  - world-data-provider@1
  - world.dimensions@1
optional:
  - narrative-engine@1
  - world-ir-provider@1
  - world-time-evolution@1
contracts:
  world.dimensions@1:
    schema: ./schemas/dimension-snapshot.schema.json
entry: ./server/index.js
contributes:
  extensions:
    - point: session.world-context@1
      id: world-context
    - point: prompt.segment@1
      id: dimensions
    - point: prompt.segment@1
      id: dimension-rules
  ui:
    right:
      - ./runtimes/schema-gen/ui/world-overview.json
      - ./runtimes/schema-gen/ui/world-schema.json
  tools:
    - set-world-schema
    - set-world-dimensions
    - initialize-world
    - dimension-rule-get
    - update-dimensions
  hooks:
    - event: PreLLMCall
      enforce: normal
---

# World Setup

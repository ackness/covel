---
kind: core
version: 0.0.49
displayName: World State
description: Keeps track of the world's numbers and states, such as factions,
  weather and reputation, and updates them as the story goes on.
tags:
  - "data:world-data"
  - "data:characters"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contracts:
  world-data-provider@1:
    schema: ./runtimes/schema-gen/output.schema.json
  world.dimensions@1:
    schema: ./schemas/dimension-snapshot.schema.json
contributes:
  extensions:
    - session.world-context@1/world-context
    - prompt.segment@1/dimensions
    - prompt.segment@1/dimension-rules
  ui:
    right:
      - ./runtimes/schema-gen/ui/world-overview.json
      - ./runtimes/schema-gen/ui/world-schema.json
  tools:
    - dimension-rule-get
    - initialize-world
    - update-dimensions
  hooks:
    - PreLLMCall
---

# World Setup

---
kind: core
version: 0.0.42
displayName: World Dimensions
description: Initializes character attributes and authored dimensions,
  maintaining evolving state.
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
    - initialize-world
    - dimension-rule-get
    - update-dimensions
  hooks:
    - PreLLMCall
---

# World Setup

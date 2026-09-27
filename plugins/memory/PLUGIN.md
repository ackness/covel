---
id: memory
kind: core
displayName:
  zh: 故事记忆
  en: Story Memory
description:
  zh: 展示故事记住的重点，包括剧情、场景、人物关系和主角状态。
  en: >-
    Shows what the story remembers, including plot, scene, relationships, and
    hero status.
tags:
  - "cost:llm"
  - "ui:right-panel"
entry: ./server/index.js
contributes:
  extensions:
    - point: prompt.segment@1
      id: memory
  ui:
    right:
      - ./ui/memory-panel.json
  services:
    - memory.block-definitions@1
  data:
    definitions:
      version: 1
      accepts:
        - memory.blocks@1
      schema: ./schemas/block-definitions.schema.json
    blocks:
      version: 1
      schema: ./schemas/blocks.schema.json
contracts:
  memory.blocks@1:
    schema: ./schemas/block-definitions.schema.json
---

Memory extraction runs as a detached post-turn function with a before-next-execution barrier. Blocks live in this plugin's `blocks` namespace and enter prompts through `prompt.segment@1` after the cache boundary. Additional active plugins can contribute `memory.block-definitions@1` services; world packages can provide definitions in this plugin's `definitions/world` record.

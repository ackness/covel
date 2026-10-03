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
      description: World-defined memory blocks that replace the default set.
      authoring:
        title:
          zh: 题材记忆块
          en: Memory blocks
        hint: >-
          Write one object with `id: world` and a `blocks` list. Each block has
          a `label` (a snake_case key), a `displayName` and an
          `extractionHint` that says what to remember; `icon` and `maxChars`
          are optional. Choose blocks that fit the genre. Do not make a block
          for data that a dimension or another plugin already tracks.
        example: ./examples/blocks.json
        source:
          kind: json
          path: data/memory-blocks.json
          key: id
    blocks:
      version: 1
      schema: ./schemas/blocks.schema.json
contracts:
  memory.blocks@1:
    schema: ./schemas/block-definitions.schema.json
---

Memory extraction runs as a detached post-turn function with a before-next-execution barrier. Blocks live in this plugin's `blocks` namespace and enter prompts through `prompt.segment@1` after the cache boundary. Additional active plugins can contribute `memory.block-definitions@1` services; world packages can provide definitions in this plugin's `definitions/world` record.

## Quality Characteristics

**Extraction Reliability**: Memory extraction is **not guaranteed to be lossless**. The LLM may:

- Miss important facts mentioned briefly in narrative
- Misinterpret ambiguous phrasing
- Prioritize recent events over older but significant details
- Produce inconsistent extractions across similar contexts

**Configuration Sensitivity**: The current default timeout (30s) and retry settings have **not been empirically validated** across diverse model speeds, narrative complexity, or session lengths. Deployments may need to tune these values based on:

- Model choice (faster models like DeepSeek vs slower models like GPT-4)
- Average turn length and narrative density
- Acceptable latency budget for post-turn processing

**Recall Accuracy**: Retrieved blocks reflect the quality of extraction. If a fact was not extracted or was extracted incorrectly, recall will not surface it. Consider combining with:

- Explicit player note-taking mechanisms
- Full-text search over raw narrative history for critical fact verification
- Periodic manual review of extracted blocks

**Best Practices**:

- Monitor extraction failures and timeout rates in production
- Validate memory accuracy during long sessions (>50 turns)
- Use structured character/world updates for critical game state that must persist reliably

---
kind: core
version: 0.0.44
displayName: Story Memory
description: >-
  Shows what the story remembers: the plot so far, the current scene, your
  relationships and your character's status. Updates after every turn.
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contributes:
  extensions:
    - prompt.segment@1/memory
  ui:
    right:
      - ./ui/memory-panel.json
  services:
    - memory.block-definitions@1
  data:
    definitions:
      accepts:
        - memory.blocks@1
      schema: ./schemas/block-definitions.schema.json
      description: Extra story memory topics supplied by the world, alongside the default blocks.
      authoring:
        title: Story memory topics
        summary: Lets the story remember things that fit the genre, such as clues, promises and countdowns.
        hint: >-
          Write one object with `id: world` and a `blocks` list. Each block has
          a `label` (a snake_case key), a `displayName` and an `extractionHint`
          that says what to remember; `icon` and `maxChars` are optional. Choose
          blocks that fit the genre. Do not make a block for data that a
          dimension or another plugin already tracks.
        example: ./examples/blocks.json
        generate: default
        source:
          path: data/memory-blocks.json
          localeArrayKeys: [label]
    blocks:
      schema: ./schemas/blocks.schema.json
    facts:
      schema: ./schemas/facts.schema.json
      search:
        text: text
---

Memory extraction runs as a detached post-turn function that settles before the next execution: the next player action waits for it. Blocks live in this plugin's `blocks` namespace and enter prompts through `prompt.segment@1` after the cache boundary.

The same extraction adds up to three facts of the turn to the `facts` namespace. A block is rewritten every turn and holds the present state; facts are only added and keep what happened. The namespace is declared searchable, so the kernel's `memory-search` reads it, and the prompt segment brings back the facts that the player's message is about. Both use the kernel's lexical ranking and need no embedding model. Additional active plugins can contribute `memory.block-definitions@1` services; world packages can provide definitions in this plugin's `definitions/world` record.

## Behavior and Boundaries

- **Best-effort narrative extraction**: The extractor summarizes what happened into topic blocks and appends up to three factual records per turn. Brief or ambiguous details in prose may be skipped rather than inferred.
- **Role of structured state**: Because memory extraction is a bounded narrative summary, authoritative numbers, inventory items, quests, clocks, and world dimensions belong in dedicated datasets or dimension schemas rather than narrative memory blocks.
- **Custom world topics**: Any world pack can contribute additional genre-specific blocks through `data/memory-blocks.json` (`memory.blocks@1`), using `extractionHint` to mark what narrative details belong there without duplicating structured state already owned by dimensions or other plugins.

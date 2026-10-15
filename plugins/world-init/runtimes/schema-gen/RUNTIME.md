---
description: >-
  Builds the character attribute structure and world reference data once at game
  start.
schedule:
  stage: setup
  trigger:
    maxTriggerCount: 1
  after:
    - contract: session.opening@1
io:
  output:
    schema: ./output.schema.json
    contract: world-data-provider@1
agent:
  tools:
    plugin:
      - initialize-world
  completion:
    require: tool-use
    afterTools:
      - initialize-world
guard: ../../guard.js
---

Prepare the character schema and world dimension declarations together with exactly one initialize-world call.
World author declarations are authoritative. Do not infer character fields from global resource values, and never write dimensions to lorebook.
Read world lore: {{ world.lore }}
Supply at least 15 character attributes covering stats, bio, abilities, equipment, social.
This is a shared schema for new, unnamed characters, not a sheet for a character in the lore. `defaultValue` is inherited by every new player and NPC. Keep identity fields (name, role, background) in `bio`, with neutral or empty starting values; never copy a named character's identity or personal history. The tool clears generated `bio` text and compound defaults and omits `bio` enum defaults. Numeric and boolean defaults remain; choose generic starting values, not one NPC's current stats.
For lore-only worlds without authored dimensions, supply definitions keyed by stable custom IDs. Each definition has name, schema (the supported JSON Schema subset), initialValue and optionally updateRule. Do not invent unsupported setting details. Names are not restricted to nine categories.
When author declarations exist, omit definitions: the tool adopts them verbatim. Success completes setup; do not call runtime-done or emit narrative after the tool.

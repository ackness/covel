---
type: agent
description: >-
  Builds the character attribute structure and world reference data once at game
  start.
schedule:
  stage: setup
  trigger:
    type: auto
    maxTriggerCount: 1
  after:
    - contract: session.opening@1
io:
  output:
    schema: ./output.schema.json
    contract: world-data-provider@1
  visibility: system
agent:
  model: plugin
  tools:
    plugin:
      - initialize-world
  loop:
    timeoutMs: 120000
    callTimeoutMs: 60000
    maxRetries: 0
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
For lore-only worlds without authored dimensions, supply definitions keyed by stable custom IDs. Each definition has name, schema (the supported JSON Schema subset), initialValue and optionally updateRule. Do not invent unsupported setting details. Names are not restricted to nine categories.
When author declarations exist, omit definitions: the tool adopts them verbatim. Success completes setup; do not call runtime-done or emit narrative after the tool.

---
name: tabletop-rules/creation
description: { zh: 开局配点, en: Opening point allocation }
pluginType: plugin
runtimeType: function
handler: ./handler.js
stage: setup
outputKind: system
trigger: { type: auto }
# Weak ordering only: run after the character-creation provider (char-creator's
# player-init or any replacement) and the world-data provider, but never gate
# on them — allocation layers on top of the created character instead of
# replacing the opening form.
after:
  - capability: world-data-provider
  - capability: character-creation
inputs:
  schema:
    from: { capability: world-data-provider, cardinality: one }
    select: /worldSchema
    required: false
  # Same-turn player id from the character-creation provider. Its guard
  # buffers the player as a proposal (invisible to list-characters until the
  # turn commits), so the id travels through the runtime output instead.
  playerId:
    from: { capability: character-creation, cardinality: one }
    select: /playerId
    required: false
tools:
  builtin:
    [get-character-schema, list-characters, update-character, create-form]
dataSchemas:
  rules:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/rules.schema.json
---

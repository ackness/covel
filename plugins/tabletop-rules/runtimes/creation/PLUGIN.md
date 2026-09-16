---
name: tabletop-rules/creation
description: { zh: 配点创角, en: Point-buy character creation }
pluginType: plugin
runtimeType: function
handler: ./handler.js
stage: setup
outputKind: system
capabilities: [character-creation]
trigger: { type: auto }
after:
  - capability: world-data-provider
inputs:
  schema:
    from: { capability: world-data-provider, cardinality: one }
    select: /worldSchema
    required: false
tools:
  builtin:
    [get-character-schema, list-characters, create-character, create-form]
dataSchemas:
  rules:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/rules.schema.json
---

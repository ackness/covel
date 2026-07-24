---
name: character-blueprint
displayName:
  zh: 角色蓝图
  en: Character Blueprints
description:
  zh: 保存预设人物资料，方便在故事中快速加入重要角色。
  en: Saves preset character profiles so important people can be added to the story quickly.
pluginType: plugin
runtimeType: function
resultFormat: envelope-v1
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - character-blueprint
tags:
  - role:character
  - data:world-data
  - data:characters
  - cost:function
  - ui:right-panel
  - ui:manual-action
dataSchemas:
  blueprints:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/blueprints.schema.json
    description: Importable world character blueprints.
  characters:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/characters.schema.json
    description: Imported character mirror records created from blueprints.
ui:
  right:
    - ./ui/blueprints-panel.json
---

# Character Blueprint

Manual function runtime for importing a character source record into the session.

## Manual payload

```json
{
  "blueprintJson": "{\"schemaVersion\":1,\"id\":\"mentor-lin\",\"name\":\"Lin Yue\"}",
  "blueprint": {
    "schemaVersion": 1,
    "id": "mentor-lin",
    "name": "Lin Yue",
    "role": "npc",
    "description": "A cautious sword mentor.",
    "attributes": { "realm": "Foundation" },
    "persona": {
      "summary": "Precise, patient, and suspicious of shortcuts.",
      "traits": ["disciplined", "observant"]
    },
    "dialogueExamples": [
      {
        "user": "I can win quickly.",
        "character": "Quickly is where errors hide."
      }
    ],
    "scenarioDefaults": {
      "opening": "Lin Yue waits in the rain-slick practice yard."
    },
    "rules": [
      {
        "text": "Keep sword advice concrete and grounded in the current scene."
      }
    ]
  },
  "instantiate": true
}
```

## Behavior

1. Stores the source blueprint under `plugin_data[character-blueprint][blueprints][blueprint.id]`
2. Emits `character.upsert` when `instantiate: true` or `blueprint.instantiate` is present
3. Uses `mirrorPluginId: "character-blueprint"` by default so compact character snapshots are visible in `plugin_data[characters]`
4. Keeps persona, dialogue examples, scenario defaults, rules, and media refs in the blueprint record for downstream runtimes

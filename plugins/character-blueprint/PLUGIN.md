---
name: character-blueprint
description:
  zh: 角色蓝图导入器。把可导入的玩法/人设源数据保存为 plugin_data，并可通过 character.upsert 实例化为 Covel Character。
  en: Character Blueprint importer. Stores importable playstyle/persona source data as plugin_data and can instantiate it as Covel Character state through character.upsert.
pluginType: plugin
priority: 95
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - character-blueprint
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
      { "user": "I can win quickly.", "character": "Quickly is where errors hide." }
    ],
    "scenarioDefaults": {
      "opening": "Lin Yue waits in the rain-slick practice yard."
    },
    "rules": [
      { "text": "Keep sword advice concrete and grounded in the current scene." }
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

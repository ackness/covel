---
name: character-presence
description:
  zh: 保存角色头像、立绘和声音，让人物展示更有存在感。
  en: Saves character portraits, images, and voices so characters feel more present.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - character-presence
tags:
  - role:character
  - data:world-data
  - data:characters
  - data:media-assets
  - cost:function
  - ui:right-panel
  - ui:manual-action
dataSchemas:
  presence:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/presence.schema.json
    description: Importable character media presence records.
  assets:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/assets.schema.json
    description: Media asset index records imported from world packages.
ui:
  right:
    - ./ui/character-presence-panel.json
relations: {}
---

# Character Presence

Manual function runtime for saving a character's presence refs.

## Manual payload

```json
{
  "presence": {
    "schemaVersion": 1,
    "characterId": "mentor-lin",
    "avatar": {
      "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "mime": "image/png",
      "size": 1234
    },
    "sprite": {
      "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "mime": "image/png",
      "size": 5678
    },
    "voice": {
      "id": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "mime": "audio/wav",
      "size": 4321
    },
    "media": {
      "theme": {
        "id": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "mime": "audio/mpeg",
        "size": 9876
      }
    }
  }
}
```

`presenceJson` is also accepted for UI and RPC callers that pass raw JSON strings.

## Behavior

Stores the normalized presence record under:

`plugin_data[character-presence][presence][characterId]`

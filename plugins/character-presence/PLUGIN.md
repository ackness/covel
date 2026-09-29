---
id: character-presence
kind: plugin
displayName:
  zh: 角色形象
  en: Character Presence
description:
  zh: 保存角色头像、立绘和声音，让人物展示更有存在感。
  en: >-
    Saves character portraits, images, and voices so characters feel more
    present.
tags:
  - "data:world-data"
  - "data:characters"
  - "data:media-assets"
  - "cost:function"
  - "ui:right-panel"
  - "ui:manual-action"
provides:
  - character-presence@1
entry: ./server/index.js
contracts:
  character.portraits@1:
    schema: ./schemas/presence.schema.json
  character.portrait-assets@1:
    schema: ./schemas/assets.schema.json
contributes:
  extensions:
    - point: ui.slot@1
      id: visuals
      slot: character.visual@1
      order: 0
      watch:
        - presence
  data:
    presence:
      schema: ./schemas/presence.schema.json
      description: Importable character media presence records.
      version: 1
      accepts:
        - character.portraits@1
    assets:
      schema: ./schemas/assets.schema.json
      description: Media asset index records imported from world packages.
      version: 1
      accepts:
        - character.portrait-assets@1
  ui:
    right:
      - ./ui/character-presence-panel.json
runtime:
  type: function
  schedule:
    trigger:
      type: manual
  io:
    output:
      contract: character-presence@1
    visibility: system
  function:
    handler: ./handler.js
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
    "visuals": {
      "defaultVariant": "uniform-neutral",
      "variants": [
        {
          "id": "uniform-neutral",
          "outfit": "uniform",
          "expression": "neutral",
          "pose": "default",
          "sprite": {
            "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "mime": "image/png",
            "size": 5678
          },
          "stage": { "scale": 1, "offsetX": 0, "offsetY": 0 }
        }
      ]
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

`visuals` is optional and additive to schema v1. The stage resolves an exact
`variantId` first, then `outfit + expression + pose`, then progressively falls
back to the default pose, neutral expression, catalog default, first variant,
legacy `sprite`, and finally `avatar`. Each variant may carry stage framing
(`scale`, `offsetX`, `offsetY`) so differently cropped source art shares a
consistent on-screen baseline.

---
type: function
description: Saves a character's portrait, sprite, and voice.
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

Manual function runtime for saving a character's portrait, sprite, and voice refs.

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

`plugin_data[character-blueprint][presence][characterId]`

`visuals` is optional and additive to schema v1. The stage resolves an exact
`variantId` first, then `outfit + expression + pose`, then progressively falls
back to the default pose, neutral expression, catalog default, first variant,
legacy `sprite`, and finally `avatar`. Each variant may carry stage framing
(`scale`, `offsetX`, `offsetY`) so differently cropped source art shares a
consistent on-screen baseline.

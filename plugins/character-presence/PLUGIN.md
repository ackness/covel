---
name: character-presence
description:
  zh: 角色存在感插件。保存角色头像、立绘、语音与媒体引用，供会话右侧面板和后续运行时读取。
  en: Character presence plugin. Saves character avatar, sprite, voice, and media refs for sidebar display and downstream runtimes.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - character-presence
ui:
  right:
    - ./ui/character-presence-panel.json
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

---
name: player-identity
displayName:
  zh: 玩家身份
  en: Player Identity
description:
  zh: 让你在游玩中调整主角的口吻、目标和行事边界。
  en: Lets you adjust your hero's voice, goals, and boundaries during play.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - player-identity
  - persona-provider
tags:
  - role:character
  - data:characters
  - cost:function
relations: {}
---

# Player Identity

Manual function runtime for saving and activating a player identity profile.

## Manual payload

```json
{
  "profileJson": "{\"schemaVersion\":1,\"id\":\"wanderer\",\"name\":\"Wanderer\",\"description\":\"A cautious outsider.\"}",
  "activate": true,
  "bindToPlayer": true
}
```

## Behavior

1. Stores the profile under `plugin_data[player-identity][profiles][profile.id]`
2. Stores the active binding under `plugin_data[player-identity][session-binding][current]` when activated
3. Emits `character.upsert` for the session player when `bindToPlayer` is true
4. Preserves existing player character fields while adding identity references

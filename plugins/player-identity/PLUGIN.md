---
name: player-identity
description:
  zh: 玩家身份插件。把玩家 Persona 保存为会话身份档案，并可绑定到 Covel player Character 与 Prompt V2。
  en: Player identity plugin. Saves player persona profiles as session identity state and can bind them to the Covel player Character and Prompt V2.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - player-identity
ui:
  right:
    - ./ui/player-identity-panel.json
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

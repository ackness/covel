---
name: living-world-rules
description:
  zh: 生活世界规则插件。把 World Info 风格规则保存为 Covel lorebook，并交给 Prompt V2 分段注入。
  en: Living World Rules plugin. Saves World Info style rules as Covel lorebook entries for Prompt V2 segmented injection.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - living-world-rules
  - world-info
ui:
  right:
    - ./ui/living-world-rules-panel.json
---

# Living World Rules

Manual function runtime for saving a session world rule into the Covel lorebook.

## Manual payload

```json
{
  "ruleJson": "{\"schemaVersion\":1,\"id\":\"rain-market\",\"content\":\"雨市里没人会直接说出真实姓名。\",\"kind\":\"constant\",\"coordinate\":{\"position\":\"before_plugin\"}}"
}
```

## Behavior

1. Stores the normalized rule under `plugin_data[living-world-rules][rules][rule.id]`
2. Emits `lorebook.upsert` with a stable entry id
3. Uses `kind: "constant"` for always-on rules and `kind: "triggered"` for keyword rules
4. Routes prompt placement through `coordinate.position`: `before_plugin`, `after_plugin`, or `at_depth`

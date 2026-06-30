---
name: living-world-rules
displayName:
  zh: 世界规则
  en: World Rules
description:
  zh: 让你添加会长期生效的世界规则，比如禁忌、风俗和特殊设定。
  en: Lets you add lasting world rules, such as taboos, customs, and special setting details.
pluginType: plugin
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: manual
capabilities:
  - living-world-rules
  - world-info
tags:
  - role:world-rules
  - data:world-data
  - data:lorebook
  - cost:function
  - ui:right-panel
  - ui:manual-action
dataSchemas:
  rules:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/rules.schema.json
    description: Importable world info rules that can also project to lorebook.
ui:
  right:
    - ./ui/living-world-rules-panel.json
relations: {}
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

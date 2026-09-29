---
id: living-world-rules
kind: plugin
displayName:
  zh: 世界规则
  en: World Rules
description:
  zh: 让你添加会长期生效的世界规则，比如禁忌、风俗和特殊设定。
  en: >-
    Lets you add lasting world rules, such as taboos, customs, and special
    setting details.
tags:
  - "data:world-data"
  - "data:lorebook"
  - "cost:function"
  - "ui:right-panel"
  - "ui:manual-action"
provides:
  - living-world-rules@1
  - world-info@1
contracts:
  world.rules@1:
    schema: ./schemas/rules.schema.json
contributes:
  data:
    rules:
      schema: ./schemas/rules.schema.json
      description: Importable world info rules that can also project to lorebook.
      version: 1
      accepts:
        - world.rules@1
  worldProjections:
    rules-from-world-ir:
      from: "contract:world-ir@1"
      handler: ./server/project-world-ir.js
      outputs:
        rules:
          namespace: rules
          key: id
  ui:
    right:
      - ./ui/living-world-rules-panel.json
runtime:
  type: function
  schedule:
    trigger:
      type: manual
  io:
    output:
      contract: living-world-rules@1
    visibility: system
  function:
    handler: ./handler.js
---

# Living World Rules

Manual function runtime for saving a session world rule into the Covel lorebook.

WorldIR `type: rule` statements project to rule ids of the form
`world-ir-<sha256(statement.id)>`. The original id remains in
`sourceStatementId`, so Unicode and long WorldIR ids are importable while
projected rules satisfy the rule id constraint. The projection changes the
imported rule key for existing WorldIR content; recreate affected development
plugin data when adopting this contract.

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

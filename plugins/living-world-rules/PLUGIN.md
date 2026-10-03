---
id: living-world-rules
kind: plugin
displayName: World Rules
description: >-
  Shows the world's lasting rules, such as taboos, customs, and special setting
  details, and keeps the story following them.
tags:
  - "data:world-data"
  - "data:lorebook"
  - "cost:function"
  - "ui:right-panel"
  - "ui:manual-action"
provides:
  - living-world-rules@1
  - world-info@1
contributes:
  data:
    rules:
      schema: ./schemas/rules.schema.json
      description: Importable world info rules that can also project to lorebook.
      version: 1
      accepts:
        - world.rules@1
      authoring:
        title: World rules
        hint: >-
          Write one rule for each fact the narrative must never contradict. Each
          rule needs `schemaVersion: 1`, an `id` and `content`. `kind` is
          `constant`, `triggered` or `evolving`; `category` is `character`,
          `scene`, `relationship`, `world` or `style`. State the rule and its
          consequence in plain sentences. Do not restate values that a dimension
          already tracks.
        example: ./examples/rules.json
        source:
          kind: yaml
          path: data/rules/world-rules.yaml
          key: id
          lorebook: true
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

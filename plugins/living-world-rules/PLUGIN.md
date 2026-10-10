---
id: living-world-rules
kind: plugin
version: 0.0.35
displayName: World Rules
description: >-
  Shows the world's lasting rules, such as taboos, customs, and special setting
  details, and keeps the story following them.
tags:
  - "data:world-data"
  - "data:lorebook"
  - "cost:function"
  - "ui:right-panel"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
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
---

# Living World Rules

The lasting rules of a world. A world package imports them through its
`world.rules@1` data source (with `lorebook: true`, so each rule also becomes a
lorebook entry that the narrative reads), and the right panel shows them
read-only. The package has no runtime: rules are authored in the world
package, not edited during play.

WorldIR `type: rule` statements project to rule ids of the form
`world-ir-<sha256(statement.id)>`. The original id remains in
`sourceStatementId`, so Unicode and long WorldIR ids are importable while
projected rules satisfy the rule id constraint.

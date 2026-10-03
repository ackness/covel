---
id: tabletop-rules
kind: plugin
displayName:
  zh: 跑团规则
  en: Tabletop Rules
description:
  zh: 在角色创建后追加开局配点，以程序结算属性检定，并保留可复核的骰子记录。
  en: >-
    Layer opening point allocation onto character creation and resolve attribute
    checks with durable dice receipts.
provides:
  - tabletop-check@1
entry: ./server/index.js
contracts:
  tabletop-check@1:
    schema: ./schemas/tabletop-check.schema.json
  tabletop-rules.rules.initial@1:
    schema: ./schemas/rules.schema.json
contributes:
  ui:
    right:
      - ./runtimes/check/ui/check-panel.json
  data:
    rules:
      schema: ./schemas/rules.schema.json
      description: Point-buy rules for character creation.
      version: 1
      accepts:
        - tabletop-rules.rules.initial@1
      authoring:
        title:
          zh: 开局配点规则
          en: Character creation rules
        hint: >-
          Write one object with `id: creation`, a point `budget` and the
          `attributes` the player may raise. Each attribute `id` must be a
          bounded integer attribute with `category: abilities` in the world's
          `characterSchema`. `base` is the starting value and `max` the cap.
          `label` is a plain string; supply other languages as a locale variant
          of this file.
        example: ./examples/rules.json
        source:
          kind: json
          path: data/tabletop-rules.json
          key: id
  forms:
    - point-buy
---

Optional deterministic tabletop rules, using the public third-party plugin API.

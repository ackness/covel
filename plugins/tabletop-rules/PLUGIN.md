---
version: 0.0.38
displayName: Tabletop Rules
description: >-
  Layer opening point allocation onto character creation and resolve attribute
  checks with durable dice receipts.
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contracts:
  tabletop-check@1:
    schema: ./schemas/tabletop-check.schema.json
contributes:
  ui:
    right:
      - ./runtimes/check/ui/check-panel.json
  data:
    rules:
      schema: ./schemas/rules.schema.json
      description: Point-buy rules for character creation.
      accepts:
        - tabletop-rules.rules.initial@1
      authoring:
        title: Character creation rules
        hint: >-
          Write one object with `id: creation`, a point `budget` and the
          `attributes` the player may raise. Each attribute `id` must be a
          bounded integer attribute with `category: abilities` in the world's
          `characterSchema`. `base` is the starting value and `max` the cap.
          `label` is a plain string; supply other languages as a locale variant
          of this file.
        example: ./examples/rules.json
        source:
          path: data/tabletop-rules.json
        references:
          - path: attributes[].id
            to: character-attribute
            type: number
            within: [base, max]
  forms:
    - point-buy
---

Optional deterministic tabletop rules, using the public third-party plugin API.

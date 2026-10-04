---
id: tabletop-rules
kind: plugin
version: 0.0.35
displayName: Tabletop Rules
description: >-
  Layer opening point allocation onto character creation and resolve attribute
  checks with durable dice receipts.
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
provides:
  - tabletop-check@1
entry: ./server/index.js
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
      version: 1
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
          kind: json
          path: data/tabletop-rules.json
          key: id
  forms:
    - point-buy
---

Optional deterministic tabletop rules, using the public third-party plugin API.

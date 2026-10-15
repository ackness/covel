---
kind: core
version: 0.0.5
displayName: World Time
description: >-
  Tracks world-defined calendars, phases and time direction, settling each story
  turn's elapsed time.
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
requires:
  - narrative-engine@1
contracts:
  world-time-context@1:
    schema: ./schemas/world-time-context.schema.json
  world-time-evolution@1:
    schema: ./schemas/world-time-evolution.schema.json
contributes:
  data:
    definitions:
      schema: schemas/time-definition.schema.json
      description: How time is counted and how fast it passes in this world.
      accepts:
        - world.time-definition@1
      authoring:
        title: World time definition
        summary: Defines how this world counts time and how long actions take.
        hint: >-
          Write one object with `id: world` and a `definition`. `kind: phases`
          counts named phases in a cycle; `kind: calendar` uses months and days.
          `initial` sets where time starts. `evolution.prompt` tells the time
          tracker how much time each kind of action takes; state it in concrete
          steps.
        example: ./examples/time-definition.json
        generate: offer
        source:
          path: data/time.yaml
  commands:
    - name: time
      description: Show recorded world time without advancing the turn.
      action: time
  ui:
    right:
      - ./ui/clock-panel.json
      - ./ui/definition-panel.json
  tools:
    - advance-world-time
  actions:
    - time
  extensions:
    - point: ui.slot@1
      id: summary
      slot: session.summary@1
      order: 10
      watch:
        - clock
---

# World Time

World-owned definitions and transactional session clocks. See README.md.

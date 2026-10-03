---
id: world-time
kind: core
displayName: World Time
description: >-
  Tracks world-defined calendars, phases and time direction, settling each story
  turn's elapsed time.
provides:
  - world-time-evolution@1
  - world-time-context@1
requires:
  - narrative-engine@1
optional:
  - world-time-context@1
contracts:
  world-time-context@1:
    schema: ./schemas/world-time-context.schema.json
entry: ./server/index.js
contributes:
  data:
    definitions:
      version: 1
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
          kind: yaml
          path: data/time.yaml
          key: id
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
---

# World Time

World-owned definitions and transactional session clocks. See README.md.

---
id: world-time
kind: core
displayName:
  zh: 世界时间
  en: World Time
description:
  zh: 按世界定义维护日期、时段和时间流向，并根据本轮故事结算时间变化。
  en: >-
    Tracks world-defined calendars, phases and time direction, settling each
    story turn's elapsed time.
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
  world.time-definition@1:
    schema: schemas/time-definition.schema.json
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
        title:
          zh: 世界时间定义
          en: World time definition
        hint: >-
          Write one object with `id: world` and a `definition`. `kind: phases`
          counts named phases in a cycle; `kind: calendar` uses months and
          days. `initial` sets where time starts. `evolution.prompt` tells the
          time tracker how much time each kind of action takes; state it in
          concrete steps.
        example: ./examples/time-definition.json
        source:
          kind: yaml
          path: data/time.yaml
          key: id
  commands:
    - name: time
      description:
        zh: 查看当前已记录的世界时间，不推进回合。
        en: Show recorded world time without advancing the turn.
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

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
entry: ./server/index.js
contributes:
  commands:
    - name: time
      description:
        zh: 查看当前已记录的世界时间，不推进回合。
        en: Show recorded world time without advancing the turn.
      action: time
  ui:
    right:
      - ./ui/clock-panel.json
  tools:
    - advance-world-time
  actions:
    - time
---

# World Time

World-owned definitions and transactional session clocks. See README.md.

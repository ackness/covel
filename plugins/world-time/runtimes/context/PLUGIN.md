---
name: world-time/context
displayName: { zh: 当前世界时间, en: Current World Time }
description:
  zh: 向叙事提供当前时间及世界的时间规则。
  en: Provides the current time and the world's time rules to narration.
pluginType: core-plugin
runtimeType: function
handler: ./handler.js
stage: pre-turn
outputKind: system
capabilities: [world-time-context]
commands:
  - name: time
    description:
      zh: 查看当前已记录的世界时间，不推进回合。
      en: Show recorded world time without advancing the turn.
    action: time
trigger: { type: scheduled, interval: 1 }
ui:
  right:
    - ../../ui/clock-panel.json
---

Publishes authoritative time before narration. All initialization writes are transactional.

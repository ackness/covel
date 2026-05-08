---
name: scene-cast
description:
  zh: Chat Mode 场景演员选择器。每轮在叙事前准备活跃说话者和场景演员状态。
  en: Chat Mode scene cast selector. Prepares active speaker and cast state before narration.
pluginType: plugin
runtimeType: function
handler: ./handler.js
priority: 450
timeoutMs: 30000
outputKind: system
capabilities: [scene-cast]
tags:
  - mode:dialogue
  - role:scene-state
  - role:character
  - data:characters
  - cost:function
  - ui:right-panel
trigger:
  type: scheduled
  interval: 1
ui:
  right:
    - ./ui/scene-cast-panel.json
relations: {}
---

Scene Cast is a deterministic function runtime. It reads available character and message state, chooses the current active speakers, and publishes compact cast context for `chat-mode-narrator`.

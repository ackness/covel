---
name: scene-cast
description:
  zh: 记录当前场景里谁在场、谁正在说话。
  en: Tracks who is present in the scene and who is currently speaking.
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

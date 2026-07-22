---
name: scene-cast
displayName:
  zh: 当前场景
  en: Scene Cast
description:
  zh: 记录当前场景里谁在场、谁正在说话。
  en: Tracks who is present in the scene and who is currently speaking.
pluginType: plugin
runtimeType: function
resultFormat: envelope-v1
handler: ./handler.js
priority: 450
# Dual-declared (compat period): `stage` is the new authority; `priority`
# stays as `legacyOrder` until Step 6.
stage: pre-turn
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
  # Player-facing as "当前场景 / Scene" — a read-only "who's on stage now" view
  # (portrait + name + role). The internal selection signals / scores / ids are
  # NOT shown; they stay in plugin_data for the prompt + debug only.
  right:
    - ./ui/scene-cast-panel.json
userSettings:
  # Declared HERE, on the plugin that actually enforces cast size (handler.js
  # slices candidates by this value). userSettings are scoped to the declaring
  # plugin, so a knob declared on another plugin can never reach this handler.
  - key: activeSpeakerCount
    type: number
    default: 2
    min: 1
    max: 4
    step: 1
    label:
      zh: 活跃说话人数
      en: Active speakers
---

Scene Cast is a deterministic function runtime. It reads available character and message state, chooses the current active speakers, and publishes compact cast context for `chat-mode-narrator`.

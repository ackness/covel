---
id: scene-cast
kind: plugin
displayName:
  zh: 当前场景
  en: Scene Cast
description:
  zh: 记录当前场景里谁在场、谁正在说话。
  en: Tracks who is present in the scene and who is currently speaking.
tags:
  - "mode:dialogue"
  - "data:characters"
  - "cost:function"
  - "ui:right-panel"
provides:
  - scene-cast@1
contracts:
  scene-cast@1:
    schema: ./schemas/scene-cast.schema.json
entry: ./server/index.js
contributes:
  extensions:
    - point: ui.slot@1
      id: cast
      slot: stage.cast@1
      order: 0
      watch:
        - active-cast
  settings:
    - key: activeSpeakerCount
      type: number
      default: 2
      min: 1
      max: 4
      step: 1
      label:
        zh: 活跃说话人数
        en: Active speakers
  ui:
    right:
      - ./ui/scene-cast-panel.json
runtime:
  type: function
  schedule:
    stage: pre-turn
    trigger:
      type: scheduled
      interval: 1
  io:
    output:
      contract: scene-cast@1
    visibility: system
  function:
    handler: ./handler.js
---

Scene Cast is a deterministic function runtime. It reads available character and message state, chooses the current active speakers, and publishes compact cast context for `chat-mode-narrator`.

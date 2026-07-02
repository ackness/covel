---
name: scene-stage
displayName:
  zh: 场景舞台
  en: Scene Stage
description:
  zh: 跟踪叙事当前所在的场景与昼夜，为舞台背景提供数据。
  en: Tracks the current scene and time of day for the visual stage.
pluginType: plugin
runtimeType: function
handler: ./handler.js
priority: 460
outputKind: system
capabilities: [scene-stage]
tags:
  - mode:dialogue
  - role:scene-state
  - cost:function
  - ui:right-panel
trigger:
  type: event
  topic: scene.set
events:
  - topic: scene.set
    schema: ./schemas/scene-set.event.json
    description:
      zh: 叙事确立或切换场景、或昼夜变化时发射；location 用叙事中的地点名；无把握沿用上次值；新地点须附英文 visualHint。
      en: Emit when the narrative establishes/changes the scene or day-night shifts; use the in-narrative location name; keep previous values when unsure; add an English visualHint for brand-new places.
  - topic: scene-stage.generate.requested
    schema: ./schemas/generate-requested.event.json
    description:
      zh: 内部信令——场景未命中注册表且门控放行时，向增量生成 runtime 请求补图。
      en: Internal signal — requests background generation when a scene misses the registry and the auto-generate gate allows it.
    advertise: false
dataSchemas:
  scenes:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/scenes.schema.json
    description: Scene background registry imported from world packages.
userSettings:
  - key: autoGenerateScenes
    type: boolean
    default: true
    label:
      zh: 自动生成新场景背景
      en: Auto-generate new scene backgrounds
  - key: maxGeneratedScenes
    type: number
    default: 10
    min: 0
    max: 50
    step: 1
    label:
      zh: 每会话生成上限
      en: Per-session generation cap
ui:
  right:
    - ./ui/scene-stage-panel.json
relations: {}
---

Scene Stage is a deterministic function runtime triggered by `scene.set`. It resolves the current location and time of day against the world's scene registry (and scenes generated earlier this session), then publishes `stage/current` for the visual stage to consume. Scenes with no registry match are queued for background generation via `scene-stage/background-gen`, gated by `autoGenerateScenes` and `maxGeneratedScenes`.

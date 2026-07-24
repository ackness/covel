---
name: scene-stage/resolver
description:
  zh: 跟踪叙事当前所在的场景与昼夜，为舞台背景提供数据。
  en: Tracks the current scene and time of day for the visual stage.
pluginType: plugin
runtimeType: function
resultFormat: envelope-v1
handler: ./handler.js
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
      zh: "发射条件：第一回合开场确立场景时、场景/地点切换时、昼夜变化时——满足任一即须发射（每回合最多一次）。location 用叙事中的地点名；无把握沿用上次值；新地点须附英文 visualHint。"
      en: "Emission conditions (any one requires emitting, at most once per turn): the very first turn establishing the opening scene, a scene/location change, or a day-night shift. Use the in-narrative location name; keep previous values when unsure; add an English visualHint for brand-new places."
  - topic: scene-stage.generate.requested
    schema: ./schemas/generate-requested.event.json
    description:
      zh: 内部信令——场景未命中注册表且门控放行时，向增量生成 runtime 请求补图。
      en: Internal signal — requests background generation when a scene misses the registry and the auto-generate gate allows it.
    advertise: false
dataSchemas:
  assets:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/assets.schema.json
    description: Scene backdrop media index records imported from world packages.
  scenes:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/scenes.schema.json
    description: Scene background registry imported from world packages.
userSettings:
  - key: autoGenerateScenes
    type: toggle
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
---

Scene Stage's resolver is a deterministic function runtime triggered by `scene.set`. It resolves the current location and time of day against the world's scene registry (and scenes generated earlier this session), then publishes `stage/current` for the visual stage to consume. Scenes with no registry match are queued for background generation via `scene-stage/background-gen`, gated by `autoGenerateScenes` and `maxGeneratedScenes`.

Note: `events[].schema` and `dataSchemas.*.schema` paths resolve relative to the **plugin root** (`plugins/scene-stage/`), not this runtime's directory — see `apps/server/src/routes/api/bootstrap/event-directory.ts` and `apps/server/src/world-data/schema-registry.ts`. Only `handler` and `ui.*` paths resolve relative to this runtime's own directory.

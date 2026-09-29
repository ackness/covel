---
id: scene-stage
kind: plugin
displayName:
  zh: 场景舞台
  en: Scene Stage
description:
  zh: 跟踪叙事当前所在的场景与昼夜，为舞台背景提供数据。
  en: Tracks the current scene and time of day for the visual stage.
tags:
  - "mode:dialogue"
  - "cost:function"
  - "ui:right-panel"
provides:
  - stage-direction@1
  - scene-stage@1
entry: ./server/index.js
contracts:
  stage.scene-assets@1:
    schema: ./schemas/assets.schema.json
  stage.scenes@1:
    schema: ./schemas/scenes.schema.json
contributes:
  extensions:
    - point: ui.slot@1
      id: backdrop
      slot: stage.backdrop@1
      order: 0
      watch:
        - stage
        - scenes
      preview:
        - scene.set
    - point: ui.slot@1
      id: direction
      slot: stage.cast@1
      order: 10
      watch:
        - direction
      preview:
        - stage.direction
    - point: ui.slot@1
      id: dialogue
      slot: stage.dialogue@1
      order: 0
      watch:
        - dialogue
      preview:
        - stage.direction
  events:
    - topic: stage.direction
      schema: ./schemas/stage-direction.event.json
      description:
        zh: >-
          每轮正文前发射一次：cues 合并本轮全部登退场、站位、焦点、视觉变体变化；dialogue.paragraphSpeakers
          按正文空行分段顺序逐项填写准确角色 ID（来自 active-cast），旁白、混合对白或不确定时填
          null。不同说话人必须分段，正文段数和顺序必须与数组一致。无演员变化时 cues 可为空，但必须提供
          dialogue。actor.focus 只控制画面焦点，不决定对白署名。actor.leave 与 stage.clear 应指定离场
          transition。
        en: >-
          Emit once before each narrative. Merge all actor entry/exit, position,
          focus, and visual changes into cues. Supply dialogue.paragraphSpeakers
          with one exact character ID (from active-cast) per
          blank-line-separated narrative paragraph, in order; use null for
          narration, mixed speech, or unknown identities. Separate different
          speakers into paragraphs and keep the final paragraph count/order
          identical to the array. cues may be empty only when dialogue is
          provided. actor.focus controls the visual spotlight, not dialogue
          attribution. Specify an exit transition for actor.leave and
          stage.clear.
    - topic: scene.set
      schema: ./schemas/scene-set.event.json
      description:
        zh: >-
          发射条件：第一回合开场确立场景时、场景/地点切换时、昼夜变化时——满足任一即须发射（每回合最多一次）。location
          用叙事中的地点名；无把握沿用上次值；新地点须附英文 visualHint。
        en: >-
          Emission conditions (any one requires emitting, at most once per
          turn): the very first turn establishing the opening scene, a
          scene/location change, or a day-night shift. Use the in-narrative
          location name; keep previous values when unsure; add an English
          visualHint for brand-new places.
    - topic: scene-stage.generate.requested
      schema: ./schemas/generate-requested.event.json
      description:
        zh: 内部信令——场景未命中注册表且门控放行时，向增量生成 runtime 请求补图。
        en: >-
          Internal signal — requests background generation when a scene misses
          the registry and the auto-generate gate allows it.
      advertise: false
  settings:
    - key: modelPresetId
      type: slot
      default: image
      label:
        zh: 场景背景图像用途
        en: Scene background image slot
      description:
        zh: 选择用于自动生成场景背景的图像模型用途，对应 llm.toml 中的 [covel.<用途名>]。
        en: Selects the image model slot used for generated scene backgrounds, configured under [covel.<slot>] in llm.toml.
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
  data:
    assets:
      schema: ./schemas/assets.schema.json
      description: Scene backdrop media index records imported from world packages.
      version: 1
      accepts:
        - stage.scene-assets@1
    scenes:
      schema: ./schemas/scenes.schema.json
      description: Scene background registry imported from world packages.
      version: 1
      accepts:
        - stage.scenes@1
  ui:
    right:
      - ./runtimes/resolver/ui/scene-stage-panel.json
---

Scene Stage tracks the current scene/location and time of day for the visual stage, resolving `scene.set` events into `stage/current` and queuing background generation for unmatched locations. It also applies structured `stage.direction` cues for actor presence, focus, position, and visual variants. This root `PLUGIN.md` is metadata only — executable runtimes live under `runtimes/`.

---
id: scene-stage
kind: plugin
displayName:
  zh: 场景舞台
  en: Scene Stage
description:
  zh: 跟踪当前场景、昼夜和在场角色，为舞台背景与立绘提供数据。
  en: >-
    Tracks the current scene, time of day, and who is on stage for the visual
    stage.
tags:
  - "mode:dialogue"
  - "data:characters"
  - "cost:function"
  - "ui:right-panel"
provides:
  - stage-direction@1
  - scene-stage@1
  - scene-cast@1
entry: ./server/index.js
contracts:
  scene-cast@1:
    schema: ./schemas/scene-cast.schema.json
  stage.scene-assets@1:
    schema: ./schemas/assets.schema.json
  stage.scenes@1:
    schema: ./schemas/scenes.schema.json
contributes:
  extensions:
    - point: ui.slot@1
      id: cast
      slot: stage.cast@1
      order: 0
      watch:
        - active-cast
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
          用叙事中的地点名；无把握沿用上次值。
        en: >-
          Emission conditions (any one requires emitting, at most once per
          turn): the very first turn establishing the opening scene, a
          scene/location change, or a day-night shift. Use the in-narrative
          location name; keep previous values when unsure.
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
      - ./runtimes/cast/ui/scene-cast-panel.json
---

Scene Stage tracks the current scene/location and time of day for the visual stage, resolving `scene.set` events into `stage/current` against the world's scene registry; an unmatched location has no backdrop. Before each narrative its cast runtime picks the active speakers for `chat-mode-narrator` (`scene-cast@1`). It also applies structured `stage.direction` cues for actor presence, focus, position, and visual variants. This root `PLUGIN.md` is metadata only — executable runtimes live under `runtimes/`.

---
name: scene-stage/direction
description:
  zh: 接收结构化舞台演出指令，跟踪角色登退场、站位、焦点及服装/表情/姿势。
  en: Applies structured stage directions for actor presence, position, focus, outfit, expression, and pose.
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: system
capabilities: [stage-direction]
tags:
  - mode:dialogue
  - role:scene-state
  - role:character
  - cost:function
trigger:
  type: event
  topic: stage.direction
events:
  - topic: stage.direction
    schema: ./schemas/stage-direction.event.json
    description:
      zh: "当角色登场、退场、换位、说话焦点或服装/表情/姿势发生变化时必须发射。一次调用携带完整 cues 数组，例如 {cues:[{type:'actor.enter',character:'朝仓凛',position:'left',outfit:'default',expression:'smile',pose:'default',focus:true,transition:'fade'}]}。无变化时不要发射。"
      en: "Must emit when an actor enters, leaves, moves, gains focus, or changes outfit/expression/pose. Send every change in one cues array, for example {cues:[{type:'actor.enter',character:'Rin',position:'left',outfit:'default',expression:'smile',pose:'default',focus:true,transition:'fade'}]}. Do not emit when nothing changed."
---

The direction runtime is the authoritative, persistent actor layout for stage
mode. It is additive to `scene-cast`: worlds and narrators that never emit
`stage.direction` continue to use the deterministic cast fallback.

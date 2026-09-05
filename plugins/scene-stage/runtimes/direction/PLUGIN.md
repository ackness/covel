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
      zh: "每轮正文前发射一次：cues 合并本轮全部登退场、站位、焦点、视觉变体变化；dialogue.paragraphSpeakers 按正文空行分段顺序逐项填写准确角色 ID（来自 active-cast），旁白、混合对白或不确定时填 null。不同说话人必须分段，正文段数和顺序必须与数组一致。无演员变化时 cues 可为空，但必须提供 dialogue。actor.focus 只控制画面焦点，不决定对白署名。actor.leave 与 stage.clear 应指定离场 transition。"
      en: "Emit once before each narrative. Merge all actor entry/exit, position, focus, and visual changes into cues. Supply dialogue.paragraphSpeakers with one exact character ID (from active-cast) per blank-line-separated narrative paragraph, in order; use null for narration, mixed speech, or unknown identities. Separate different speakers into paragraphs and keep the final paragraph count/order identical to the array. cues may be empty only when dialogue is provided. actor.focus controls the visual spotlight, not dialogue attribution. Specify an exit transition for actor.leave and stage.clear."
---

The direction runtime is the authoritative, persistent actor layout for stage
mode. It is additive to `scene-cast`: worlds and narrators that never emit
`stage.direction` continue to use the deterministic cast fallback.

Dialogue attribution is independent from actor focus. The optional
`dialogue.paragraphSpeakers` array supplies one exact character ID or `null`
for each blank-line-separated narrative paragraph (1-80 entries). The handler
resolves IDs against session characters and commits `{ schemaVersion: 1,
turnId, paragraphSpeakers: [{ characterId, displayName } | null] }` under
`dialogue/<turnId>`. Unknown IDs become `null` with a diagnostic; names are
never guessed from the prose. Dialogue-only events do not clear actor state.

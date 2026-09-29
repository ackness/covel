---
type: function
description:
  zh: 接收结构化舞台演出指令，跟踪角色登退场、站位、焦点及服装/表情/姿势。
  en: >-
    Applies structured stage directions for actor presence, position, focus,
    outfit, expression, and pose.
schedule:
  trigger:
    type: event
    topic: stage.direction
io:
  output:
    contract: stage-direction@1
  visibility: system
function:
  handler: ./handler.js
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

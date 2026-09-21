---
name: jev-choice-demo
displayName: { zh: "Jev 选项推荐 Demo", en: "Jev Choice Recommendations Demo" }
description:
  zh: "用 evaluation 模型评估当前快捷选项，在舞台展示推荐概率；供插件开发者参考。"
  en: "Evaluates current quick replies and displays recommendation probabilities on stage; an example for plugin authors."
pluginType: plugin
runtimeType: function
handler: ./handler.js
entry: ./server.js
ui:
  right: [./ui/recommendations.json]
stage: post-turn
outputKind: system
capabilities: [choice-recommendations]
tags: [role:demo, cost:llm]
timeoutMs: 15000
trigger: { type: scheduled, interval: 1 }
inputs:
  choices:
    from: { capability: scene-prompts, cardinality: one }
    accepts: ./schemas/choices.schema.json
    required: true
  narrative:
    from: { capability: narrative-engine, cardinality: one }
    select: /narrativeOutput
    accepts: ./schemas/narrative.schema.json
    required: true
userSettings:
  - key: evaluationSlot
    type: slot
    default: evaluation
    label: { zh: "评估模型用途", en: "Evaluation model role" }
    description:
      zh: "选择绑定了 evaluation 模型的用途，例如 evaluation 或 intent。支持 Jev 及同能力模型。"
      en: "Choose a role bound to an evaluation model, such as evaluation or intent. Supports Jev and other evaluation models."
  - key: goal
    type: textarea
    label: { zh: "推荐目标", en: "Recommendation goal" }
    description:
      zh: "可选。描述希望优先考虑的目标；留空时按玩家最新意图和当前场景推荐。"
      en: "Optional. Describe what to prioritize; when empty, recommendations follow the player's latest intent and scene."
---

This opt-in demo consumes typed inputs from the current execution, calls
a public `recommend` service (which calls `ctx.gateway.evaluate()` once) with a Choice question, and publishes only its own
`recommendations/current` record. It never chooses or sends a player action.

The model returns a distribution over the existing candidates, not a forecast of
action success. The selected evaluation role controls the provider, model and
protocol; the handler contains no Jev-specific HTTP code.

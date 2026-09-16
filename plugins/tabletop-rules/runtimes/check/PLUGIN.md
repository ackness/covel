---
name: tabletop-rules/check
description:
  {
    zh: 提交属性检定，结果不会因重试而重掷,
    en: Submit an attribute check without rerolling on retries,
  }
pluginType: plugin
runtimeType: function
handler: ./handler.js
stage: pre-turn
outputKind: system
capabilities: [tabletop-check]
ui:
  right: [./ui/check-panel.json]
trigger: { type: scheduled, interval: 1 }
tools:
  builtin: [list-characters, create-form]
---

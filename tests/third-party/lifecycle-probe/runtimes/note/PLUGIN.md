---
name: lifecycle-probe/note
description: { zh: 写入确定性测试记录, en: Write a deterministic test record }
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
capabilities: [manual-invoke]
execution: sync
trigger: { type: manual }
dataSchemas:
  notes:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/note.schema.json
userSettings:
  - key: label
    type: text
    default: fixture
    label: { zh: 记录前缀, en: Record prefix }
  - key: count
    type: integer
    default: 1
    min: 1
    max: 5
    label: { zh: 测试数值, en: Test number }
  - key: enabled
    type: toggle
    default: true
    label: { zh: 启用记录, en: Enable records }
ui:
  right: [./ui/panel.json]
---

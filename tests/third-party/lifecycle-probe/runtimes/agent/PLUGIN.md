---
name: lifecycle-probe/agent
description:
  {
    zh: 通过本地工具写入测试记录,
    en: Write a test record through an agent tool call,
  }
pluginType: plugin
runtimeType: agent
outputKind: plugin
capabilities: [manual-invoke]
trigger: { type: manual }
model: plugin
maxSteps: 2
maxRetries: 0
completeAfterTools: [lifecycle-probe-record]
requireExplicitCompletion: true
tools:
  plugin: [lifecycle-probe-record]
userSettings:
  - key: voice
    type: select
    default: concise
    label: { zh: 测试风格, en: Test style }
    options:
      - value: concise
        label: { zh: 简洁, en: Concise }
      - value: detailed
        label: { zh: 详细, en: Detailed }
---

Test style: {{ userSettings.voice }}.
When a note should be recorded, call lifecycle-probe-record once with key "agent" and text "Agent fixture record".
If no note should be added, call runtime-done without inventing a write.
Successful completion of the record tool ends the runtime.

---
type: agent
description:
  zh: 通过本地工具写入测试记录
  en: Write a test record through an agent tool call
schedule:
  trigger:
    type: manual
io:
  visibility: plugin
agent:
  model: plugin
  tools:
    plugin:
      - lifecycle-probe-record
  loop:
    maxSteps: 2
    maxRetries: 0
    completion:
      require: explicit
      afterTools:
        - lifecycle-probe-record
---

Test style: {{ userSettings.voice }}.
When a note should be recorded, call lifecycle-probe-record once with key "agent" and text "Agent fixture record".
If no note should be added, call runtime-done without inventing a write.
Successful completion of the record tool ends the runtime.

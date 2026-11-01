---
description: Write a test record through an agent tool call
schedule:
  trigger:
    type: manual
agent:
  tools:
    plugin:
      - lifecycle-probe-record
  loop:
    maxSteps: 2
    maxRetries: 0
---

Test style: {{ userSettings.voice }}.
When a note should be recorded, call lifecycle-probe-record once with key "agent" and text "Agent fixture record".
If no note should be added, submit `{}` through `submit-output` without inventing a write.
After the record tool succeeds, submit `{}` through `submit-output` in a separate call.

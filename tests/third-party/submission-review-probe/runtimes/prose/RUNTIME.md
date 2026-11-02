---
description: Submit a schema-less prose story for acceptance testing
schedule:
  trigger:
    type: manual
io:
  visibility: story
agent:
  loop:
    maxSteps: 4
    maxRetries: 0
---

Write one short observable paragraph in the session content language. Use the host-generated `submit-output` tool alone, with `narrativeOutput`. Do not write reply text or invent a business operation. The tool acknowledgement is not a commit receipt.

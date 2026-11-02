---
version: 1.0.0
displayName: Submission Review Probe
description: Test-only, explicitly enabled output correction injection.
contributes:
  settings:
    - key: mode
      type: select
      default: disabled
      label: Injection mode
      options:
        - value: disabled
          label: Disabled
        - value: review-once
          label: Reject the first valid output
        - value: schema-once
          label: Replace the first submission with an invalid object
    - key: targetRuntime
      type: text
      default: narrator
      label: Subject runtime ID
  hooks:
    - PreToolUse
    - ReviewAgentOutput
    - SessionEnd
---

Test-only observer with manually selected prose/delegation runtimes. No business tools or writes. Enable it only in separately labelled injected samples. One injection per session, turn and subject runtime; restarting the server resets the observer.

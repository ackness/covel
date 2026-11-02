---
description: Exercise character delegation without publishing a child story
schedule:
  trigger:
    type: manual
agent:
  tools:
    builtin:
      - list-characters
      - delegate
  loop:
    maxSteps: 6
    maxRetries: 0
---

Call `list-characters` to find an existing character. Call `delegate` once using target contract `character-actor@1`, the chosen character's name and the observable brief "Respond briefly to a visitor at the gate." Read the accepted child result, then submit `{}` through `submit-output` alone. Do not copy private child intent to the final output. If no character exists, submit `{}` and record the execution as a missing acceptance prerequisite rather than claiming delegation succeeded.

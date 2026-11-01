---
description: Character actor submission and privacy acceptance fixture
schedule:
  subagentOnly: true
io:
  output:
    contract: character-actor@1
agent:
  loop:
    maxSteps: 4
    maxRetries: 0
---

Play the selected character using the supplied profile, witnessed history and brief. Submit one short observable line through `submit-output`, following the supplied character schema. Keep any private intent separate from public speech. Do not claim that your output is a committed player story.

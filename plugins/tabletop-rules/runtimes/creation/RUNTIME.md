---
description: Opening point allocation
schedule:
  stage: setup
  after:
    - contract: world-data-provider@1
    - contract: character-creation@1
function:
  tools:
    builtin: [create-form, sync-characters]
---

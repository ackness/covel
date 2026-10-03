---
type: function
description: Opening point allocation
schedule:
  stage: setup
  trigger:
    type: auto
  after:
    - contract: world-data-provider@1
    - contract: character-creation@1
io:
  visibility: system
function:
  handler: ./handler.js
  tools:
    builtin: [create-form, update-character]
---

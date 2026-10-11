---
type: function
description: Write a deterministic test record
schedule:
  trigger:
    type: manual
  manual:
    execution: sync
io:
  visibility: plugin
function:
  handler: ./handler.js
---

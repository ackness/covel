---
type: function
description: Write a test record in a background job
schedule:
  trigger:
    type: manual
  manual:
    execution: background
io:
  visibility: plugin
function:
  handler: ./handler.js
---

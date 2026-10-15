---
type: function
description: Write a test record in a background job
schedule:
  trigger:
    type: manual
  manual:
    execution: background
function:
  handler: ./handler.js
---

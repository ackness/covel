---
type: function
description: >-
  Writes a structured record into this plugin's `notes` namespace when
  triggered from the sidebar. Function-runtime starter.
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

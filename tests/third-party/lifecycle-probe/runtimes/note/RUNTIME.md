---
type: function
description:
  zh: 写入确定性测试记录
  en: Write a deterministic test record
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

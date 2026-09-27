---
type: function
description:
  zh: 后台写入测试记录
  en: Write a test record in a background job
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

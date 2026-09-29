---
type: function
description:
  zh: 生成固定测试叙事
  en: Produce a deterministic test story
schedule:
  stage: narrative
  trigger:
    type: auto
io:
  output:
    contract: narrative-engine@1
  visibility: story
function:
  handler: ./handler.js
---

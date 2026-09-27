---
type: function
description:
  zh: 后台生成缺失的场景背景图
  en: Generates missing scene backgrounds in the background
schedule:
  trigger:
    type: event
    topic: scene-stage.generate.requested
  manual:
    execution: background
io:
  output:
    contract: image-generation@1
  visibility: plugin
function:
  handler: ./handler.js
---

Background-gen calls the framework image pipeline (`ctx.images`) to render a scene background from the registry's shared `style` block plus the scene's `visualHint`. Runs off the turn's critical path; day variants generate first, night variants lazily on first request.

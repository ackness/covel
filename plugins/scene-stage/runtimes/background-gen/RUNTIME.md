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
  visibility: plugin
function:
  handler: ./handler.js
---

Background-gen calls the framework image pipeline (`ctx.images`) using the `modelPresetId` image slot (default `image`) to render a scene background from the registry's shared `style` block plus the scene's `visualHint`. This built-in scene asset workflow does not depend on a community illustration plugin or the `media.image-flow@1` extension. Runs off the turn's critical path; day variants generate first, night variants lazily on first request. The resolver does not enqueue work when the selected image slot is unavailable; already queued work also skips before progress or generation if that slot becomes unavailable and clears a matching pending stage. Configure an image-capable `[covel.<slot>]` in `llm.toml` and send `scene.set` again to request a missing background. For failures after generation starts, inspect the background-generation job and provider error.

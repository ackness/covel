---
type: function
description:
  zh: 跟踪叙事当前所在的场景与昼夜，为舞台背景提供数据。
  en: Tracks the current scene and time of day for the visual stage.
schedule:
  trigger:
    type: event
    topic: scene.set
io:
  output:
    contract: scene-stage@1
  visibility: system
function:
  handler: ./handler.js
---

Scene Stage's resolver is a deterministic function runtime triggered by `scene.set`. It resolves the current location and time of day against the world's scene registry (and scenes generated earlier this session), then publishes `stage/current` for the visual stage to consume. Scenes with no registry match are queued for background generation via `scene-stage/background-gen`, gated by `autoGenerateScenes` and `maxGeneratedScenes`.

Note: `events[].schema` and `dataSchemas.*.schema` paths resolve relative to the **plugin root** (`plugins/scene-stage/`), not this runtime's directory — see `apps/server/src/routes/api/bootstrap/event-directory.ts` and `apps/server/src/world-data/schema-registry.ts`. Only `handler` and `ui.*` paths resolve relative to this runtime's own directory.

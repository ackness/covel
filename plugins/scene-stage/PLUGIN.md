---
name: scene-stage
displayName:
  zh: 场景舞台
  en: Scene Stage
description:
  zh: 跟踪叙事当前所在的场景与昼夜，为舞台背景提供数据。
  en: Tracks the current scene and time of day for the visual stage.
pluginType: plugin
---

Scene Stage tracks the current scene/location and time of day for the visual stage, resolving `scene.set` events into `stage/current` and queuing background generation for unmatched locations. This root `PLUGIN.md` is metadata only — see `runtimes/resolver/PLUGIN.md` (the `scene.set` consumer) and `runtimes/background-gen/PLUGIN.md` (the image generation follower) for the executable runtimes.

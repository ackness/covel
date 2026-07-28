---
name: scene-stage/seed
description:
  zh: 开局时为舞台种下世界注册表里的第一个场景，避免叙事未发 scene.set 时舞台空白。
  en: Seeds the stage with the world registry's first scene at setup, so the stage is never blank before the narrative emits scene.set.
pluginType: plugin
stage: setup
runtimeType: function
resultFormat: envelope-v1
handler: ./handler.js
outputKind: system
tags:
  - mode:dialogue
  - role:scene-state
  - cost:function
trigger:
  type: auto # setup runtimes are auto-only; maxTriggerCount is the retry budget
  maxTriggerCount: 1
---

# Scene Stage 开场种子

`scene.set` 的发射方是叙事 LLM（通过事件目录的【必做】指示）。指示是提示词约束，不是保证：弱模型可能整局不发，舞台就一直空白，而 `scene-stage/resolver` 是 `event` 触发的，没有事件就永远不跑。

这个 runtime 是那条链路的确定性下限。它在 `stage: setup` 跑一次——**早于任何叙事输出**，所以不与 LLM 发的 `scene.set` 竞争（两者若在同一回合发射，事件扇出顺序不定，后写的会盖掉正确场景）。

## 行为

1. `stage/current` 已存在（恢复会话、setup 重试）→ 跳过，绝不覆盖。
2. 世界没有场景注册表，或注册表为空 → 跳过。未启用舞台模式的世界零影响。
3. 否则把注册表第一个场景按白天变体写入 `stage/current`，`source: "world"`。

叙事之后发的 `scene.set` 由 resolver 正常处理并覆盖此记录——种子只负责"第一帧不是空的"。

注册表的第一个场景即开场场景：世界包的 `scenes` 数组顺序由作者决定（见 `docs/reference/world-data.md`），`scripts/emit-scenes.mjs` 保序输出。

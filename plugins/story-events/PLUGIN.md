---
id: story-events
kind: plugin
displayName:
  zh: 隐藏事件
  en: Hidden Story Events
description:
  zh: 世界包声明的隐藏剧情在条件满足前对模型与玩家都不可见；满足时由叙事在本回合自然演出。
  en: >-
    Keeps world-authored hidden story events out of prompts and player views
    until their conditions are met, then hands narration that turn's cue.
tags:
  - "data:world-data"
  - "cost:function"
provides:
  - story-event-cue@1
optional:
  - world-time-context@1
  - world.dimensions@1
  - story-event.plan@1
contracts:
  story-event-cue@1:
    schema: ./schemas/story-event-cue.schema.json
  story-event.plan@1:
    schema: ./schemas/story-event-plan.schema.json
  story.events@1:
    schema: ./schemas/story-events.schema.json
contributes:
  data:
    events:
      schema: ./schemas/story-events.schema.json
      version: 1
      accepts:
        - story.events@1
---

Deterministic hidden story events. World packages import events through a
`visibility: hidden` worldData source; the `evaluate` pre-turn runtime reveals
at most one event per turn as a `story-event-cue@1` output for narration.
Other runtimes can add follow-up events during play by publishing
`story-event.plan@1`; the `intake` post-turn runtime validates and stores them.

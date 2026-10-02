---
id: story-plotter
kind: plugin
displayName:
  zh: 剧情策划
  en: Story Plotter
description:
  zh: 每隔几回合根据剧情发展，在幕后埋下之后才会发生的隐藏事件，由隐藏事件插件在条件满足时揭示。
  en: >-
    Every few turns, plants hidden follow-up events from how the story has
    developed; Hidden Story Events reveals them once their conditions are met.
tags:
  - "cost:llm"
provides:
  - story-event.plan@1
requires:
  - narrative-engine@1
  - story-event-cue@1
optional:
  - world.dimensions@1
  - world-time-context@1
  - world-ir-provider@1
entry: ./server/index.js
contributes:
  tools:
    - plan-story-events
---

# Story Plotter

A background planner for `story-events`. It publishes `story-event.plan@1`;
story-events validates each plan and keeps accepted events hidden until they
fire.

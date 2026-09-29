---
id: director
kind: plugin
displayName:
  zh: 导演前言
  en: Director's Note
description:
  zh: 给主线叙事 runtime 注入一段“导演前言”：只塑形 story 类提示词，其它 runtime 完全不碰。
  en: >-
    Injects a "director's note" into the main narrative runtime — shapes only
    story-kind prompts and leaves every other runtime untouched.
tags:
  - "cost:function"
provides:
  - narration-director@1
entry: ./server/index.js
contributes:
  extensions:
    - point: prompt.segment@1
      id: direction
---

# Director

Provides `prompt.segment@1` with a localized, stable system segment for `audience: story`.
The host selects the audience and inserts the guidance before the stable cache boundary.
The preamble in `hooks/_preamble.js` describes scene delivery and player agency; it does not alter world records or generate proposals.

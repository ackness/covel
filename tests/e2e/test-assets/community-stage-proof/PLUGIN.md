---
id: community-stage-proof
kind: plugin
displayName:
  en: Community Stage Proof
  zh: 社区舞台验证
description:
  en: Isolated community package for real UI slot projection tests.
  zh: 用于真实 UI 槽位投影测试的隔离社区包。
entry: ./server/index.js
contributes:
  extensions:
    - point: ui.slot@1
      id: backdrop
      slot: stage.backdrop@1
      order: 100
      watch:
        - scenery_private
      preview:
        - community-stage.preview
    - point: ui.slot@1
      id: cast
      slot: stage.cast@1
      order: 100
      watch:
        - cast_private
    - point: ui.slot@1
      id: portrait
      slot: character.visual@1
      order: 100
      watch:
        - portraits_private
---

The package is copied into an isolated community plugin directory before the
dedicated acceptance server starts. Its three projections read only its own
private namespaces; they intentionally use different names from bundled plugins.

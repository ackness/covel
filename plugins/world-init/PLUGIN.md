---
id: world-init
kind: core
displayName:
  zh: 世界初始化
  en: World Setup
description:
  zh: 开局整理世界资料，让角色属性和世界词条更符合当前世界。
  en: >-
    Prepares the world's key details at the start so characters and lore fit the
    setting.
tags:
  - "data:world-data"
  - "data:characters"
  - "cost:llm"
  - "ui:right-panel"
provides:
  - world-data-provider@1
entry: ./server/index.js
contributes:
  extensions:
    - point: session.world-context@1
      id: world-context
  ui:
    right:
      - ./runtimes/schema-gen/ui/world-overview.json
      - ./runtimes/schema-gen/ui/world-schema.json
  tools:
    - world-dimension-get
    - set-world-schema
    - set-world-entries-batch
    - initialize-world
---

# World Setup

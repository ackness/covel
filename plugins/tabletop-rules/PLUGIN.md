---
id: tabletop-rules
kind: plugin
displayName:
  zh: 跑团规则
  en: Tabletop Rules
description:
  zh: 在角色创建后追加开局配点，以程序结算属性检定，并保留可复核的骰子记录。
  en: >-
    Layer opening point allocation onto character creation and resolve attribute
    checks with durable dice receipts.
provides:
  - tabletop-check@1
entry: ./server/index.js
contracts:
  tabletop-rules.rules.initial@1:
    schema: ./schemas/rules.schema.json
contributes:
  ui:
    right:
      - ./runtimes/check/ui/check-panel.json
  data:
    rules:
      schema: ./schemas/rules.schema.json
      version: 1
      accepts:
        - tabletop-rules.rules.initial@1
  forms:
    - point-buy
---

Optional deterministic tabletop rules, using the public third-party plugin API.

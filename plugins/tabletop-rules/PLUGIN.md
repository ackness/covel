---
name: tabletop-rules
displayName: { zh: 跑团规则, en: Tabletop Rules }
description:
  zh: 在角色创建后追加开局配点，以程序结算属性检定，并保留可复核的骰子记录。
  en: Layer opening point allocation onto character creation and resolve attribute checks with durable dice receipts.
pluginType: plugin
entry: ./server/index.js
relations:
  recommends: [char-creator]
---

Optional deterministic tabletop rules, using the public third-party plugin API.

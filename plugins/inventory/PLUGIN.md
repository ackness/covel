---
id: inventory
kind: plugin
displayName:
  zh: 行囊
  en: Inventory
description:
  zh: 每回合从叙事中记录明确的物品得失与装备变化，右栏随时可查背包。
  en: >-
    Records explicit item gains, losses, and equipment changes from each turn's
    narrative, with an always-available bag panel.
tags:
  - "data:world-data"
  - "cost:function"
  - "ui:right-panel"
  - "ui:message-block"
provides:
  - world-ir.vocabulary@1
requires:
  - world-ir-provider@1
entry: ./server/index.js
contracts:
  inventory.items@1:
    schema: ./schemas/items.schema.json
contributes:
  commands:
    - name: bag
      aliases:
        - inventory
      description:
        zh: 查看当前背包并打开行囊面板。
        en: View the current bag and open the inventory panel.
      action: open-bag
  data:
    items:
      schema: ./schemas/items.schema.json
      description: >-
        Importable inventory items — world packages can seed the player's
        opening gear.
      version: 1
      accepts:
        - inventory.items@1
  ui:
    right:
      - ./ui/inventory-panel.json
    message:
      - ./ui/inventory-message.json
  actions:
    - item-op
    - open-bag
---

# Inventory

Keeps the protagonist's bag. The `ledger` runtime applies each turn's item gains, losses, and equipment changes from the shared WorldIR extraction without a model call; the `vocabulary` runtime publishes the carried item names before extraction so the extractor reuses them. Players can equip, unequip, or drop items from the panel, and `/bag` opens it. This root `PLUGIN.md` is metadata only — executable runtimes live under `runtimes/`.

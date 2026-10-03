---
id: inventory
kind: plugin
displayName: Inventory
description: >-
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
contributes:
  commands:
    - name: bag
      aliases:
        - inventory
      description: View the current bag and open the inventory panel.
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
      authoring:
        title: Opening inventory
        hint: >-
          List what the player carries when the story opens. `quantity` is a
          number. Tag money with `currency`. Set `equipped` to true for gear the
          player is wearing or holding. Keep the list short; items gained in
          play are tracked automatically.
        example: ./examples/items.json
        source:
          kind: yaml
          path: data/items.yaml
          key: id
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

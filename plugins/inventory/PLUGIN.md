---
version: 0.0.48
displayName: Bag
description: >-
  Keeps track of what you carry. Items you gain, lose or equip in the story are
  added to your bag automatically.
tags:
  - "data:world-data"
author:
  name: Covel Contributors
  url: https://github.com/ackness/covel
license: MIT
contributes:
  events:
    - topic: inventory.reconcile
      schema: ./schemas/reconcile.event.json
      advertise: false
      description: Reconciles the bag after the turn's staged runtimes.
  services:
    - contract: inventory.bag@2
      modelFacing: true
    - contract: inventory.change@1
      access: write
      modelFacing: true
  commands:
    - name: bag
      aliases:
        - inventory
      description: Show what you are carrying and open the Bag tab.
      action: open-bag
  datasets:
    items:
      schema: ./schemas/items.schema.json
      key: id
      ops: [set, merge, inc, delete]
  data:
    items:
      schema: ./schemas/items.schema.json
      description: >-
        Items the player carries when the story begins.
      accepts:
        - inventory.items@1
      authoring:
        title: Starting items
        hint: >-
          List what the player carries when the story opens. `quantity` is a
          number. Players see the tags, so write them in the world's language
          and tag money as currency in that language. Set `equipped` to true for
          gear the player is wearing or holding. Keep the list short; items
          gained in play are tracked automatically. An item can help one
          kind of check while it is carried: `effects: { check: { attribute:
          <check attribute id>, modifier: 2 } }` (from -5 to 5); say why in
          its `description`.
        example: ./examples/items.json
        source:
          path: data/items.yaml
        references:
          - path: effects.check.attribute
            to: character-attribute
            type: number
  ui:
    right:
      - ./ui/inventory-panel.json
    message:
      - ./ui/inventory-message.json
  actions:
    - open-bag
  extensions:
    - point: ui.slot@1
      id: summary
      slot: session.summary@1
      order: 30
      watch:
        - items
---

# Inventory

Keeps the protagonist's bag. The `ledger` runtime applies each turn's item gains, losses, and equipment changes from the shared WorldIR extraction without a model call; the `vocabulary` runtime publishes the carried item names before extraction so the extractor reuses them. Players can equip, unequip, or drop items from the panel, and `/bag` opens it. A world can give an item `effects.check`, a modifier that checks of one attribute get while the item is carried; `inventory.bag@2` reports it, and a check plugin can add it. This root `PLUGIN.md` is metadata only — executable runtimes live under `runtimes/`.

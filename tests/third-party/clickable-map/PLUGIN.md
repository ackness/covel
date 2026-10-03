---
id: clickable-map
kind: plugin
displayName:
  zh: 可点击地图
  en: Clickable Map
description:
  zh: 示例插件：一张自己绘制的地图，点地点就走过去。
  en: "Example plugin: a self-drawn map; select a place to travel there."
entry: ./server/index.js
contributes:
  events:
    - topic: map.opened
      schema: ./schemas/map-opened.event.json
      advertise: false
      description:
        zh: 地图面板第一次打开、还没有地图数据时由界面发出。
        en: Emitted by the map panel when it opens before any map data exists.
    - topic: map.location-selected
      schema: ./schemas/location-selected.event.json
      advertise: false
      description:
        zh: 玩家在地图上选了一个相邻地点时由界面发出。
        en: Emitted by the map panel when the player selects a linked place.
  extensions:
    - point: ui.slot@1
      id: summary
      slot: session.summary@1
      order: 40
      watch:
        - map
  ui:
    right:
      - ./ui/map-panel.json
---

# Clickable Map

Example package. Executable runtimes live under `runtimes/`; see README.md.

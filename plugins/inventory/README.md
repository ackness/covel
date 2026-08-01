# inventory

维护会话中的行囊台账，记录叙事里明确发生的物品获得、失去、消耗和装备变化。

## 运行时结构

- `PLUGIN.md`：叙事后执行的 agent runtime。
- `tools/update-inventory.js`：批量提交本轮物品变化（add / remove / set / equip / unequip）。
- `schemas/items.schema.json`：`items` namespace 的导入 schema（世界包可预置开局装备）。
- `ui/inventory-panel.json`：右侧行囊面板（已装备分组 + 背包列表）。
- `ui/inventory-message.json`：聊天区的本回合得失摘要块。

## 数据与行为

- 读取最新叙事和当前背包摘要，只记录叙事**明确发生**的变化，不发明物品。
- 物品写入 `plugin_data[inventory][items]`，按名称去重、数量自动叠加，name 映射为稳定短 ID。
- 减到 0 的物品写 tombstone（`quantity: 0, removed: true`）而非删除行：proposal 管道没有删除类型，UI 会隐藏 tombstone，同名物品再次获得时复用同一条记录。
- 货币也是物品（`tags` 含 `"currency"`）；大宗模糊数量会合理量化并在描述中注明估算。
- 每回合的得失摘要写入 `plugin_data[inventory][message]`（key 为 turnId），驱动聊天区 toast。
- 没有明确变化的回合跳过写入。

## 世界包导入

`items` namespace 声明了 `acceptsWorldData: true`，世界包可以在 `worldData` 里预置开局装备：

```yaml
sources:
  startingGear:
    kind: json
    path: data/inventory/starting-gear.json
    schema: plugin://inventory/items
    to: plugin:inventory/items
    key: id
```

条目形状：`{ id, name, quantity, description?, tags?, equipped? }`。

## 开发

修改判定规则、工具 schema 或 UI spec 后，运行本包测试。

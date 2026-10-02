# inventory

维护会话中的行囊台账，记录叙事里明确发生的物品获得、失去、消耗和装备变化。变化从共享的 WorldIR 抽取中读取，不调用模型。

## 运行时结构

- `PLUGIN.md`：插件级元信息，本身不是可执行 runtime。
- `runtimes/vocabulary/`：pre-turn function runtime，把背包里的物品名作为 `world-ir.vocabulary@1` 发布给事实抽取，让它沿用同一名称。
- `runtimes/ledger/`：post-turn function runtime，读取本轮 WorldIR 的 `inventory_change` 事件并记账。
- `lib/world-ir.js`：把主角持有的物品事件映射为台账变化（`gain` → add、`lose` → remove、`equip` / `unequip`）。
- `lib/update-inventory.js`：批量提交物品变化（add / remove / set / equip / unequip）的台账逻辑。
- `schemas/items.schema.json`：`items` namespace 的导入 schema（世界包可预置开局装备）。
- `ui/inventory-panel.json`：右侧行囊面板（已装备分组 + 背包列表）。
- `ui/inventory-message.json`：聊天区的本回合得失摘要块。
- `rpc/open-bag.js`：`/bag`（别名 `/inventory`）命令处理器，统计当前物品并打开右侧行囊面板。

## 数据与行为

- 只记录 WorldIR 中归属主角的 `inventory_change` 事件；物品名取事件引用的 item 实体，数量缺省为 1。其他角色的物品变化不进背包。事件的固定字段由 `world-ir` 约定并校验。
- 物品写入 `plugin_data[inventory][items]`，按名称去重、数量自动叠加，name 映射为稳定短 ID。
- 减到 0 的物品写 tombstone（`quantity: 0, removed: true`）而非删除行：proposal 管道没有删除类型，UI 会隐藏 tombstone，同名物品再次获得时复用同一条记录。
- 货币也是物品；item 实体 `attributes.tags` 中的标签会随获得写入。
- 每回合的得失摘要写入 `plugin_data[inventory][message]`（key 为 turnId），驱动聊天区 toast。
- 没有明确变化的回合跳过写入。

## 玩家侧操作

- `rpc/item-op.js` 经 entry 注册为 `item-op` action，面板逐物品按钮（`invokePluginAction`）触发：`equip` / `unequip` / `drop`。
- `rpc/open-bag.js` 经同一 entry 注册为 `open-bag` action；只读取当前 session 的 `items` namespace，不修改行囊台账。
- 刻意只到装备位与丢弃：装备是玩家的配置选择、不经叙事；"使用物品"必须走故事输入，静默扣数量的按钮会绕过叙事引擎。
- `drop` 写与台账 remove-to-zero 同款墓碑（`quantity: 0, removed: true`），剧情侧与玩家侧移除共享一个模型，同名再获得复活同一记录。

## 世界包导入

`contributes.data.items.accepts` 声明接收 `inventory.items@1`。世界包可以按数据契约预置开局装备，导入时由当前活动插件的声明确定接收者：

```yaml
sources:
  startingGear:
    kind: json
    path: data/inventory/starting-gear.json
    schema: contract:inventory.items@1
    to: contract:inventory.items@1
    key: id
```

条目形状：`{ id, name, quantity, description?, tags?, equipped? }`。

## 开发

修改 WorldIR 映射、台账逻辑或 UI spec 后，运行本包测试。

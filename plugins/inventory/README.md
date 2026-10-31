# inventory

维护会话中的行囊台账，记录叙事里明确发生的物品获得、失去、消耗和装备变化。叙事可以先通过服务变更行囊，回合结束后再从共享的 WorldIR 抽取补记其他变化；记账本身不调用模型。

## 运行时结构

- `PLUGIN.md`：插件级元信息，本身不是可执行 runtime。
- `runtimes/vocabulary/`：pre-turn function runtime，把背包里的物品名作为 `world-ir.vocabulary@1` 发布给事实抽取，让它沿用同一名称。
- `runtimes/ledger/`：post-turn function runtime，读取本轮 WorldIR 的 `inventory_change` 事件与 `operations@1`，跳过工具已处理的变化，再补记其余变化。
- `lib/world-ir.js`：把主角持有的物品事件映射为台账变化（`gain` → add、`lose` → remove、`equip` / `unequip`）。
- `lib/update-inventory.js`：批量提交物品变化（add / remove / set / equip / unequip）的台账逻辑。
- `schemas/items.schema.json`：`items` 数据集与世界包导入共用的 schema（世界包可预置开局装备）。
- `ui/inventory-panel.json`：右侧行囊面板（已装备分组 + 背包列表）。
- `ui/inventory-message.json`：聊天区的本回合得失摘要块。
- `rpc/open-bag.js`：`/bag`（别名 `/inventory`）命令处理器，统计当前物品并打开右侧行囊面板。

## 数据与行为

- 台账补记 WorldIR 中归属主角的 `inventory_change` 事件；物品名取事件引用的 item 实体，数量缺省为 1。其他角色的物品变化不进背包。事件的固定字段由 `world-ir` 约定并校验。
- 物品写入 `items` 数据集（`plugin_data[inventory][items]`），按名称查找记录，新物品由 `shortIdBatch` 分配稳定短 ID。新记录用 `set`，已有记录的数量变化用 `inc`；台账移除时以 0 为下界并 clamp；写服务移除不足时整次拒绝。提交时按数据集 schema 校验最终记录。
- 减到 0 时用 `merge` 标记 tombstone（`quantity: 0, removed: true`）并取消装备；装备变化也用 `merge`。UI 隐藏 tombstone，同名物品再次获得时复用同一条记录并清除标记。
- 货币也是物品；item 实体 `attributes.tags` 中的标签会随获得写入。
- 每回合的得失摘要写入 `plugin_data[inventory][message]`（key 为 turnId），驱动聊天区 toast。
- 携带的物品会出现在状态摘要里（`session.summary@1` 槽位）：已装备的在前，最多 8 件，其余显示为数量。面板显示整个背包。
- 没有明确变化的回合跳过写入。

## 公共服务

两项服务都向模型开放。`narrator` 与 `chat-mode-narrator` 可选导入为 `check-bag` 和 `change-inventory`；未启用行囊时不提供这两个工具，故事照常运行。买卖、赠送或消耗发生时，叙事先调用变更工具、再写正文，付款排在前面。

| 服务名   | 契约                       | 输入                                                                  | 输出                                                                                                                                                                             |
| -------- | -------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bag`    | `inventory.bag@1`          | `{ query?: string }`，至多 80 字符，按名称或标签忽略大小写筛选        | `{ items: [{ name, quantity, equipped, tags, description? }], total }`；只含数量大于 0 的非墓碑记录，已装备优先、再按名称排序，最多 50 项，`total` 是筛选后的完整数量，无记录 ID |
| `change` | `inventory.change@1`（写） | `{ changes: [{ op, item, quantity?, description?, tags? }] }`，1–8 项 | `{ results: [{ op, item, status, quantity? }] }`，无记录 ID                                                                                                                      |

`op` 是 `add`、`remove`、`equip` 或 `unequip`；`item` 去掉首尾空白后须为 1–80 字符。`quantity` 只用于增减，是 1–999 的整数，默认 1；`description`（至多 200 字符）与 `tags`（至多 5 项）只用于添加。货币也是带货币标签的物品；不知道准确名称时先查行囊。

写服务先检查整组变化。移除未持有或数量不足的物品、装备或卸下未持有的物品，都以 `refused` 拒绝整次调用，不暂存任何部分。成功调用把物品变更和同款聊天摘要暂存为一个操作；同一调用方后续调用可以看到这些变化。提交时数量不足会以 `conflict` 单独撤回操作，故事仍保存，玩家收到提示，下回合叙事收到未生效摘要。购买失败时，同回合其他行囊变化也可能跳过。

台账按动作和忽略大小写、首尾空白的物品名逐项扣除操作已处理的变化，不比较数量；其他契约与被截断的操作不参与。事实提取仍为正文呈现的变化保留事件，供其他插件读取。数据契约 `inventory.items@1` 仍只用于世界种子。

能力快照新增 `services: ["inventory.bag@1", "inventory.change@1 (write)"]`。内置插件无需审批；社区提供方遵循正常的服务审批策略。

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

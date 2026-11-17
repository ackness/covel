# inventory

维护会话中的背包台账，记录叙事里明确发生的物品获得、失去、消耗和装备变化。叙事可以先通过服务变更背包，回合结束后再从共享的 WorldIR 抽取补记其他变化；记账本身不调用模型。

## 运行时结构

- `PLUGIN.md`：插件级元信息，本身不是可执行 runtime。
- `runtimes/vocabulary/`：pre-turn function runtime，把背包里的物品名作为 `world-ir.vocabulary@1` 发布给事实抽取，让它沿用同一名称。
- `runtimes/reconcile/` 在 post-turn 发出记账信号；`runtimes/ledger/` 在同一事件层的 `check-settlement@1` 之后读取 WorldIR 与 `operations@1`，跳过服务已处理的变化，再补记其余变化。没有检定也照常记账。
- `runtimes/item-op/`：manual function runtime，处理面板的装备、卸下和丢弃操作，经过 proposal 校验后随执行事务提交。
- `lib/world-ir.js`：把主角持有的物品事件映射为台账变化（`gain` → add、`lose` → remove、`equip` / `unequip`）。
- `lib/update-inventory.js`：批量提交物品变化（add / remove / set / equip / unequip）的台账逻辑。
- `schemas/items.schema.json`：`items` 数据集与世界包导入共用的 schema（世界包可预置开局装备）。
- `ui/inventory-panel.json`：右侧背包面板（已装备分组 + 背包列表）。
- `ui/inventory-message.json`：聊天区的本回合得失摘要块。
- `rpc/open-bag.js`：`/bag`（别名 `/inventory`）命令处理器，统计当前物品并打开右侧背包面板。

## 数据与行为

- 台账以可选输入读取本轮 WorldIR（`world-ir@2`）。会话没有这个提供者或本回合抽取失败时，ledger 以 `skipped` 结束，背包只随服务和面板操作变化。
- 台账补记 WorldIR 中归属主角的 `inventory_change` 事件；物品名取事件引用的 item 实体，数量缺省为 1。其他角色的物品变化不进背包。事件的固定字段由 `world-ir` 约定并校验。
- 物品写入 `items` 数据集（`plugin_data[inventory][items]`），按名称查找记录，新物品由 `shortIdBatch` 分配稳定短 ID。新记录用 `set`，已有记录的数量变化用 `inc`；台账移除时以 0 为下界并 clamp；写服务移除不足时整次拒绝。提交时按数据集 schema 校验最终记录。
- 减到 0 时用 `merge` 标记 tombstone（`quantity: 0, removed: true`）并取消装备；装备变化也用 `merge`。UI 隐藏 tombstone，同名物品再次获得时复用同一条记录并清除标记。
- 货币也是物品；item 实体 `attributes.tags` 中的标签会随获得写入。
- 每回合的得失摘要写入 `plugin_data[inventory][message]`（key 为 turnId），驱动聊天区 toast。
- 携带的物品会出现在状态摘要里（`session.summary@1` 槽位）：已装备的在前，最多 8 件，其余显示为数量。面板显示整个背包。
- 没有明确变化的回合跳过写入。
- 台账按正文扣掉的物品记在 `plugin_data[inventory][prose-losses]`（key 是故事回合的 ID；重试时用原回合 ID），带剩余数量和扣除那次执行的回合。
- 重试时谁先扣都只扣一次：同一次重试里，台账从 `operations@1` 读到写服务刚暂存的移除并跳过；之后单独重试台账时，已提交的移除作为种子操作出现在 `operations@1` 里。反过来，台账已经按正文扣过、调用方（例如检定的代价）在对同一回合的重试里再移除同一物品时，写服务从 `prose-losses` 里认领这部分，不再从背包扣，结果的 `status` 为 `skipped`；认领随这次操作提交。

## 公共服务

两项服务都向模型开放。`narrator` 与 `chat-mode-narrator` 可选导入为 `check-bag` 和 `change-inventory`；未启用背包时不提供这两个工具，故事照常运行。买卖、赠送或消耗发生时，叙事先调用变更工具、再写正文，付款排在前面。

| 服务名   | 契约                       | 输入                                                                                              | 输出                                                                                                                                                                                           |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bag`    | `inventory.bag@2`          | `{ query?: string, offset?: number }`；`query` 按名称或标签筛选，至多 80 字符；`offset` 从 0 开始 | `{ items: [{ name, quantity, equipped, tags, description?, effects? }], total }`；只含数量大于 0 的非墓碑记录，已装备优先、再按名称排序，每页最多 50 项，`total` 是筛选后的完整数量，无记录 ID |
| `change` | `inventory.change@1`（写） | `{ changes: [{ op, item, quantity?, description?, tags? }] }`，1–8 项                             | `{ results: [{ op, item, status, quantity? }] }`，无记录 ID                                                                                                                                    |

`op` 是 `add`、`remove`、`equip` 或 `unequip`；`item` 去掉首尾空白后须为 1–80 字符。`quantity` 只用于增减，是 1–999 的整数，默认 1；`description`（至多 200 字符）与 `tags`（至多 5 项）只用于添加。货币也是带货币标签的物品；不知道准确名称时先查背包。

在对已提交回合的重试里（服务上下文带 `sourceTurnId`），写服务先把移除和那个回合台账按正文扣过、还没被认领的数量抵消，抵消掉的部分不再检查也不再扣。写服务先检查整组变化。移除未持有或数量不足的物品、装备或卸下未持有的物品，都以 `refused` 拒绝整次调用，不暂存任何部分。成功调用把物品变更和同款聊天摘要暂存为一个操作；同一调用方后续调用可以看到这些变化。提交时数量不足会以 `conflict` 单独撤回操作，故事仍保存，玩家收到提示，下回合叙事收到未生效摘要。购买失败时，同回合其他背包变化也可能跳过。

台账按动作和忽略大小写、首尾空白的物品名逐项扣除操作已处理的变化。优先读取保留的 `request.changes`；抽取把多次损失合成一项时，台账从中减去请求已经扣掉的数量。请求因长描述被省略时，改读 `result.results` 并按动作和名称匹配：结果的数量是结算后的库存，不能拿来算差额。`skipped` 表示服务已处理但无需改动的装备请求，也参与去重。两份视图不重复计数；其他契约和两份明细都缺失的操作不参与。数据契约 `inventory.items@1` 仍只用于世界种子。

能力快照列出 `services: ["inventory.bag@2", "inventory.change@1 (write)"]`。自定义提供方和调用方都要改用 `inventory.bag@2`，并支持 `offset` 分页。背包数据不用重建。内置插件无需审批；社区提供方遵循正常的服务审批策略。

## 玩家侧操作

- `runtimes/item-op/` 是 manual function runtime，面板逐物品按钮通过 `invokeRuntime` 调用 `inventory/item-op`，执行 `equip` / `unequip` / `drop`。物品变化先暂存，经过 proposal 校验后随执行事务一起提交；失败时不写入。
- `rpc/open-bag.js` 经同一 entry 注册为 `open-bag` action；只读取当前 session 的 `items` namespace，不修改背包台账。
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

世界预置和同步替换按数据集的 `set` 校验；权威来源移除预置记录时允许 `delete`。同步仍受 schema 与大小限制，`force` 不绕过这些规则。

## 开发

修改 WorldIR 映射、台账逻辑或 UI spec 后，运行本包测试。

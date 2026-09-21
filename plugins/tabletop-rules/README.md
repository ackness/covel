# tabletop-rules

官方维护的可选跑团插件。可以独立打 ZIP 安装，使用第三方可用的公开接口；不会自动启用。

## 运行时结构

- `creation` 在角色创建之后追加开局配点：不声明 `character-creation` capability，因此**不替换**默认创角 runtime；它声明弱排序 `after: [world-data-provider, character-creation]`，等待 `char-creator/player-init`（或其替代者）创建角色后，在已有角色上弹出仅含可配属性的表单，提交后用 `update-character` 把分配值并入角色字段（身份、性格等字段保留）。
- `check` 在每回合开始时处理已提交的属性检定，输出不可改写的结算结果。玩家从右侧“属性检定”面板点击“发起属性检定”后，才会显示包含行动、属性和难度的表单；普通回合不会弹出表单。
- 配点为整数、每点成本 1、必须用完预算。属性修正直接取角色当前属性，d20 对抗 DC 8/12/16/20；自然 1/20 为大失败/大成功。这是本插件的规则，不是框架规则。

## 数据与配置

默认从世界 schema 的有界整数 `abilities` 属性生成配点规则，基础值取该属性默认值，额外预算为 4（不超过剩余容量）。健康、体力等资源不会自动纳入配点。

世界既没有配置规则、也没有可配点属性（如纯对话世界）时，`creation` 静默跳过配点：不弹表单、不报错，也不阻塞开场流程；`check` 相应保持惰性，面板按钮会给出明确提示。世界显式配置了规则但与角色 schema 不符时仍会失败，避免展示一张无法完成的表单。

世界 schema 已在之前的 setup 回合生成时，通过公开的 `get-character-schema` 工具读取已提交结果，支持配点失败后恢复以及已有角色的后补启用。

同一 setup execution 中通过 `world-data-provider` 的 `worldSchema` 输出读取属性，兼容 schema 映射和直接的角色属性 schema；世界初始化 guard 从世界包导入数据并跳过模型调用时也能直接配点。

世界可通过现有 world-data 导入声明 `schema: plugin://tabletop-rules/rules`、`to: plugin:tabletop-rules/rules`、`key: id`，提供 `{ "id": "creation", "budget": 4, "attributes": [{ "id": "combat", "label": "格斗", "base": 1, "max": 5 }] }`。`key` 是 JSON 对象中的字段名。所选属性必须符合世界角色 schema。表单首次显示时冻结规则，避免后续改配置改变已展示表单的含义。

表单先执行类型、范围、步长和插件配点校验，再接受输入。错误可以在原表单上修改；已接受输入不可篡改。角色字段写入、规则记录和检定回执使用执行事务。检定按提交 ID 去重，重启或重试已提交成功的执行不会重掷。执行失败且没有提交回执时，重试会重新结算；失败结果不会作为已确认事实使用。

安装后在新会话准备页启用；已有角色不会被重建，插件仍会初始化后续检定所需的规则（游戏中途启用时不再补问配点表单）。社区来源安装需要正常授权，重启后按框架规则重新授权。禁用后已有角色、已应用配点与回执保留。首期不含战斗、职业成长或多人主持功能。

## 开发与验证

`pnpm --filter @covel/plugin-tabletop-rules test` 运行本地单元测试（规则派生与配点校验，覆盖无属性世界的静默跳过）。

`pnpm test:tabletop-plugin` 将本目录打成 ZIP，经过真实安装、授权和运行接口验证。测试包没有工作区依赖，安装后按 community 来源加载。

`pnpm pack:tabletop-plugin` 生成 `test-results/tabletop-rules.zip` 和更换包 ID 的 `test-results/tabletop-probe.zip`。两者执行代码相同；probe 用于验证框架没有依赖官方插件 ID。重启测试会关闭并重新打开 SQLite 文件，叙事模型使用测试替身，配点和骰子结算执行真实插件代码。

中途启用后，先继续一个回合完成插件初始化；不会重建已有玩家。初始化与检定在同一回合执行时，规则通过 `inputs.rules` 传递，后续回合读取已提交的规则。初始化前点击检定会提示先完成初始化。

# turn-policy

可选的只读 `turn-policy@1` 服务，服务名为 `turn-policy`。通过本插件的“策略”设置选择 mention、list、random、manual 或 director。只有本包提供策略时自动解析；其他提供方同时启用时，在会话“编排”面板选择提供方。服务为代码专用，由对话叙事的函数规划器调用，不向模型导入原始规范请求。

- mention：从当前行动和上一段故事（含说话者）点名，按在场顺序选取，交回玩家。
- list：按“演员顺序”的准确姓名或别名逐行解析，跳过已知但不在场的人，余者按名字排序。空设置保留在场顺序。没有持久游标。
- random：在场且本次玩家行动尚未发言的角色中无放回抽样，使用服务的可复现随机源。旧故事的说话者仍可被选中。
- manual：在“选择演员”行动的 actors 字段每行输入一个准确姓名或别名，可在行动正文中附指示。最多合计 32 个名字，按提交顺序去重；未知、歧义、原始 ID 或不在场名字使整批选择无效。其他策略不解释这份名单；自动推进不重放它。
- director：函数调用借用现有文本槽、取消信号和时限，单次结构化生成只看允许的名字和公开上下文。没有 gateway 时退回 mention，并在所选演员的理由里记下原因；有 gateway 但槽或模型失败时，由规划器返回不可用状态，叙事继续。

list/random 在主持人 direct、主持人/旁观者 advance 或系统 advance 后可建议继续。普通玩家言行、mention/manual 交回玩家。空计划和零名额不调用模型或随机源。两种执行名额都限制每次批量，没有排队、重试或跨回合缓存。

策略不调用演员、不写状态、不推进执行；故事 agent 按计划顺序逐个 delegate，即使 random 建议 parallel，实际仍是串行。每位演员增加模型调用，director 再增加一次。

开发检查：`pnpm --filter @covel/plugin-turn-policy test`；`pnpm validate:plugin plugins/turn-policy`；`pnpm plugin:extract plugins/turn-policy --check`。

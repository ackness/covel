# character-agent

可选的角色演员，通过 `character-actor@1` 为指定角色产出短台词与动作。一个 runtime 可扮演不同角色，只能由其他 runtime 委托运行。使用 `plugin` 文本槽；模型覆盖配置在演员自身的 runtime 上。

框架提供规范输出 schema、所选角色的公开档案和有界亲历故事；本包不复制 schema，不读取全局历史，不声明工具或行囊写服务。没有亲历历史就没有已知的往事。当前简报可以明确带来新观察。输出的可选 intent 只供调用方本次使用，不作为故事保存。

模型失败只减少该角色的贡献，编排方应继续叙事。模型与历史边界不是服务端代码沙箱，也不保证真实模型的语义表现。

开发检查：`pnpm --filter @covel/plugin-character-agent test`。

演员用宿主生成的 `submit-output` 提交角色段落与可选的私有 `intent`，遵守宿主提供的 `character-actor@1` schema。提交不会授予世界写入权限。

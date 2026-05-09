# narrator

默认主叙事引擎，根据玩家最新行动推进互动故事。

## 运行时结构

- `PLUGIN.md`：单 agent runtime 和故事提示词。
- 使用 `story` 模型 slot。
- 可调用 `world-dimension-get` 内置工具获取精确世界事实。

## 数据与行为

- 为主聊天流生成 `outputKind: story` 文本。
- 读取玩家输入、世界观、玩家角色数据和可选 NPC 关系上下文。
- 行动建议交给 `guide`、`scene-prompts` 等下游插件。

## 开发

修改提示词或输入注入后，运行 runtime prompt parity 和 story-filter 测试。

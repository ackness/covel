# narrator

默认主叙事引擎，根据玩家最新行动推进互动故事。

## 运行时结构

- `PLUGIN.md`：单 agent runtime 和故事提示词。
- 使用 `story` 模型 slot。
- 常驻 prompt 只使用世界名称、简介和标签，不在每轮重复注入开场全文；开局由 setup 历史承接，可调用 `world-dimension-get` 按需获取精确世界事实。
- 可调用 `memory-search` 检索被压缩或已离开当前窗口的对话与长期知识。
- `advertiseEvents: true`，可调用 `emit-event` 发射当前会话已声明的领域事件。

## 数据与行为

- 为主聊天流生成 `outputKind: story` 文本。
- 读取玩家输入、世界观、玩家角色数据和可选 NPC 关系上下文。
- 行动建议交给 `guide`、`scene-prompts` 等下游插件。

## 叙事人称

`narrativePerson` 支持 `first`、`second`、`third`，默认 `second`。玩家设置覆盖世界 `pluginSettings` 中的默认值。只调整后续旁白的人称，保留人物对白和玩家自主权；第三人称使用跟随玩家角色的有限视角。

## 开发

修改提示词或输入注入后，运行 runtime prompt parity 和 story-filter 测试。

人物档案：叙事可通过 `list-characters` / `get-character` 查询当前会话内的完整角色资料，包括尚未出场的 NPC。身份和属性优先核对档案，历史记忆用于查询发生过的事件。

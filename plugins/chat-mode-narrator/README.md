# chat-mode-narrator

对话模式叙事器，重点处理角色对白、当前说话人和人物互动。

## 运行时结构

- `PLUGIN.md`：单 agent runtime 和玩家可调设置。
- 依赖 `scene-cast` 提供当前在场角色上下文。
- 可读取 `npc-graph/rag-retriever` 提供的人物关系上下文。
- `advertiseEvents: true`，可调用 `emit-event` 发射当前会话已声明的领域事件。

## 数据与行为

- 为对话模式世界生成 `outputKind: story` 的主叙事。
- 通过 manifest relations 和默认 `narrator` 互斥。
- 暴露对白占比、回复长度、活跃说话人数等玩家设置。

## 开发

修改提示词后，运行覆盖 prompt 拼装和对话模式世界策略的 runtime 测试。

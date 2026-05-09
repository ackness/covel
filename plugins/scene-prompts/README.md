# scene-prompts

为当前对话模式场景生成可直接发送的短行动句。

## 运行时结构

- `PLUGIN.md`：`chat-mode-narrator` 之后执行的 agent runtime。
- `tools/generate-scene-prompts.js`：整理场景短句。
- `ui/scene-prompts-block.json`：带短句按钮的聊天区块。

## 数据与行为

- 读取 `chat-mode-narrator.narrativeOutput`。
- 生成观察、提问、行动、社交四类短句建议。
- 面向对话模式会话。

## 开发

修改短句分类、工具输出或 UI 绑定后，运行本插件测试。

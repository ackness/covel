# guide

每段故事后给出具体的下一步行动建议，帮助玩家更快继续。

## 运行时结构

- `PLUGIN.md`：叙事后执行的 agent runtime。
- `tools/generate-guide.js`：整理分类行动建议。
- `ui/action-guide-block.json`：叙事后展示的聊天区建议块。

## 数据与行为

- 读取 `narrator.narrativeOutput`。
- 生成稳妥、激进、创意三类行动建议。
- 位于 narrator 下游，叙事缺失时跳过。

## 开发

修改建议分类、工具输出或 UI 绑定后，运行本插件测试。

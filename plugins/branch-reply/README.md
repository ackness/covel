# branch-reply

提供一组可切换的回复候选，并记录玩家最终接受的版本。

## 运行时结构

- `PLUGIN.md`：插件清单和手动函数 runtime 声明。
- `handler.js`：处理 `createCandidates` 和 `acceptCandidate` 手动载荷。
- `ui/branch-reply-block.json`：聊天区候选回复块。

## 数据与行为

- 候选集合写入 `plugin_data[branch-reply][turns]`。
- 消息块状态写入 `plugin_data[branch-reply][message]`。
- 接受候选时走 proposal 写入路径，保持和正常状态提交一致。

## 开发

修改载荷处理或 UI 绑定后，运行本插件测试。

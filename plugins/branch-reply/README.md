# branch-reply

提供一组可切换的回复候选，并记录玩家最终接受的版本。

## 运行时结构

- `PLUGIN.md`：插件清单和手动函数 runtime 声明。
- `handler.js`：处理 `createCandidates` 和 `acceptCandidate` 手动载荷。
- `ui/branch-reply-block.json`：聊天区候选回复块。

## 数据与行为

- 候选集合与消息块状态合为一条，写入 `plugin_data[branch-reply][message]`，叙事文本只存一份，不截断。
- 采纳的版本另写入 `plugin_data[branch-reply][accepted]`（每个已采纳回合一行）；提示词历史改写只读这个命名空间，重新生成候选时该行被删除。
- 旧版本写入的 `turns` 命名空间不再读取；已有开发会话的分支回复数据不会沿用。
- 接受候选时走 proposal 写入路径，保持和正常状态提交一致。
- 聊天区里每条候选是一个选项：点击即采用该版本（当前回合里也可以按数字键），「草稿」「发送」是它下方的次要动作。

## 开发

修改载荷处理或 UI 绑定后，运行本插件测试。

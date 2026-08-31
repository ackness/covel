# scene-prompts

为当前场景生成前情衔接、明确的当前决策，以及可直接发送的短行动句。

## 运行时结构

- `PLUGIN.md`：在 narrative engine 之后执行的 agent runtime。
- `tools/generate-scene-prompts.js`：原子写入摘要、决策和场景短句。
- `ui/scene-prompts-block.json`：展示摘要、决策与短句按钮的聊天区块。

## 数据与行为

- 通过 `inputs.narrative.from.capability: narrative-engine` 读取当前叙事，不绑定具体叙事器 id。
- 必需输入由 JSON Schema 校验；失败的叙事引擎不会调度本 runtime。
- 一次工具调用生成 `recap`、`decision` 和观察、提问、行动、社交四类短句建议。
- 工具通过一个 `plugin.data.batch` 写入本轮完整结果，`__turnId` 用于隔离旧轮数据。
- `requireToolUse` 防止 agent 误写续篇，`completeAfterTools` 在工具成功后直接结束，避免第二次 LLM 调用。

## 开发

修改短句分类、工具输出或 UI 绑定后，运行本插件测试。

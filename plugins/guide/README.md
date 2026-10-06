# guide

行动建议：每段故事后衔接相关前情，点明玩家眼下要回应的抉择，并给出可直接发送的短行动句。传统故事模式在聊天区展示建议块；对话 / 舞台模式额外把短句填进舞台选项栏。

## 运行时结构

- `PLUGIN.md`：在 narrative engine 之后执行的 agent runtime。
- `tools/generate-guide.js`：原子写入摘要、决策和场景短句。
- `ui/guide-block.json`：展示摘要、决策与短句按钮的聊天区块；点击短句只填入输入框，由玩家在底部发送，也可补充自己的行动。
- `server/index.js`：注册工具，并把最新一轮短句投影到 `stage.choices@1` 槽位。

## 数据与行为

- 通过 `runtime.io.inputs.narrative.from.contract: narrative-engine@1` 读取当前叙事，不绑定具体叙事器 ID；`select: /narrativeOutput` 取叙事文本。
- 必需输入由 JSON Schema 校验；失败的叙事引擎不会调度本 runtime。
- 一次工具调用生成 `scene`、`recap`、`decision` 和 3–4 条短句建议。建议从本回合正文结尾的局面出发：已经做完的事、已经回答的问题不再给出，每条通向不同的走向，至少一条会改变局面。观察、提问、行动、社交只是显示用的标签，不要求每种各出一条；模型把某条建议直接写成一句话（没有 `kind`）时照常收下，这条建议显示时不带标签。
- 工具通过一个 `plugin.data.batch` 写入本轮完整结果，`__turnId` 用于隔离旧轮数据。
- `requireToolUse` 防止 agent 误写续篇，`completeAfterTools` 在工具成功后直接结束，避免第二次 LLM 调用。

## 开发

修改短句分类、工具输出或 UI 绑定后，运行本插件测试；`pnpm test:runtime guide` 运行 `tests/runtime-cases.json` 中的 mock 用例。

## 供其他插件消费的输出

`runtime.io.output.schema` 公开当轮 `{ scene, recap, decision, prompts }` 工具结果（`prompts` 每项必有 `text`，`kind` 可缺省），`runtime.io.output.contract` 为 `scene-prompts@1`（`chat-mode-narrator` 依赖此能力）。消费者通过自己的 `runtime.io.inputs.<name>.from.contract: scene-prompts@1` 和 `accepts` schema，在当前执行中读取结果与来源，无须读取本插件内部数据。示例为 [Jev 选项推荐 Demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo)。

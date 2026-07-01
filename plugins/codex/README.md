# codex

维护会话中的知识图鉴，记录新发现的地点、人物、物品、势力、传闻和设定。

## 运行时结构

- `PLUGIN.md`：叙事后执行的 agent runtime。
- `tools/unlock-codex-entries.js`：创建新图鉴条目。
- `tools/update-codex-entry.js`：补充已有图鉴条目。
- `ui/codex-panel.json`：右侧完整图鉴面板。

聊天区的"本轮发现"卡片由 `unlock-codex-entries` 工具的 `ui` 字段经 `ui.render` 渲染（不再使用单独的 `ui.message` spec）。

## 数据与行为

- 读取最新叙事和已有条目摘要。
- 图鉴条目写入 `plugin_data[codex][entries]`。
- 没有明确新发现时跳过写入。

## 开发

修改发现规则、工具 schema 或 UI spec 后，运行本包测试。

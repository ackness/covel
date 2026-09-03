# codex

维护会话中的知识图鉴，记录新发现的地点、人物、物品、势力、传闻和设定。

## 运行时结构

- `PLUGIN.md`：叙事后执行的 agent runtime。
- `tools/sync-codex-entries.js`：一次提交本轮全部新条目和已有条目补充。
- `tools/unlock-codex-entries.js`、`tools/update-codex-entry.js`：由同步工具复用的底层写入实现。
- `ui/codex-panel.json`：右侧完整图鉴面板。

聊天区的"本轮发现"卡片由 `sync-codex-entries` 汇总的 `ui` 字段经 `ui.render` 渲染（不再使用单独的 `ui.message` spec）。

## 数据与行为

- 读取最新叙事和已有条目摘要。
- 图鉴条目写入 `plugin_data[codex][entries]`。
- 没有明确新发现时跳过写入。

## 开发

修改发现规则、工具 schema 或 UI spec 后，运行本包测试。

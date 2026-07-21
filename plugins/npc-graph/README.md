# npc-graph

构建和检索会话级人物关系图，覆盖角色、团体和势力。

## 运行时结构

- `PLUGIN.md`：关系图子系统的包级摘要。
- `runtimes/rag-retriever/`：叙事前检索相关图谱上下文的函数 runtime。
- `runtimes/extractor/`：叙事后抽取关系事实的 agent runtime。
- `tools/`：图谱写入和查询工具。
- `ui/npc-graph-panel.json`：右侧关系图面板。

## 数据与行为

- 图谱节点、边、索引和元信息写入 plugin data。
- 边是带有效区间的版本化事实：同一 `(source, target, relation)` 至多有一个开放版本（`invalidAt === undefined`）。强度或事实变化时关闭旧版本、开启新版本；完全相同的提交是空操作。`validAt` / `invalidAt` 记录真实逻辑回合数。
- 检索只注入仍然开放的边，被取代的旧版本留库溯源。
- 将压缩后的人物关系上下文注入 narrator 提示词。
- 每段新叙事后，从 narrator 输出中更新图谱。

## 开发

修改图谱 schema、检索行为、抽取提示词或 UI spec 后，运行本包测试。

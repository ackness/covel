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
- 将压缩后的人物关系上下文注入 narrator 提示词。
- 每段新叙事后，从 narrator 输出中更新图谱。

## 开发

修改图谱 schema、检索行为、抽取提示词或 UI spec 后，运行本包测试。

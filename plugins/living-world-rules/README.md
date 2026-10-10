# living-world-rules

长期生效的世界规则（风俗、禁忌、法律、特殊设定约束）。**规则由世界作者写在世界包里**（`data/rules/*.yaml` 经 world-data 导入到 `rules` + lorebook），玩家面板是**只读展示**——app 是给玩家的，扩充世界走世界文档，不在 UI 里编辑。插件没有 runtime，游玩中没有新增或修改规则的入口。

## 运行时结构

- `PLUGIN.md`：`world.rules@1` 数据契约、WorldIR projection 和右侧面板声明。
- `server/project-world-ir.js`：把 `contract:world-ir@1` 中 `type: rule` 的 statements 纯转换为 `rules` 记录。
- `schemas/rules.schema.json`：世界规则导入 schema。
- `ui/living-world-rules-panel.json`：右侧规则列表面板。

## 数据与行为

- 世界包导入的规则写入 `plugin_data[living-world-rules][rules]`；数据源带 `lorebook: true` 时同时成为世界书条目，让规则影响后续提示词。
- 规则的 `coordinate` 控制它进入提示词的位置。
- WorldIR projection 只负责生成并校验 plugin-data；需要同时创建 lorebook 的 world 包应使用 `schema: contract:world.rules@1`、`to: contract:world.rules@1+lorebook` 导入。projection output effects 会在后续独立扩展，不在纯转换 handler 中隐式执行。
- WorldIR `type: rule` 的导入键统一为 `world-ir-<sha256(statement.id)>`，原始 ID 保存在 `sourceStatementId`。这允许 Unicode 和超长 statement ID 通过规则 ID 校验；使用旧投影键的开发数据需重新导入。

## 开发

修改 WorldIR 投影或 schema 字段后，运行本插件测试。

# living-world-rules

长期生效的世界规则（风俗、禁忌、法律、特殊设定约束）。**规则由世界作者写在世界包里**（`data/rules/*.yaml` 经 world-data 导入到 `rules` + lorebook），玩家面板是**只读展示**——app 是给玩家的，扩充世界走世界文档，不在 UI 里编辑。`handler.js` 的写入路径保留供 world-data 导入与程序化调用，玩家界面不再有编辑表单。

## 运行时结构

- `PLUGIN.md`：手动函数 runtime、world-data schema 和 WorldIR projection 声明。
- `handler.js`：校验规则、保存规则，并发出 lorebook proposal。
- `server/project-world-ir.js`：把 `covel://world/ir/v1` 中 `type: rule` 的 statements 纯转换为 `rules` 记录。
- `schemas/rules.schema.json`：世界规则导入 schema。
- `ui/living-world-rules-panel.json`：右侧规则列表面板。

## 数据与行为

- 归一化规则写入 `plugin_data[living-world-rules][rules]`。
- 发出 `lorebook.upsert` proposal，让规则影响后续提示词。
- 通过 rule coordinate 控制规则进入提示词的位置。
- WorldIR projection 只负责生成并校验 plugin-data；需要同时创建 lorebook 的 world 包仍应使用 `to: plugin:living-world-rules/rules+lorebook` 直接导入。projection output effects 会在后续独立扩展，不在纯转换 handler 中隐式执行。

## 开发

修改规则归一化、lorebook 投影或 schema 字段后，运行本插件测试。

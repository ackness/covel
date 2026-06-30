# living-world-rules

长期生效的世界规则（风俗、禁忌、法律、特殊设定约束）。**规则由世界作者写在世界包里**（`data/rules/*.yaml` 经 world-data 导入到 `rules` + lorebook），玩家面板是**只读展示**——app 是给玩家的，扩充世界走世界文档，不在 UI 里编辑。`handler.js` 的写入路径保留供 world-data 导入与程序化调用，玩家界面不再有编辑表单。

## 运行时结构

- `PLUGIN.md`：手动函数 runtime 和 world-data schema 声明。
- `handler.js`：校验规则、保存规则，并发出 lorebook proposal。
- `schemas/rules.schema.json`：世界规则导入 schema。
- `ui/living-world-rules-panel.json`：右侧规则列表面板。

## 数据与行为

- 归一化规则写入 `plugin_data[living-world-rules][rules]`。
- 发出 `lorebook.upsert` proposal，让规则影响后续提示词。
- 通过 rule coordinate 控制规则进入提示词的位置。

## 开发

修改规则归一化、lorebook 投影或 schema 字段后，运行本插件测试。

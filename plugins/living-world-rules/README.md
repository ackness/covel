# living-world-rules

保存长期生效的世界规则，例如风俗、禁忌、法律和特殊设定约束。

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

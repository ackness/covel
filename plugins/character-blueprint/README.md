# character-blueprint

保存可复用的人物蓝图，并可将蓝图实例化为当前会话中的具体角色。

## 运行时结构

- `PLUGIN.md`：手动函数 runtime 声明和数据 schema 元信息。
- `handler.js`：导入、校验、保存蓝图，并可选择实例化角色。
- `schemas/`：蓝图导入使用的 world-data schema。
- `ui/blueprints-panel.json`：右侧蓝图列表面板。

## 数据与行为

- 源记录写入 `plugin_data[character-blueprint][blueprints]`。
- 蓝图需要变成场内角色时，发出 `character.upsert` proposal。
- 支持世界包导入预设角色阵容。

## 开发

修改 schema、handler 归一化逻辑或面板绑定后，运行本插件测试。

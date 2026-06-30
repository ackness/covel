# character-blueprint

可复用的人物蓝图，实例化为会话中的具体角色。**登场角色由世界作者写在世界包里**（如 `characters/main-cast.json` 经 world-data 导入到 `blueprints`），玩家面板是**只读展示**——app 是给玩家的，扩充世界走世界文档，不在 UI 里编辑。`handler.js` 的导入/实例化路径保留供 world-data 与程序化调用，玩家界面不再有角色卡编辑表单。

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

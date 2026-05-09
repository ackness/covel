# character-presence

为角色关联头像、立绘、声音和其他媒体引用。

## 运行时结构

- `PLUGIN.md`：手动函数 runtime 声明和导入 schema。
- `handler.js`：归一化角色媒体载荷，并写入 plugin data。
- `schemas/`：角色媒体和资产索引导入 schema。
- `ui/character-presence-panel.json`：右侧角色媒体面板。

## 数据与行为

- 归一化后的角色媒体记录写入 `plugin_data[character-presence][presence]`。
- 导入的媒体索引写入 `plugin_data[character-presence][assets]`。
- 媒体用 asset id、mime type 和 size 引用；二进制数据仍保存在 media store。

## 开发

修改媒体引用、schema 校验或 UI 数据路径后，运行本插件测试。

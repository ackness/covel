# character-blueprint

角色资料：世界预设的人物蓝图，以及他们的头像、立绘、声音和其他媒体引用。**登场角色由世界作者写在世界包里**（如 `characters/main-cast.json` 经 world-data 导入到 `blueprints`，立绘经 `presence.json` 导入到 `presence`），玩家面板是**只读展示**——app 是给玩家的，扩充世界走世界文档，不在 UI 里编辑。两个 runtime 的导入路径保留供 world-data 与程序化调用；玩家界面只保留替换立绘的上传入口。

## 运行时结构

- `PLUGIN.md`：插件级元信息、数据 schema 与 `character.visual@1` 槽位声明，本身不是可执行 runtime。
- `runtimes/import/`：手动函数 runtime，导入、校验、保存蓝图，并可选择实例化角色。
- `runtimes/presence/`：手动函数 runtime，归一化角色媒体载荷并写入 plugin data；立绘面板的替换操作也走它。
- `server/index.js`：`character.visual@1` 槽位投影，把 `presence` 记录映射到会话角色 ID 供舞台立绘使用。
- `schemas/`：蓝图、角色媒体和资产索引的 world-data schema。
- `ui/blueprints-panel.json`：预设角色面板，与 `char-creator` 的角色面板同属 `character` 分组。
- `ui/character-presence-panel.json`：角色立绘面板（`character-art` 分组），可上传替换立绘。

## 数据与行为

- 蓝图源记录写入 `plugin_data[character-blueprint][blueprints]`；蓝图需要变成场内角色时，发出 `character.upsert` proposal。
- 归一化后的角色媒体记录写入 `plugin_data[character-blueprint][presence]`，导入的媒体索引写入 `plugin_data[character-blueprint][assets]`。
- 媒体用 asset id、mime type 和 size 引用；二进制数据仍保存在 media store。
- 对外提供 `character-blueprint@1` 与 `character-presence@1` 两个能力，`chat-mode-narrator` 依赖二者。

## 开发

修改 schema、handler 归一化逻辑、媒体引用或面板绑定后，运行本插件测试。

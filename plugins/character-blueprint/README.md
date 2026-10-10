# character-blueprint

角色资料：世界预设的人物蓝图，以及他们的头像、立绘、声音和其他媒体引用。**登场角色由世界作者写在世界包里**（如 `characters/main-cast.json` 经 world-data 导入到 `blueprints`，立绘经 `presence.json` 导入到 `presence`），玩家面板是**只读展示**——app 是给玩家的，扩充世界走世界文档，不在 UI 里编辑。两个 runtime 的导入路径保留供 world-data 与程序化调用；玩家界面只保留替换立绘的上传入口。

## 运行时结构

- `PLUGIN.md`：插件级元信息、数据 schema 与 `character.visual@1` 槽位声明，本身不是可执行 runtime。
- `runtimes/import/`：手动函数 runtime，导入、校验、保存蓝图，并可选择实例化角色。
- `runtimes/presence/`：手动函数 runtime，归一化角色媒体载荷并写入 plugin data；立绘面板的替换操作也走它。
- `server/index.js`：`character.visual@1` 槽位投影，把 `presence` 记录映射到会话角色 ID 供舞台立绘使用。
- `lib/roleplay-notes.js`：`prompt.segment@1` 提供者的正文，把角色卡的扮演说明写成给叙事的 `<character-notes>` 段。
- `schemas/`：蓝图、角色媒体和资产索引的 world-data schema。
- `ui/blueprints-panel.json`：预设角色面板，与 `char-creator` 的角色面板同属 `character` 分组。
- `ui/character-presence-panel.json`：角色立绘面板（`character-art` 分组），可上传替换立绘。

## 数据与行为

- 蓝图源记录写入 `plugin_data[character-blueprint][blueprints]`；蓝图需要变成场内角色时，发出 `character.upsert` proposal。
- 归一化后的角色媒体记录写入 `plugin_data[character-blueprint][presence]`，导入的媒体索引写入 `plugin_data[character-blueprint][assets]`。
- 媒体用 asset id、mime type 和 size 引用；二进制数据仍保存在 media store。
- 对外提供 `character-blueprint@1` 与 `character-presence@1` 两个能力，`chat-mode-narrator` 依赖二者。

## 角色卡怎样进入叙事

角色卡里写给扮演用的内容会进入所有故事 runtime 的系统提示词（`<character-notes>` 段，受众 `story`，会话内稳定，落在可缓存的前缀里）。不需要叙事插件做任何绑定。

- **哪些卡**：卡的 `id` 等于会话角色的 ID，或会话角色 ID 是 `npc-<id>`。角色不在会话里的卡不写；玩家角色的卡不写。
- **哪些字段**：`persona.voice`（口吻）、`persona.style`（举止）、`persona.summary`、`traits` / `goals` / `fears` / `secrets`（每项最多 4 条）、`scenarioDefaults.relationships`、`scenarioDefaults.state`、`rules`（按 `priority` 从高到低最多 3 条）、`dialogueExamples`（最多 2 条）。`attributes`、`aliases`、`tags`、`scenarioDefaults.opening` / `location`、`media` 不写：属性是领域角色的字段，叙事已经有了。
- **秘密**：标成“只有你知道”，要求叙事在故事揭开之前不直接说出来。
- **状态开关**：`scenarioDefaults.state` 作为“开场状态”原样列出，并告诉模型这些值没有保存在任何地方，要根据已发生的故事判断。它们不会变成角色字段，也没有工具能改；需要可持久修改的状态时，把它声明成 `characterSchema` 属性并写进领域角色的 `fields`。
- **长度**：每行最多 300 字符；整段预算约 6000 token（按 CJK 每字 1 token、其余每 4 字符 1 token 估算）。超出时所有卡一起降一档：先减示例台词，再减规则，再去掉关系和开场状态，最后只留口吻、举止和秘密；仍放不下时按卡 ID 顺序写到预算为止，其余角色只列名字。口吻一行不会被去掉。
- **语言**：卡的正文是会话语言的那一份（世界数据导入时已合并语言文件）；段里的固定文字在简体中文会话是中文，其余是英文。

`secrets` 和规则保存在公开的 `blueprints` 命名空间里：本插件的面板不显示它们，但右侧“数据库”页签会原样显示所有公开的插件数据。

## 开发

修改 schema、handler 归一化逻辑、媒体引用或面板绑定后，运行本插件测试。

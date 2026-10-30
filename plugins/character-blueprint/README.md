# character-blueprint

角色资料：世界角色的扮演说明，以及他们的头像、立绘、声音和其他媒体引用。**扮演说明由世界作者写在角色记录里**：`characters/characters.json` 里每个角色可以带一个 `blueprint` 字段，导入时内核按角色 `id` 把它写进 `blueprints`；立绘经 `presence.json` 导入到 `presence`。游玩中没有新增或修改扮演说明的入口；玩家界面只保留替换立绘的上传入口。

## 运行时结构

- `PLUGIN.md`：插件级元信息、数据 schema 与 `character.visual@1` 槽位声明，本身不是可执行 runtime。
- `runtimes/presence/`：手动函数 runtime，归一化角色媒体载荷并写入 plugin data；立绘面板的替换操作也走它。
- `server/index.js`：`character.visual@1` 槽位投影，把 `presence` 记录按角色 ID 映射给舞台立绘。
- `lib/roleplay-notes.js`：`prompt.segment@1` 提供者的正文，把扮演说明写成给叙事的 `<character-notes>` 段。
- `schemas/`：扮演说明、角色媒体和资产索引的 world-data schema。
- `ui/character-presence-panel.json`：角色立绘面板（`character-art` 分组），可上传替换立绘。扮演说明没有自己的面板：角色由角色列表显示，说明是写给叙事的。

## 数据与行为

- 扮演说明写在世界的角色记录里（`authoring.characterField: blueprint`），导入后存进 `plugin_data[character-blueprint][blueprints]`，键是角色 ID。角色记录由内核导入，插件不创建角色；没有这个插件的世界照样从角色文件得到角色。
- 说明不重复角色记录已有的内容：名字、别名、说明、类型和属性都在记录里。
- 归一化后的角色媒体记录写入 `plugin_data[character-blueprint][presence]`，导入的媒体索引写入 `plugin_data[character-blueprint][assets]`。`presence` 的 `characterId` 就是角色 ID。
- 媒体用 asset id、mime type 和 size 引用；二进制数据仍保存在 media store。
- 对外提供 `character-blueprint@1` 与 `character-presence@1` 两个契约。

## 角色卡怎样进入叙事

扮演说明会进入所有故事 runtime 的系统提示词（`<character-notes>` 段，受众 `story`，会话内稳定，落在可缓存的前缀里）。不需要叙事插件做任何绑定。

- **哪些说明**：键等于会话里某个角色 ID 的说明。角色不在会话里的不写；玩家角色的不写。
- **哪些字段**：`persona.voice`（口吻）、`persona.style`（举止）、`persona.summary`、`traits` / `goals` / `fears` / `secrets`（每项最多 4 条）、`scenarioDefaults.relationships`、`scenarioDefaults.state`、`rules`（按 `priority` 从高到低最多 3 条）、`dialogueExamples`（最多 2 条）。`tags`、`scenarioDefaults` 的其他字段不写。
- **关系**：`scenarioDefaults.relationships` 的键是 `player`、某个角色的 ID 或某个维度条目的 ID；段里写成名字。
- **秘密**：标成“只有你知道”，要求叙事在故事揭开之前不直接说出来。
- **状态开关**：`scenarioDefaults.state` 作为“开场状态”原样列出，并告诉模型这些值没有保存在任何地方，要根据已发生的故事判断。它们不会变成角色字段，也没有工具能改；需要可持久修改的状态时，把它声明成 `characterSchema` 属性并写进角色的 `fields`。
- **长度**：每行最多 300 字符；整段预算约 6000 token（按 CJK 每字 1 token、其余每 4 字符 1 token 估算）。超出时所有说明一起降一档：先减示例台词，再减规则，再去掉关系和开场状态，最后只留口吻、举止和秘密；仍放不下时按角色 ID 顺序写到预算为止，其余角色只列名字。口吻一行不会被去掉。
- **语言**：说明的正文是会话语言的那一份（角色文件的语言文件在导入时已合并）；段里的固定文字在简体中文会话是中文，其余是英文。

`secrets` 和规则保存在公开的 `blueprints` 命名空间里：本插件没有显示它们的面板，但开启开发者视图后的“数据库”页签和调试页会原样显示公开的插件数据。

## 开发

修改 schema、handler 归一化逻辑、媒体引用或面板绑定后，运行本插件测试。

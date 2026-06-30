# player-identity

UI-less persona-provider：把一份玩家口吻/persona 写入会话并注入主叙事。

> **原则:口吻(说话方式/目标/边界)属于角色卡,在创建角色时设定,不在游玩中编辑。** 因此本插件**没有玩家面板**——它不是给玩家在 UI 里现编 persona 的工具(那违反"app 是给玩家的、扩充内容走文档")。`handler.js` 仅供程序化/未来的"在创建时把口吻写进玩家角色卡"使用。没有 persona 时,主叙事优雅降级到 `{{ player.character }}`(角色卡本身)。

## 运行时结构

- `PLUGIN.md`：手动函数 runtime 声明（无 `ui`）。
- `handler.js`：保存 persona、激活绑定，并按需更新玩家角色（程序化调用）。

## 数据与行为

- 身份资料写入 `plugin_data[player-identity][profiles]`。
- 当前会话绑定写入 `plugin_data[player-identity][session-binding]`。
- 可为会话玩家发出 `character.upsert`，同时保留既有字段。

## 开发

修改资料归一化、绑定行为或面板字段后，运行本插件测试。

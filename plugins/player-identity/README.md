# player-identity

让玩家在游玩中调整主角口吻、目标和行事边界。

## 运行时结构

- `PLUGIN.md`：手动函数 runtime 声明。
- `handler.js`：保存身份资料、激活绑定，并按需更新玩家角色。
- `ui/player-identity-panel.json`：右侧身份资料编辑面板。

## 数据与行为

- 身份资料写入 `plugin_data[player-identity][profiles]`。
- 当前会话绑定写入 `plugin_data[player-identity][session-binding]`。
- 可为会话玩家发出 `character.upsert`，同时保留既有字段。

## 开发

修改资料归一化、绑定行为或面板字段后，运行本插件测试。

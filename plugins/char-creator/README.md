# char-creator

在开局创建玩家角色，并在故事推进中持续维护重要角色记录。

## 运行时结构

- `PLUGIN.md`：角色子系统的包级摘要。
- `runtimes/player-init/`：开局角色创建流程。
- `runtimes/character-tracker/`：叙事后发现和更新角色的 agent runtime。
- `ui/character-panel.json`：共享的右侧角色面板。

## 数据与行为

- 通过 character store 写入玩家和 NPC 记录。
- 将面板需要的数据镜像到 plugin data。
- 世界 schema 存在时，用它生成贴合当前世界的角色表单字段。

## 开发

修改表单生成、角色写入或跟踪提示词后，运行本包测试。

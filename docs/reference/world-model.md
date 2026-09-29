# World Model

World Model 是内核维护的会话领域记录：世界、角色 schema 和角色。插件的 `ctx.world.worldRecord`、`ctx.world.characterSchema`、`ctx.world.characters` 是只读执行视图；同一 execution 的合法上游 proposal 和本 runtime 已缓冲的 proposal 对后续读取可见。插件自有持久数据仍归本插件 namespace，不能把别的插件的私有数据当成 World Model。运行时字段及读写边界见[插件契约](plugins.md#world-model-与数据边界)。

世界包可在 `world.yaml` 声明 `characterSchema`，会话创建时写入领域 schema。它包含 `types` 和 `attributes`；`player` 是保留类型，每会话至多一个，其他角色类型由 schema 声明。`character.schema.set` proposal 的 payload 为 `{types, attributes}`，版本由内核递增。角色 `fields` 按当前 schema 校验。世界文件、角色初值和导入示例见[世界数据](world-data.md#世界角色-schema)与[领域角色](world-data.md#领域角色与插件角色卡)。

角色创建与更新走领域 proposal 和工具；角色面板从会话 `session.characters` 读取，角色字段组件从会话 `characterSchema` 读取。插件角色卡可以保留自己的原始蓝图，但不将领域角色镜像到插件 namespace。世界上下文的可扩展部分由 `session.world-context@1` 提供者处理，见[扩展点](extension-points.md)。

Lorebook 使用 `(sessionId, owner, id)` 作为身份，`owner` 可为 world、player 或 plugin。世界导入条目属 world；玩家编辑 API 固定处理 player；插件 `lorebook.upsert` 的归属由 proposal 来源绑定，插件不能覆盖其他 owner 的同 ID 条目。管理 API 和导入目标分别见[Lorebook API](api.md#lorebook)与[世界数据目标](world-data.md#target-uri)。旧数据库中只有 `plugin_id` 的 Lorebook 表不自动升级；开发环境操作见[迁移说明](../guide/env-registry.md#plugin-extension-development-data)。

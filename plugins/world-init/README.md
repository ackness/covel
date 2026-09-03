# world-init

在会话开始时准备当前世界的 schema 和世界词条。

## 运行时结构

- `PLUGIN.md`：世界准备子系统的包级摘要。
- `guard.js`：已有世界数据足够时跳过准备流程。
- `runtimes/schema-gen/`：通过一次结构化调用派生 schema 和世界词条的 agent runtime。
- `tools/initialize-world.js`：原子提交 schema、世界词条和 lorebook 数据。
- `tools/set-world-schema.js`、`tools/set-world-entries-batch.js`：由原子工具复用的底层写入实现。

## 数据与行为

- 同一工具结果携带全部写入 proposal，任一部分失败时不会产生部分提交。
- 将角色 / 世界 schema 写入 plugin data；将世界词条写入 lorebook，并兼容写入旧 plugin data。
- 提供会话上下文加载使用的 `world-data-provider` 能力。

## 开发

修改准备 guard、工具或 schema 生成提示词后，运行 `plugins/world-init` 测试和 runtime pre-game 测试。

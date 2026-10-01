# world-init

准备当前世界的角色属性结构与自定义维度，并在会话中持续维护维度当前值。

## 运行时结构

- `PLUGIN.md`：包级摘要（`world.dimensions@1` 契约、工具与扩展点）。
- `guard.js`：已有世界数据足够时跳过初始化（setup 幂等，不重置已演化值）。
- `runtimes/schema-gen/`：开局一次性派生角色属性结构与维度定义的 agent runtime。
- `runtimes/dimension-context/`：只读 pre-turn runtime，发布冻结的公共维度快照。
- `runtimes/dimension-tracker/`：post-turn runtime，按作者 `updateRule` 结算维度演化（有非空规则才激活）。
- `runtimes/edit-dimensions/`：manual runtime，承接玩家编辑与人工/跳过结算，仍提交 `dimension.update`。
- `tools/`：`initialize-world`（原子初始化 schema+维度）、`set-world-schema`、`set-world-dimensions`、`update-dimensions`（tracker 提交）、`dimension-rule-get`（provider 内读规则/Schema）。

## 数据与行为

- 维度声明来自世界包（开放自定义 ID，`{name, description?, schema, initialValue, updateRule?}`）；当前值保存在受保护的 `_dimensions` namespace，会话级、版本化，经 `dimension.initialize`/`dimension.update` proposal + 批量 CAS 写入，冲突不覆盖。
- 结算回执（pending-settlement/settled/no-change/manual/skipped）持久化在 `_dimension-settlements`；失败不冒充无变化，未结算义务会阻止下一次依赖叙事。
- `session.world-context@1` 发布公共维度快照；`prompt.segment@1` 发布预算投影与规则提示；`world-dimension-get`/`world-dimension-list` 是框架内建只读查询，任意插件可读当前值（不含 updateRule/initialValue）。
- 提供会话上下文加载使用的 `world-data-provider` 能力；作者声明与世界包初值不回写、不被运行时覆盖。

## 开发

修改 guard、工具、维度契约或 runtime 提示词后，运行 `plugins/world-init` 测试与 runtime pre-game / dimension 相关测试。

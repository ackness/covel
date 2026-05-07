# 当前状态与可复用点

本文只记录和 world data filesystem v1 直接相关的现状。

## 现有世界包入口

`world.yaml` schema 位于：

- `packages/shared/src/schemas/world.ts`

当前 `worldManifestSchema` 是 `.strict()`，所以新增字段必须显式加入 schema 和类型。

现有字段中和 world data 相关的是：

- `dimensions`
- `dimensionSources`
- `characterBlueprintSources`
- `requiredPlugins`
- `recommendedPlugins`
- `excludedPlugins`

加载入口：

- `apps/server/src/world-seed-loader.ts`

当前 loader 已经支持：

- 读取 `world.yaml`
- 读取 `WORLD.<lang>.md` / `WORLD.md`
- 读取外部 dimension YAML
- 读取 character blueprint JSON
- 合并 inline dimensions 和 external dimensions
- 把结果写入 `WorldRecord.metadata`

## 可复用能力

### 路径限制

`world-seed-loader.ts` 有 `resolveSafePath(worldDir, relativePath)`，可以挡住普通 `../` 逃逸。

v1 需要升级它：

- path 统一相对 world root。
- 使用 `realpath` containment。
- 处理或拒绝 symlink。
- 对所有 source/schema/media/override 统一使用。

### Locale resolution

现有 `resolveLocaleDimensionPath()` 支持：

```text
foo.zh.yaml -> foo.yaml
```

v1 可以保留这个能力，但应限制在声明 `locale` 或需要 locale fallback 的 source 上，不要让所有 source 都隐式寻找 locale 文件。

### Schema 校验

当前 world dimensions 使用 Zod schema 校验：

- `validateWorldManifest`
- `validateDimensionData`
- `DIMENSION_KEY_SCHEMAS`

v1 可以继续内部使用 Zod，但 world/plugin 公开契约建议统一为 JSON Schema URI：

- `covel://...`
- `plugin://...`
- `schemas/*.schema.json`

## 现有 session 导入点

`apps/server/src/routes/api/session.ts` 创建 session 的顺序是：

```text
createSession
-> importWorldCharacterBlueprints
-> activate plugins
```

这和 v1 目标一致：世界数据应在插件激活前导入，这样 Pre-Game runtime 可以读取。

当前 `importWorldCharacterBlueprints()` 是专用逻辑，并硬编码了部分插件 ID。v1 importer 应逐步替代这条专用路径，改成通用 import plan + effects。

## 现有目标 store

v1 不新增核心存储目标，只投影到现有结构。

| 目标           | 现有结构               |
| -------------- | ---------------------- |
| world metadata | `WorldRecord.metadata` |
| plugin data    | `PluginDataRecord`     |
| lorebook       | `LorebookEntryRecord`  |
| characters     | `CharacterRecord`      |
| media          | `MediaStore`           |

## 现有 world-init 模式

`plugins/world-init/guard.js` 已经会在发现 `world.metadata.dimensions` 后跳过 LLM，并把维度写入插件数据 / lorebook。

这说明：

- 预置结构化世界数据能显著减少 LLM 初始化成本。
- `plugin-data + lorebook` 的双写模式已有实践。
- v1 可以把这种双写规范成 target URI：`plugin:<pluginId>/<namespace>+lorebook`。

注意：框架 importer 不能因此硬编码 `world-init`。插件 ID 只能来自 world data 或插件 capability/schema registry。

## 现有媒体模型

MediaStore 是内容寻址存储，`MediaRef.id` 是 SHA-256。它支持：

- `put()`
- `lookup()`
- `recordOwnership()`
- `addRef()`
- `isReferencedBy()`

当前访问权限是 session-scoped。world load 阶段没有 sessionId，所以 v1 media source 应在 world load 阶段只生成摘要，在 session 创建阶段再 `put` 和 `addRef`。

## 主要缺口

1. `dimensionSources` 和 `characterBlueprintSources` 是两个专用入口，缺少统一 source descriptor。
2. 插件可接收的数据 schema 分散在 handler、类型和 UI 中，缺少公开 `dataSchemas`。
3. session 导入逻辑硬编码插件 ID，不符合长期的 framework-plugin isolation。
4. media 的 world-level 描述和 session-level 授权尚未打通。
5. 没有 import provenance，后续 sync 无法判断哪些数据被玩家或插件改过。
6. 当前路径安全还缺 realpath/symlink 防护。

## v1 设计对现状的最小改动

- 给 `world.yaml` 加 `worldData` 字段。
- 新增 `world.data.yaml` source descriptor。
- 新增通用 `WorldDataImporter`。
- 新增 plugin-level `dataSchemas` registry。
- 新增 import ledger 或等价 provenance 机制。
- 保留旧字段并映射到新 importer。

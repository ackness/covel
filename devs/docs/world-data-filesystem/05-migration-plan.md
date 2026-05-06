# 迁移与落地计划

目标是先落地一个小而稳的 v1，而不是一次性实现所有数据格式。

## Phase 1：收敛规范

文档和 schema 先达成一致：

- `world.yaml` 新增 `worldData?: string`。
- `data/world.data.yaml` 使用 map 形式的 `sources`。
- world 包 path 相对 world root；用户 override path 相对对应 override root。
- v1 source kind 只包含：`yaml`、`json`、`markdown`、`text`、`media`。
- v1 target 使用固定单字符串 URI：`world:metadata.*`、`plugin:*/*`、`plugin:*/*+lorebook`、`lorebook`、`characters`、`media`。
- sources 默认按 YAML 声明顺序执行，少量依赖用 `after`。
- override 只允许 descriptor-level source 覆盖，并默认存放在 `~/.covel/world-overrides/<world-id>/`。
- SQLite、remote、CUE、RO-Crate 暂不实现。

测试锚点：

- `worldManifestSchema` 接受 `worldData`。
- `world.data.yaml` schema 能校验合法/非法 source。
- `after` 排序稳定，循环依赖报错。
- `to` URI 只接受 v1 固定格式。
- 旧 `dimensionSources`、`characterBlueprintSources` 可以转换成等价 source summary。

## Phase 2：本地 source loader

实现只读 loader，不写 session 数据。

职责：

1. 读取 `world.yaml`。
2. 读取 `worldData` 指向的文件。
3. 查找 `~/.covel/world-overrides/<world-id>/world.data.override.yaml`。
4. 应用 descriptor override。
5. 校验 source descriptor。
6. 安全读取本地 YAML/JSON/Markdown/Text。
7. 按声明顺序和 `after` 生成稳定 source 顺序。
8. 扫描 media 摘要。
9. 生成 diagnostics 和 `WorldDataMetadataSummary`。
10. 写入 `WorldRecord.metadata.worldData` 的轻量索引。

不在本阶段做：

- 不写 plugin_data。
- 不写 characters。
- 不 put media bytes。
- 不做 sync。

测试锚点：

- path traversal 被拒绝。
- symlink 逃逸被拒绝。
- 文件大小超限报 diagnostic。
- YAML/JSON schema 错误定位到 source。
- media 目录稳定排序。
- 用户 override path 只能留在对应 override root 内。
- `WorldRecord.metadata.worldData` 只包含 source id、digest、target、schema、importedAt、order、origin/overridden、diagnostics count。

## Phase 3：session import

在创建 session 时重建并应用完整 import plan。

流程：

```text
compute final plugin set
rebuild full import plan from descriptors/sources
preflight target plugins, dataSchemas, duplicate keys, media MIME/size/digest
MediaStore.put() for imported media
begin transaction
  create session
  write plugin_data / lorebook / characters / media indexes
  write import ledger per committed row
commit
MediaStore.addRef() for current session
activate plugins
```

关键要求：

- importer 不能硬编码玩法插件 ID。
- `plugin:*` 和 `indexTo` 目标必须要求目标插件声明 `dataSchemas.acceptsWorldData`。
- 所有 session store 写入记录写 provenance ledger；world metadata summary 用 digest/origin/overridden 表达 provenance。
- 有 error diagnostic 时默认阻止 session 创建。

测试锚点：

- 未安装插件导致 source skipped/error。
- 插件未被 session 选中导致 source skipped/error。
- namespace 未声明 `acceptsWorldData` 导致 source rejected。
- DataStore 写入失败时 transaction rollback。
- media addRef 后 session 可访问 media-token。
- addRef 失败时补偿删除刚创建的 session，且不激活插件。
- `indexTo` 未声明 dataSchemas 时被拒绝。

## Phase 4：兼容旧入口

把旧字段映射或兼容到新体系：

- `dimensions` / `dimensionSources` → `world:metadata.dimensions`
- `characterBlueprintSources` → 没有 `worldData` 的旧世界继续走 transitional legacy shim；声明了 `worldData` 的世界必须使用新 source + 通用 `effects: [characters]`

目标：旧世界包行为不变；新 worldData 世界不再通过旧 hardcoded shim 写 plugin-data。

测试锚点：

- 旧世界包能加载。
- 旧 character blueprint 导入结果与现状兼容。
- world-init guard 能继续读到 dimensions。

## Phase 5：插件 dataSchemas

插件逐步声明可导入 namespace。v1 先把声明放在 `PLUGIN.md` frontmatter，由 loader 合并成 plugin-level registry；后续如引入 plugin package manifest，可迁移到包级文件。

优先插件：

- `character-blueprint`
- `character-presence`
- `living-world-rules`
- `scene-prompts`
- `branch-reply`

要求：

- schema path 相对 plugin root。
- 多 runtime 插件合并为 plugin-level registry。
- 同 namespace 冲突时报错。
- handler 测试覆盖“importer 接受的数据，handler 也接受”。

## Phase 6：预检 UI 与同步

新增开始游戏前的 world data 预检：

- source 数量。
- 将写入的目标。
- 缺失插件。
- schema 错误。
- media 数量和大小。
- override 来源（来自 metadata summary 的 `origin` / `overridden`）。

后续再增加 `/worlds/:id/sync-data`。sync 必须基于 provenance ledger，只覆盖 importer 管理且未被玩家/插件改动的数据。

## Documentation sync checklist

实现对应代码时，必须同步更新权威文档：

- `world.yaml worldData` / world 包格式：更新 `devs/docs/world-package-spec.md` 和 `docs/reference/plugins.md` 的 world 字段说明。
- `PLUGIN.md dataSchemas`：更新 `docs/reference/plugins.md` 和 `docs/guide/plugin-authoring.md`。
- 新增 import ledger / transaction 语义：更新 `docs/reference/transactions.md`。
- 新增或修改 `/worlds/:id/sync-data`、preflight diagnostics API：更新 `docs/reference/api.md`。
- 新增 SSE/protocol 事件或 `plugin-data.changed` 语义变化：更新 `docs/reference/protocol.md`。
- 新增预检 UI 或右侧面板数据源：更新 `docs/reference/ui-panels.md`。

## 后续阶段

### SQLite

启用条件：只读/immutable、禁用 extension、只允许 table mapping、行数限制、identifier 校验、schema 校验和 duplicate key 规则齐备。

### Remote

启用条件：默认关闭、用户确认或部署配置开启、HTTPS、SSRF 防护、redirect 限制、大小限制、content-type 校验、digest 校验和 content-addressed cache 齐备。

## v1 校园世界示例

```text
worlds/haruka-academy/
  world.yaml
  WORLD.zh.md
  data/
    world.data.yaml
    dimensions.yaml
    characters/cast.json
    rules/daily-life.yaml
    scenes/opening.md
  media/
    portraits/mio.webp
    portraits/ren.webp
```

`world.yaml`：

```yaml
schemaVersion: "1"
id: haruka-academy
name:
  zh-CN: 晴丘学园
summary:
  zh-CN: 临海城市里的校园恋爱世界。
defaultLocale: zh-CN
recommendedPlugins:
  - chat-mode-narrator
  - character-blueprint
  - character-presence
  - living-world-rules
worldData: data/world.data.yaml
```

`data/world.data.yaml`：

```yaml
schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    schema: covel://world/dimensions
    to: world:metadata.dimensions

  cast:
    kind: json
    path: data/characters/cast.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id
    effects: [characters]

  dailyRules:
    kind: yaml
    path: data/rules/daily-life.yaml
    schema: plugin://living-world-rules/rules
    to: plugin:living-world-rules/rules+lorebook
    key: id

  openingScene:
    kind: markdown
    path: data/scenes/opening.md
    to: lorebook
    key: opening-scene

  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
```

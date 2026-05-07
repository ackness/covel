# World Data

`worldData` 是 world 包的统一数据入口。它把世界维度、角色卡、规则、场景模板和媒体索引声明成 source，再由服务器在 world load 或 session 创建阶段导入到现有 store。第三方插件也可以用同一套 descriptor 让 world 包携带插件数据。

## World Package

推荐结构：

```text
worlds/my-world/
├── world.yaml
├── WORLD.md
├── data/
│   ├── world.data.yaml
│   ├── dimensions.yaml
│   └── characters/cast.json
└── media/
    └── portraits/
```

`world.yaml`：

```yaml
schemaVersion: "1.0"
id: my-world
name: 我的世界
summary: 一个示例世界。
defaultLocale: zh-CN
requiredPlugins:
  - pregame
  - world-init
  - char-creator
recommendedPlugins:
  - character-blueprint
worldData: data/world.data.yaml
```

`worldData` path 相对 world root。

## Descriptor

`data/world.data.yaml` 使用 `sources` map：

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
    effects:
      - characters
    after: dimensions
```

字段：

| 字段      | 说明                                                                      |
| --------- | ------------------------------------------------------------------------- |
| `kind`    | `yaml`、`json`、`markdown`、`text`、`media`                               |
| `path`    | 相对 world root 的文件或目录                                              |
| `schema`  | `covel://...`、`plugin://<pluginId>/<namespace>`、或 world 内 schema path |
| `to`      | 写入目标 URI                                                              |
| `key`     | 简单字段名，例如 `id`、`characterId`、`filename`                          |
| `indexTo` | media source 的索引目标 URI                                               |
| `effects` | 额外投影；当前 `characters` 会把角色蓝图实例化为角色                      |
| `after`   | source 顺序依赖                                                           |
| `enabled` | 布尔值；`false` 会跳过该 source                                           |
| `locale`  | source 对应的内容语言                                                     |
| `merge`   | `replace` 或 `skipExisting`                                               |

## Target URI

当前支持：

| URI                                | 阶段           | 说明                                                |
| ---------------------------------- | -------------- | --------------------------------------------------- |
| `world:metadata.dimensions`        | world load     | 写入 `WorldRecord.metadata.dimensions`              |
| `plugin:<id>/<namespace>`          | session create | 写入目标插件的 `plugin_data`                        |
| `plugin:<id>/<namespace>+lorebook` | session create | 写入 `plugin_data`，并同步生成 session lorebook row |
| `lorebook`                         | session create | 直接写入 session lorebook                           |
| `characters`                       | session create | 直接 upsert session character                       |
| `media` + `indexTo`                | session create | 导入媒体并把索引写入 `plugin_data`                  |

`plugin:*/*` 与 `indexTo` 都会做 preflight：

- 目标插件已注册。
- 目标插件在本 session 最终启用插件列表中。
- 目标 namespace 在插件 `dataSchemas` 中声明。
- `acceptsWorldData: true`。
- 插件包内 JSON Schema 校验 source item 通过。

## Character Blueprint Import

角色卡 source 示例：

```yaml
sources:
  cast:
    kind: json
    path: data/characters/cast.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
```

`cast.json` 可以是一张角色卡对象，也可以是角色卡数组。创建 session 时，服务器会：

- 写入 `plugin_data[character-blueprint][blueprints]`
- 根据 `effects: [characters]` 写入 `characters`
- 镜像到当前 session 已启用、且声明 `dataSchemas.characters.acceptsWorldData: true` 的插件

角色面板类第三方插件可以接收同一份角色记录。插件只要声明 `characters` namespace，并在 session 插件列表中启用，就会收到由 world data 实例化出的 CharacterRecord。

## Third-Party Extension

第三方库可以以 world 包或 override 包交付数据。插件作者推荐把数据契约写成 `plugin://<pluginId>/<namespace>` schema URI，再在 world 包里引用这个 schema。

独立 world 包：

```text
worlds/my-world-extra/
├── world.yaml
└── data/
    ├── world.data.yaml
    ├── characters/cast.json
    └── dimensions.yaml
```

给已有 world 增加本地覆盖：

```text
~/.covel/world-overrides/<world-id>/
├── world.data.override.yaml
└── data/
    └── characters/cast-extra.json
```

`world.data.override.yaml`：

```yaml
schemaVersion: 1
sources:
  cast-extra:
    kind: json
    path: data/characters/cast-extra.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
    after: cast
```

override path 相对 `~/.covel/world-overrides/<world-id>/`，并会做 realpath containment。

### 配套插件数据

插件可以为自己的 namespace 约定一个 schema URI：

```yaml
sources:
  social-links:
    kind: yaml
    path: data/social/links.yaml
    schema: plugin://social-sim/relationships
    to: plugin:social-sim/relationships
    key: id
    after:
      - cast
```

插件侧需要做到三件事：

1. 在 `PLUGIN.md` 写清楚 namespace、schema URI、数据形状和示例文件。
2. 在 runtime 或工具中读取 `plugin_data[<pluginId>][<namespace>]`。
3. 给 world 包作者提供最小可运行的 `data/world.data.yaml` 片段。

插件需要在 `PLUGIN.md` frontmatter 声明 `dataSchemas`：

```yaml
dataSchemas:
  relationships:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/relationships.schema.json
    description: Importable relationship records.
```

`schema` 是插件根目录相对路径，当前要求 JSON Schema 文件。多 runtime 插件可以在多个 runtime 的 `PLUGIN.md` 中声明同一 namespace；声明内容一致时会合并到 plugin-level registry，冲突时插件注册失败。session 自动导入会读取该 schema 并用 Ajv 校验每个 source item。

插件数据文件建议使用数组作为批量格式：

```yaml
- id: mio-rin
  from: kamishiro-mio
  to: asakura-rin
  type: clubmate
  score: 42
```

对应的 schema URI：

```yaml
schema: plugin://social-sim/relationships
to: plugin:social-sim/relationships
key: id
```

创建 session 时，框架会把每条实际提交的 `plugin_data`、`lorebook`、`character`、`media index` 写入 `world_data_import_ledger`，记录 `target`、`pluginId`、`namespace`、`key`、`sourceDigest`、`valueHash`、`schemaRef` 和 `sourceId`。session 创建会用 store transaction 包住 session、plugin-data、lorebook、characters 与 ledger 写入；导入失败时会回滚这些 store row。

### Preflight 与 Sync

开始游戏前可以调用：

```http
POST /api/worlds/<world-id>/world-data/preflight
```

请求传 `plugins` 时按当前插件选择预检；传 `sessionId` 时按已有 session 的 active plugins 预检。内置 Web UI 在开始游戏前会自动调用该接口，展示 planned writes、目标摘要和 diagnostics。

已有 session 可以调用：

```http
POST /api/worlds/<world-id>/sync-data
```

默认 dry-run，返回 `upserted`、`deleted`、`unchanged` 和 `conflicts`。传 `dryRun:false` 才写入。同步规则：

1. 只处理 ledger 中 `managed=true` 且 `sourceWorldId` 匹配当前 world 的 row。
2. 当前目标 row 的 hash 与 ledger `valueHash` 一致时才自动覆盖或删除。
3. 目标 row 被玩家或插件改动时返回 `conflicts.reason = "modified"`。
4. 目标 row 缺失时返回 `conflicts.reason = "missing"`。
5. 传 `force:true` 时允许覆盖 modified/missing 冲突。

### World 包与插件包的边界

插件包放执行逻辑、UI、schema 文档和默认示例。world 包放具体世界数据和媒体资源。第三方库同时交付插件与世界数据时，推荐结构如下：

```text
my-covel-pack/
├── plugins/
│   └── social-sim/
│       ├── PLUGIN.md
│       └── handler.js
└── worlds/
    └── haruka-social-extra/
        ├── world.yaml
        ├── WORLD.md
        └── data/
            ├── world.data.yaml
            └── social/links.yaml
```

`world.yaml` 用 `requiredPlugins` 或 `recommendedPlugins` 声明插件关系：

```yaml
recommendedPlugins:
  - social-sim
worldData: data/world.data.yaml
```

### Override 发布方式

给已有世界追加插件数据时，发布 override 包。安装器把文件放入：

```text
~/.covel/world-overrides/haruka-academy/
├── world.data.override.yaml
└── data/social/links.yaml
```

override descriptor 可以新增 source，也可以覆盖已有 source 的 `path`、`enabled`、`merge` 等字段：

```yaml
schemaVersion: 1
sources:
  social-links:
    kind: yaml
    path: data/social/links.yaml
    schema: plugin://social-sim/relationships
    to: plugin:social-sim/relationships
    key: id
    merge: skipExisting
```

### 开发检查清单

- source id 使用短名，例如 `cast`、`social-links`、`portraits`。
- `path` 放在 `data/` 或 `media/` 下。
- `schema` 使用稳定 URI，插件升级时保持兼容。
- `to` 指向插件自己的 namespace。
- `key` 指向数据对象中的稳定 id 字段。
- 大文本放 markdown/text source，大结构化数据放 yaml/json source，多媒体放 media source。
- world 包和 override 包都通过 containment 校验，路径保持在各自根目录内。

## Current Limits

- v1 source 只读取本地 `yaml`、`json`、`markdown`、`text`、`media`。
- media source 只扫描一层目录，使用 v1 扩展名 allowlist 和大小限制。
- `merge` 只支持 `replace` 与 `skipExisting`。
- `key` 只支持简单字段名、markdown/text literal key、media `filename`。
- remote、SQLite source、CUE、RO-Crate、复杂 JSON Patch override 属于后续阶段。

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

| URI                                     | 说明                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| `world:metadata.dimensions`             | world load 阶段写入 `WorldRecord.metadata.dimensions` |
| `plugin:character-blueprint/blueprints` | session 创建阶段写入角色蓝图 plugin-data              |

设计文档中还定义了 `plugin:*/*+lorebook`、`lorebook`、`characters`、`media`、`indexTo`，这些属于后续扩展点。

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
- 镜像到 `plugin_data[character-blueprint][characters]`
- 镜像到 `plugin_data[char-creator][characters]`

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

当前框架会解析并汇总任意合法 `plugin:<pluginId>/<namespace>` target。session 自动导入阶段已经接入 `plugin:character-blueprint/blueprints`。第三方插件接入自动导入时，应实现专属 importer 或后续统一 importer hook。

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

- `plugin:character-blueprint/blueprints` 是当前已接入 session importer 的 plugin target。
- `world:metadata.dimensions` 是当前已投影的 world metadata target。
- 插件 `dataSchemas` registry、media import、`+lorebook`、SQLite、remote source 属于后续阶段。

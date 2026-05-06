# World Data 文件系统设计

本设计追求一个简单、高效、可长期演进的格式：

- `world.yaml` 只放世界基础信息和入口。
- `data/world.data.yaml` 只描述“读什么、按什么 schema 校验、投影到哪里”。
- world 包路径相对 world root；用户 override 路径相对对应 override root。
- importer 生成通用 import plan，不写死任何玩法插件。

## 目录结构

```text
worlds/<world-id>/
  world.yaml
  WORLD.md
  WORLD.zh.md
  data/
    world.data.yaml
    dimensions.yaml
    characters/
      cast.json
    rules/
      daily-life.yaml
    scenes/
      opening.md
  media/
    portraits/
      mio.webp
  schemas/
    *.schema.json
```

保留旧字段：`dimensions`、`dimensionSources`、`characterBlueprintSources`。loader 可以把它们转换成等价 sources，以便旧世界继续工作。

## world.yaml

只新增一个字段：

```yaml
schemaVersion: "1"
id: haruka-academy
name:
  zh-CN: 晴丘学园
summary:
  zh-CN: 一所临海城市里的校园恋爱世界。
defaultLocale: zh-CN
recommendedPlugins:
  - chat-mode-narrator
  - character-blueprint
  - character-presence
worldData: data/world.data.yaml
```

`worldData` 是相对 world root 的文件路径。

## world.data.yaml

最小格式：

```yaml
schemaVersion: 1
sources: {}
```

推荐使用 map，而不是数组。source id 直接作为 key，易读、易覆盖、易定位错误。

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

## Source 字段

| 字段 | 必需 | 含义 |
|---|---:|---|
| `kind` | 是 | `yaml`、`json`、`markdown`、`text`、`media` |
| `path` | 是 | 相对 descriptor root 的路径 |
| `schema` | 否 | `covel://...`、`plugin://<pluginId>/<namespace>`、`schemas/*.schema.json` |
| `to` | 是 | 投影目标 |
| `key` | 否 | 写入 key；不同 kind 有不同简单语义 |
| `indexTo` | 否 | media 索引写入目标，只允许 `plugin:<pluginId>/<namespace>` |
| `effects` | 否 | 额外系统效果，例如 `characters` |
| `enabled` | 否 | 默认 `true` |
| `locale` | 否 | 限定 locale |
| `merge` | 否 | 默认 `replace` |
| `after` | 否 | 声明少量顺序依赖，字符串或字符串数组 |

### 执行顺序

`sources` 是 map，但执行顺序仍然稳定：

1. 默认按 YAML 声明顺序执行。
2. 如果 source 声明 `after`，importer 对 source 图做拓扑排序。
3. `after` 只引用合并 descriptor 后的 source id。
4. 循环依赖或引用不存在的 source 是 schema/diagnostic error。
5. 拓扑排序 tie-breaker 使用合并后的声明顺序。

示例：

```yaml
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    to: world:metadata.dimensions

  cast:
    kind: json
    path: data/characters/cast.json
    to: plugin:character-blueprint/blueprints
    key: id
    after: dimensions
```

大多数世界包不需要写 `after`。只有当某个 source 的校验、效果或 UI 预检明确依赖另一个 source 时才使用。

source id 必须是非数字开头的短标识，避免不同 YAML/JS 实现对整数 key 的排序差异：`^[a-z][a-zA-Z0-9_-]{0,63}$`。

override 后的合并顺序：

- 被 override 的已有 source 保留原始位置。
- `enabled: false` 的 source 会被跳过，但 diagnostics 仍可保留它的 source id。
- override 新增的 source 允许存在，按 override 文件声明顺序追加在末尾。
- `WorldDataMetadataSummary.sources[]` 按最终执行顺序保存。

## 用户 Override

用户 override 不建议放进 world 包目录。world 包应尽量保持可更新、可校验、可重装；用户本地修改应放在 Covel home 下独立管理。

桌面默认位置：

```text
~/.covel/world-overrides/<world-id>/
  world.data.override.yaml
  data/
    characters/cast.override.yaml
  media/
    portraits/mio-custom.webp
```

也可通过配置把 Covel home 改到其他位置；语义上这是“用户配置根”下的 `world-overrides/`，不是 `data_root` 下的数据缓存。

推荐 override 文件：

```yaml
schemaVersion: 1
sources:
  cast:
    path: data/characters/cast.override.yaml
  portraits:
    path: media/portraits
```

规则：

- world 包内 `data/world.data.yaml` 是发行默认值。
- `~/.covel/world-overrides/<world-id>/world.data.override.yaml` 是用户本地 descriptor override。
- override 文件里的相对 path 以该 override 目录为 root。
- override path 同样必须做 realpath containment，不能逃出对应 override root。
- 用户 override 优先级高于 world 包 descriptor，但低于 session 内玩家/插件运行时写入。

这样可以让用户替换角色、规则或立绘，而不修改原 world 包。世界包升级时，用户 override 仍然保留。

### path

v1 规定 source path 相对它所属 descriptor 的 root：

- world 包 descriptor：相对 world root。
- 用户 override descriptor：相对 `~/.covel/world-overrides/<world-id>/`。

```yaml
path: data/characters/cast.json
path: media/portraits
path: schemas/custom.schema.json
```

不使用 `../media` 这种相对 `world.data.yaml` 的写法。实现必须做 realpath containment，确保最终路径仍在对应 root 内。

### key

v1 不支持完整 JSONPath，只保留 kind-specific 的简单规则：

| kind | `key` 语义 |
|---|---|
| `yaml` / `json` | `id` 或 `characterId` 表示从对象字段提取 key；数组源逐项提取 |
| `markdown` / `text` | `key` 是 literal record key，例如 `opening-scene` |
| `media` | `filename` 表示使用不含扩展名的文件名；文件 source 也可给 literal key |

需要复杂 key 时，先在源数据里显式写 `id`，或拆成多个 source。

### merge

v1 只支持：

| 值 | 行为 |
|---|---|
| `replace` | 后写覆盖前写，默认 |
| `skipExisting` | 目标已有时跳过 |

`skipExisting` 的“已有”包括同一次 import 中更早的 planned write，也包括目标 session store 中已经存在的同 target/key 记录。后续 sync 时，provenance/conflict 检查优先于 `merge`：未由 importer 管理或已被玩家/插件修改的记录不会被 `replace` 自动覆盖，除非用户显式 `force`。

`deep`、`appendByKey` 等复杂 merge 暂不进入第一版。数组源默认拆成多条记录；对象源默认作为单条记录。

## Source Kind

### yaml / json

解析为 JSON value，然后按 schema 校验。

数组输入：每个 item 生成一条 import item。
对象输入：生成一条 import item；如果指定 `key`，从对象字段取 key。

### markdown / text

解析为 string。

`markdown` 适合 lore、scene prompt、规则说明。
`text` 适合模板、代码片段、长提示词。代码片段只是文本资产，不赋予执行权限。

### media

media source 可以指向文件或目录。导入时生成 `MediaRef`。`to: media` 只负责导入/授权 media；只有声明 `indexTo` 时才会把 `MediaRef` 索引写入 plugin-data。

`indexTo` 只允许 `plugin:<pluginId>/<namespace>`，并走和 `to: plugin:<pluginId>/<namespace>` 相同的插件安装、session 选中、`dataSchemas.acceptsWorldData` 校验。

media 的实际 `MediaStore.put()` 和 session ref 授权发生在 session 创建阶段，而不是 world load 阶段。

## Target URI

为简洁起见，v1 使用单字符串 `to`：

| 格式 | 含义 |
|---|---|
| `world:metadata.<path>` | 写入 `WorldRecord.metadata` 的路径 |
| `plugin:<pluginId>/<namespace>` | 写入 plugin-data |
| `plugin:<pluginId>/<namespace>+lorebook` | 写 plugin-data，并生成 lorebook 条目 |
| `lorebook` | 写 session lorebook |
| `characters` | 创建/更新 session character |
| `media` | 导入/授权 MediaStore；仅在 `indexTo` 存在时写 media index |

v1 不提供任意 target URI 扩展点；新增 target 必须升级规范。

解析规则：

- `world:metadata.<path>` 的 `<path>` 是点分 metadata path，只允许 `[a-zA-Z0-9_.-]`，不能写原型污染相关 key，例如 `__proto__`、`constructor`、`prototype`。v1 还禁止写入旧 shim 消费的 `world:metadata.characterBlueprints`，避免绕过 `dataSchemas`。
- `plugin:<pluginId>/<namespace>` 中的 `pluginId` 和 `namespace` 必须匹配插件 ID / namespace 安全字符集。
- `+lorebook` 只能附加在 `plugin:<pluginId>/<namespace>` 后。
- `characters` 和 `media` 是完整 literal，不接受子路径。

`plugin:<pluginId>/<namespace>` 中的插件 ID 来自 world 数据。框架 importer 不能对具体 ID 写分支逻辑；只能验证目标插件已安装、被本 session 选中，并且声明了兼容 schema。

importer 只负责四件事：路径、解析、校验、投影。玩法插件字段的业务含义由目标插件的 JSON Schema、handler 和 UI 负责。

## Schema URI

| 格式 | 含义 |
|---|---|
| `covel://world/dimensions` | Covel 内置 schema |
| `plugin://<pluginId>/<namespace>` | 插件声明的 namespace schema |
| `schemas/*.schema.json` | world 包内 schema 文件 |

v1 不加载 remote schema。

## Plugin dataSchemas

插件可以声明自己愿意接收哪些 world data。v1 的规范语义是 plugin-level registry；实现上先把声明写在 `PLUGIN.md` frontmatter 中，由 loader 合并为 plugin-level registry。多 runtime 插件可以只在主 runtime 声明；如果多个 runtime 都声明，同 namespace 内容必须一致，否则插件加载时报错。

建议格式：

```yaml
dataSchemas:
  schemaVersion: 1
  namespaces:
    blueprints:
      schema: schemas/blueprint.schema.json
      key: id
      acceptsWorldData: true
      ui: form
```

字段：

| 字段 | 含义 |
|---|---|
| `schemaVersion` | dataSchemas 版本 |
| `namespaces` | namespace 到 schema 的映射 |
| `schema` | 相对 plugin root 的 JSON Schema 文件 |
| `key` | 默认 key 字段 |
| `acceptsWorldData` | 是否允许 world importer 写入 |
| `ui` | 可选编辑器建议：`form`、`table`、`json`、`asset-picker` |

loader 必须把 `dataSchemas` 合并为 plugin-level registry；同一 namespace 冲突时报错。schema path 相对 plugin root，并必须做 realpath containment。

## Effects

`effects` 表达少量框架级通用副作用。v1 只建议一个：

```yaml
effects: [characters]
```

含义：source item 除了写入 `to`，还会按通用 Character schema 创建/更新 session character。

不要把 `effects` 做成插件特定逻辑，例如不要在框架中实现 `if pluginId === "character-blueprint"`。

## Normalized Import Plan

importer 读取 world data 后生成计划：

```ts
type ImportPlanItem = {
  sourceId: string;
  target: string;
  key?: string;
  value: unknown;
  schemaRef?: string;
  effects?: string[];
  provenance: {
    worldId: string;
    sourceDigest: string;
    valueHash: string;
  };
};
```

world load 阶段只生成 `WorldDataMetadataSummary`；session import 阶段会重新读取合并后的 descriptor/source，校验 digest 后重建完整 `ImportPlanItem[]`。不从 `WorldRecord.metadata.worldData` 还原完整计划。

`WorldRecord.metadata.worldData` 只保存轻量摘要，不保存 source 大内容：

```ts
type WorldDataMetadataSummary = {
  schemaVersion: 1;
  sources: Array<{
    id: string;
    digest: string;
    target: string;
    schema?: string;
    importedAt?: string;
    order: number;
    origin: "world" | "override";
    overridden?: boolean;
    diagnostics: {
      info: number;
      warning: number;
      error: number;
    };
  }>;
};
```

大内容进入 plugin_data、lorebook、characters、MediaStore，或在 session import 时重新从 source 文件读取。不要在 `WorldRecord.metadata.worldData` 保存大数组、媒体 bytes、SQLite rows 或 remote body。

## 内置变体

v1 不在 world 包内设计复杂 override 系统。如果作者想发布多个官方变体，推荐直接放多个 source 文件，并通过 `enabled` 切换，或发布为独立 world 包。

用户本地 override 使用 `~/.covel/world-overrides/<world-id>/`，见上文“用户 Override”。复杂 JSON Patch / Merge Patch 留到后续版本。

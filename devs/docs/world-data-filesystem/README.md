# Covel World Data Filesystem

目标：用一个简洁、稳定、作者友好的文件格式，把 world 包里的结构化数据、文本和媒体导入 Covel 现有存储。

核心原则：**文件是作者入口，JSON value 是运行时格式，现有 store 是唯一投影目标。**

## 推荐方案

每个世界包仍以 `world.yaml` 为入口，只新增一个可选字段：

```yaml
worldData: data/world.data.yaml
```

`data/world.data.yaml` 声明少量数据源：

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

  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
```

推荐目录：

```text
worlds/haruka-academy/
  world.yaml
  WORLD.zh.md
  data/
    world.data.yaml
    dimensions.yaml
    characters/cast.json
    rules/daily-life.yaml
  media/
    portraits/mio.webp
  schemas/
    custom.schema.json
```

## v1 范围

v1 只做本地、确定性、低风险导入：

- `kind`: `yaml`、`json`、`markdown`、`text`、`media`
- `to`: `world:metadata.*`、`plugin:*/*`、`plugin:*/*+lorebook`、`lorebook`、`characters`、`media`
- world 包 path 统一相对 world root，用户 override path 相对 `~/.covel/world-overrides/<world-id>/`
- source 全量校验后生成 import plan，再写入 session store
- media 在 session 创建时导入/授权，不在 world load 阶段绑定 session

暂不实现：SQLite、remote source、CUE、RO-Crate 导出、复杂 override 系统。

## 必须保持的边界

- `sources` 默认按 YAML 声明顺序执行；少量依赖用 `after` 显式表达。
- `to` URI 固定为 `world:metadata.*`、`plugin:*/*`、`plugin:*/*+lorebook`、`lorebook`、`characters`、`media`。
- 框架 importer 是通用系统服务，不能硬编码具体插件 ID。
- world 文件可以声明 `plugin:xxx/ns`，但 importer 只把它当数据，并要求目标插件已安装/被选中且声明兼容 `dataSchemas`。
- importer 只做路径、解析、schema 校验和投影；玩法字段含义由插件 schema、handler 和 UI 负责。
- `WorldRecord.metadata.worldData` 只存 source id、digest、target、schema、importedAt、order、origin/overridden、diagnostics count，不塞大体量源数据。
- 每条导入记录必须有 provenance，后续 sync 只能覆盖 importer 管理且未被玩家/插件改动的数据。
- 用户本地 override 放在 Covel home：`~/.covel/world-overrides/<world-id>/`，不修改原 world 包。

## 文档结构

- [01-current-state.md](./01-current-state.md)：现状和可复用点。
- [02-standards-research.md](./02-standards-research.md)：采用与不采用的外部标准。
- [03-filesystem-design.md](./03-filesystem-design.md)：v1 文件格式。
- [04-import-security.md](./04-import-security.md)：导入、安全和冲突策略。
- [05-migration-plan.md](./05-migration-plan.md)：最小落地计划。
- [06-implementation-handoff.md](./06-implementation-handoff.md)：可并行执行的具体实现方案。

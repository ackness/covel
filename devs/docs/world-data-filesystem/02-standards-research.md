# 外部标准取舍

本设计只吸收成熟标准里最小、稳定、好实现的部分。目标不是把 Covel world 包做成通用数据包规范，而是给游戏世界数据一个优雅的作者格式。

## 采用

### JSON value

YAML、JSON、Markdown、Text、Media index 最终都规范化为 JSON value 或 string。这样 importer、schema 校验、plugin-data、lorebook 和前端预检可以共用一套数据模型。

### JSON Schema

来源：https://json-schema.org/specification

用途：

- world data 的公开契约。
- plugin data namespace 的公开契约。
- 前端表单和预检错误定位。

Covel schema URI：

```yaml
schema: covel://world/dimensions
schema: plugin://character-blueprint/blueprints
schema: schemas/custom.schema.json
```

TypeScript 内部可以继续用 Zod；公开给 world 包和插件互操作时使用 JSON Schema。

### Frictionless Data Resource 的 source 思路

来源：https://specs.frictionlessdata.io/data-resource/

借鉴点：用一个 descriptor 描述数据文件、格式、schema。

Covel 不完整实现 Data Package，只采用轻量 source：

```yaml
sources:
  cast:
    kind: json
    path: data/characters/cast.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
```

Covel 比 Data Resource 多 `to`、`key`、`effects`，因为它需要投影到游戏运行时 store。

### Content digest

来源：OCI Descriptor digest 模型 https://github.com/opencontainers/image-spec/blob/main/descriptor.md

用途：

- source 变更检测。
- media 去重。
- import provenance。
- 后续 remote cache。

推荐格式：

```yaml
integrity:
  digest: sha256:9d4f...
  size: 184233
  mediaType: image/png
```

v1 可由 importer 自动计算 digest，不要求作者手写。

## 暂不采用为核心格式

### JSON Patch / JSON Merge Patch

来源：

- RFC 6902：https://www.rfc-editor.org/rfc/rfc6902
- RFC 7396：https://www.rfc-editor.org/rfc/rfc7396

它们表达能力强，但会让 v1 override 复杂化。v1 只做用户目录里的 descriptor-level 覆盖：

```text
~/.covel/world-overrides/haruka-academy/world.data.override.yaml
```

```yaml
schemaVersion: 1
sources:
  cast:
    enabled: false
  portraits:
    path: media/custom-portraits
```

后续如果需要精确修改源数据，再引入 JSON Patch。

### RO-Crate

来源：https://www.researchobject.org/ro-crate/specification/1.1/

RO-Crate 适合发布层 provenance、作者、license、引用关系，但对 v1 运行时导入过重。Covel 可以未来导出 `ro-crate-metadata.json`，但不作为 world data 必需格式。

### SQLite

来源：https://www.sqlite.org/fileformat.html

SQLite 是好的大数据容器，但安全和导入语义明显更复杂：只读打开、identifier 校验、行数限制、BLOB 处理、重复 key、schema 校验等都需要完整设计。

结论：v1 不启用 SQLite。后续作为 `kind: sqlite` 加入。

### Remote + SRI

来源：https://www.w3.org/TR/SRI/

remote source 需要 SSRF 防护、redirect 校验、digest、cache、大小限制和用户授权。v1 不启用 remote。后续无人值守 remote import 应要求 integrity。

### CUE

来源：https://cuelang.org/

CUE 对高级作者有吸引力，但会增加学习成本和运行时依赖。v1 不采用。默认路径保持 YAML + JSON Schema。

## 最终选择

v1 标准组合：

1. YAML manifest 作为作者入口。
2. JSON value 作为运行时交换格式。
3. JSON Schema 作为公开契约。
4. 简单 source descriptor 作为数据索引。
5. Content digest 作为 provenance 和变更检测。
6. `~/.covel/world-overrides/<world-id>/` 下的 descriptor-level override 作为最小覆盖机制。

这套组合足够覆盖校园世界、角色蓝图、日常规则、场景提示和角色立绘，同时保持实现简单。

# 导入与安全设计

目标：导入流程要可预测、可回滚、可诊断，并且不扩大插件隔离边界。

## 导入流程

推荐新增内部服务 `WorldDataImporter`。

```text
load world package
  -> read world.yaml
  -> read data/world.data.yaml
  -> discover user overrides from ~/.covel/world-overrides/<world-id>/
  -> apply descriptor overrides
  -> validate descriptors
  -> read local sources
  -> validate values by schema
  -> build WorldDataMetadataSummary
  -> store WorldRecord.metadata.worldData

create session
  -> compute final plugin set
  -> rebuild full import plan from descriptors/sources
  -> resolve plan against selected plugins
  -> preflight all writes, including media put
  -> commit DataStore writes in transaction
  -> authorize media refs for session
  -> activate plugins
```

导入必须先于插件激活完成，这样 Pre-Game runtime 能读到导入后的数据。

## Importer 权限边界

world importer 是框架内部的 privileged system service，但它不能绕过插件契约任意写数据。

规则：

1. importer 只解析 `to` / `indexTo` URI 和插件 manifest 的 `dataSchemas`。
2. `plugin:<pluginId>/<namespace>` 目标必须指向已安装插件。
3. 目标插件必须在本 session 的最终插件集合中。
4. 目标 namespace 必须由插件 `dataSchemas` 声明 `acceptsWorldData: true`。
5. `indexTo` 是 plugin-data 写入路径，必须走同样检查，不能绕过 `dataSchemas`。
6. world 文件里的 `pluginId` 是数据，不是框架分支条件。框架代码不能硬编码具体玩法插件 ID。
7. importer 只做路径、解析、schema 校验、key 提取和投影；玩法字段含义由插件 schema、handler 和 UI 负责。
8. 缺失插件、未启用插件、schema 不兼容时生成 diagnostic；默认阻止该 source 写入。

## 路径安全

本地 path 有两个 root：

| 来源                                                                         | path root              |
| ---------------------------------------------------------------------------- | ---------------------- |
| world 包 `world.data.yaml`                                                   | world root             |
| 用户 override `~/.covel/world-overrides/<world-id>/world.data.override.yaml` | 该 world override root |

实现要求：

- 禁止绝对路径。
- 禁止解析结果离开对应 root。
- 使用 `realpath` 检查最终路径；symlink 目标也必须留在对应 root 内。
- 可选择直接拒绝 symlink，以简化安全模型。
- 不递归读取隐藏目录、`.git`、`node_modules`。
- 用户 override 不放在 `data_root`，避免随数据库缓存迁移而丢失；默认放在 `~/.covel/world-overrides/`。

建议默认限制：

| 项                        | 建议限制 |
| ------------------------- | -------: |
| `world.yaml`              |  256 KiB |
| `world.data.yaml`         |  512 KiB |
| 单个 YAML/JSON source     |    2 MiB |
| 单个 Markdown/Text source |    1 MiB |
| 单个 schema 文件          |  512 KiB |
| media 单文件              |   20 MiB |
| 单个 media source 总量    |  100 MiB |
| source 数量               |      128 |
| 单 source item 数量       |   10,000 |
| plugin-data key 长度      |      128 |

## YAML / JSON

规则：

- 只解析普通数据结构。
- 禁用自定义 tag、对象实例化和函数构造。
- 解析后必须是 JSON value：object、array、string、number、boolean、null。
- 按 source schema 校验后才生成 import item。

诊断信息必须包含：

```ts
type WorldDataDiagnostic = {
  level: "info" | "warning" | "error";
  sourceId?: string;
  path?: string;
  schema?: string;
  pointer?: string;
  message: string;
};
```

## Markdown / Text

Markdown/Text 作为 string 导入。

代码片段只能作为文本资产：

```yaml
calendarSnippet:
  kind: text
  path: data/snippets/school-calendar.ts.txt
  to: plugin:scene-prompts/snippets
  key: school-calendar
```

导入文本不会赋予执行权限。代码是否执行只由插件 runtime/tool/RPC 自己的权限系统决定。

## Media

media source 在 world load 阶段只建立摘要：路径、mime、size、digest、diagnostics。

session 创建阶段才执行：

1. 读取媒体文件。
2. sniff/校验 MIME。
3. 计算 SHA-256。
4. `MediaStore.put()`。
5. 为当前 session 调用 `addRef()` 或等价授权。
6. 把 `MediaRef` 索引写入 `indexTo` 指定目标。

允许 MIME 建议：

- `image/png`
- `image/jpeg`
- `image/webp`
- `audio/mpeg`
- `audio/wav`
- `video/mp4`

PDF 和任意附件暂不进入 v1，避免浏览器展示和安全策略复杂化。

media 目录导入规则：

- 默认只读一层文件，不递归。
- 跳过隐藏文件。
- 稳定排序：按相对路径字典序。
- `key: filename` 使用完整 basename，包含扩展名。

## Schema 解析

解析顺序：

1. `covel://...`：框架内置 JSON Schema。
2. `plugin://<pluginId>/<namespace>`：插件 `dataSchemas` registry。
3. `schemas/*.schema.json`：world 包内 schema。

v1 不支持 remote schema。

JSON Schema `$ref` 默认只允许同文件 fragment（例如 `#/$defs/Foo`）。禁止 remote `$ref` 和任意文件 `$ref`；后续如果要支持跨文件 local `$ref`，必须使用同一 root containment 规则显式实现。

所有 schema path 也必须做 realpath containment。插件 schema path 相对 plugin root。world 包 descriptor 里的 `schemas/*.schema.json` 相对 world root；用户 override descriptor 里的 `schemas/*.schema.json` 相对 override root。实现应跟踪 path-bearing 字段来源，而不是只保存合并后的字符串。

## 事务与提交

导入分两步：preflight 和 commit。

### Preflight

preflight 必须完成：

- source descriptor 校验。
- source 执行顺序拓扑排序；`after` 引用不存在或循环依赖时报错。
- `to` / `indexTo` URI 解析和安全字符检查。
- path 校验。
- 文件大小检查。
- schema resolve。
- value schema 校验。
- 目标插件和 namespace 权限检查。
- key 提取和重复 key 检查。
- media digest/mime/size 检查。

有 `error` 级 diagnostic 时，默认不创建 session。v1 不提供“忽略 error 后继续创建 session”的通用开关。后续若需要 optional source，必须显式声明 `optional: true`，且路径安全、schema 解析、schema 校验、目标插件权限、`acceptsWorldData`、`indexTo`、prototype-pollution target、重复 key 等安全/完整性错误仍不可忽略。

### Commit

DataStore 写入应放在 transaction 内：

```text
beginTx
  create session
  write plugin_data
  write lorebook_entries
  upsert characters
  write import ledger
commitTx
```

MediaStore 没有事务，所以 v1 采用固定顺序：

1. preflight 阶段读取 media、校验 MIME/size/digest；DataStore transaction 内写入 media index 前执行 `MediaStore.put()`，失败则回滚 DataStore transaction。
2. `beginTx` 后写入 session、plugin_data、lorebook、characters、media index 和 ledger。
3. DataStore commit 成功后调用 `MediaStore.addRef()` 授权当前 session。
4. session 创建接口在所有 `addRef()` 成功后才返回成功；若授权失败，v1 执行补偿删除刚创建的 session 及其 import 写入，不激活插件，并返回错误 diagnostic。v1 不实现 pending retry 状态。

## Provenance 与冲突

每条由 session importer 写入的数据都必须记录 provenance。这里的“每条”指实际提交到 session store 的每一行：plugin-data row、lorebook row、character row、media index row。world load 阶段写入的 `WorldRecord.metadata.worldData` 不进入 session-scoped ledger；它的 provenance 由 summary 中的 digest/origin/overridden 表达。可以用 sidecar ledger，也可以放在 store 支持的元数据字段中；不建议污染插件业务 value。

建议 ledger：

```ts
type WorldDataImportLedger = {
  id: string;
  sessionId: string;
  target: string;
  pluginId?: string;
  namespace?: string;
  key?: string;
  sourceWorldId: string;
  sourceId: string;
  sourceDigest: string;
  valueHash: string;
  schemaRef?: string;
  derivedFrom?: string;
  importedAt: string;
  managed: boolean;
};
```

`valueHash` 按目标类型计算 canonical JSON hash：plugin-data 使用业务 value；lorebook 使用 importer 管理字段；character 排除非托管的 volatile timestamp；media index 使用包含 `MediaRef.id` 的索引 value。

当前 sync 规则：

- 只自动覆盖 `managed: true` 的记录。
- 覆盖前检查当前 value hash 是否仍等于上次 `valueHash`。
- 如果不等，说明玩家或插件改过，生成 conflict diagnostic，不自动覆盖。
- `force` 模式可以覆盖，但必须由用户显式触发。

优先级：

```text
world 包默认 descriptor / source
< 用户本地 descriptor override (~/.covel/world-overrides/<world-id>/)
< session 创建时 importer 数据
< 玩家编辑 / 插件 runtime 写入
```

## 重复 key

v1 规则保持简单：

- 同一 source 内重复 key 是 error。
- 不同 source 写入同一 target/key：按 source 顺序后者覆盖，除非 `merge: skipExisting`。
- 覆盖行为必须产生 warning diagnostic。

## 暂不启用的能力

### SQLite

SQLite 作为后续阶段。启用前必须满足：只读/immutable、禁用 extension、只允许 table mapping、行数限制、identifier 校验、BLOB 处理规则、超时和重复 key 规则。

### Remote

remote source 作为后续阶段。默认关闭。启用前必须满足：HTTPS、SSRF 防护、redirect 限制、DNS 解析后 IP 校验、大小限制、content-type 校验、digest 校验、content-addressed cache。无人值守导入应要求 integrity。

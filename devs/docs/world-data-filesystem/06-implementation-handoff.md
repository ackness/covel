# World Data Filesystem v1 实施方案

本文是可执行的工程落地方案，目标是让多个 subagent/worker 可以并行实现，最后由主分支合并和 review。

## 目标范围

v1 只实现本地 world data：

- `world.yaml` 新增 `worldData?: string`
- `data/world.data.yaml` 的 `sources` map
- source kind：`yaml`、`json`、`markdown`、`text`、`media`
- target URI：`world:metadata.*`、`plugin:*/*`、`plugin:*/*+lorebook`、`lorebook`、`characters`、`media`
- 用户 descriptor override：`~/.covel/world-overrides/<world-id>/world.data.override.yaml`
- `WorldRecord.metadata.worldData` 轻量摘要
- session 创建时重建完整 import plan 并写入现有 store
- plugin-level `dataSchemas` registry
- import provenance ledger

不做：SQLite、remote、复杂 JSON Patch、CUE、RO-Crate、完整 sync UI。

## 核心实现原则

1. importer 的通用目标路径按 URI、registry 和 schema 驱动；v1 允许少量框架级 `effects` 映射来桥接现有核心角色系统。
2. importer 只做路径、解析、schema 校验、key 提取和投影。
3. plugin 字段业务语义属于插件 schema、handler 和 UI。
4. world load 阶段不保存大 source value。
5. session import 阶段重新读取 descriptor/source，校验 digest 后生成完整 plan。
6. 所有 plugin-data 写入路径，包括 `indexTo`，都必须验证目标插件已安装、被 session 选中、namespace 声明 `acceptsWorldData: true`。
7. 每个实际提交的 store row 都有 ledger/provenance。

## 建议文件结构

新增 server 内部模块：

```text
apps/server/src/world-data/
  types.ts
  safe-path.ts
  descriptor.ts
  target-uri.ts
  source-order.ts
  schema-registry.ts
  source-reader.ts
  media.ts
  world-load.ts
  session-import.ts
  legacy.ts
```

新增 shared schema/types：

```text
packages/shared/src/schemas/world-data.ts
packages/shared/src/types/world-data.ts
```

## Phase A：Shared schema 与 plugin dataSchemas

负责人：Worker A

### 修改文件

- `packages/shared/src/schemas/world.ts`
- `packages/shared/src/types/world.ts`
- `packages/shared/src/schemas/world-data.ts` 新增
- `packages/shared/src/types/world-data.ts` 新增
- `packages/shared/src/schemas/plugin.ts`
- `packages/shared/src/types/plugin.ts`
- `packages/shared/src/index.ts`
- `packages/plugin-loader/src/types.ts`
- `packages/plugin-loader/src/parse-plugin-md.ts` 如需要
- `apps/server/src/routes/api/bootstrap.ts` 或 plugin registry 构造点

### 冻结接口

Worker A 需要先产出这些共享接口，供 C/D/E 对齐：

- `WorldDataDescriptor`
- `WorldDataSourceDescriptor`
- `WorldDataMetadataSummary`
- `PluginDataSchemasRegistry`
- `PluginDataSchemaNamespace`

### 实现内容

1. `worldManifestSchema` 增加：

```ts
worldData: z.string().min(1).optional();
```

2. 新增 world data descriptor schema：

- `schemaVersion: z.literal(1)`
- `sources: z.record(sourceIdRegex, sourceSchema)`
- source kind enum
- `path` string
- `schema` string optional
- `to` string 初步校验
- `indexTo` string 初步校验
- `key` string optional
- `enabled` boolean optional
- `locale` string optional
- `after` string 或 string[]
- `merge: replace | skipExisting`
- `effects: characters[]`

3. plugin manifest 支持 `dataSchemas`。v1 实现允许写在 `PLUGIN.md` frontmatter，但 loader 合并为 plugin-level registry。

4. `PluginRegistryEntry` 增加 plugin-level dataSchemas 结果，例如：

```ts
dataSchemas?: PluginDataSchemasRegistry
```

5. 多 runtime 合并规则：

- 同 namespace 内容一致：通过
- 同 namespace 内容冲突：fail closed，插件加载报错；不要 pick one，不要只 warning 后继续

### 测试

- `worldManifestSchema` 接受 `worldData`
- `worldDataDescriptorSchema` 接受合法示例
- 非法 source id 被拒绝
- 非法 kind / merge / effects 被拒绝
- `after` 类型校验
- `PLUGIN.md` 接受 `dataSchemas`
- 多 runtime 冲突测试

## Phase B：Store provenance ledger

负责人：Worker B

### 修改文件

- `packages/store/src/types.ts`
- MemoryStore
- IdbStore
- SqliteStore schema/mapper/store
- PgStore schema/mapper/store
- `packages/store/src/contract/store-contract.ts`

### 新增类型

```ts
export interface WorldDataImportLedgerRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly target: string;
  readonly pluginId?: string;
  readonly namespace?: string;
  readonly key?: string;
  readonly sourceWorldId: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly valueHash: string;
  readonly schemaRef?: string;
  readonly derivedFrom?: string;
  readonly importedAt: string;
  readonly managed: boolean;
}
```

### 新增 DataStore 方法

```ts
saveWorldDataImportLedgerBatch(records: readonly WorldDataImportLedgerRecord[]): Promise<void>;
listWorldDataImportLedger(sessionId: string): Promise<readonly WorldDataImportLedgerRecord[]>;
```

可选：

```ts
deleteWorldDataImportLedger(sessionId: string, filter?: { target?: string; key?: string }): Promise<void>;
```

### 测试

- batch save + list
- session isolation
- transaction rollback 覆盖 ledger 写入
- sqlite/pg schema migration 或初始化表存在

## Phase C：World load importer

负责人：Worker C

### 修改文件

- `apps/server/src/world-data/*`
- `apps/server/src/world-seed-loader.ts`
- `apps/server/src/world-file-watcher.ts`
- server tests

### 实现内容

1. `safe-path.ts`

实现 `resolveContainedPath(root, relativePath)`：

- 拒绝绝对路径
- 拒绝 `..` escape
- 使用 `realpath` containment
- symlink 目标必须仍在 root 内；也可以 v1 直接拒绝 symlink

2. `descriptor.ts`

- 读取 `world.data.yaml`
- 查找 override：`<covelHome>/world-overrides/<world-id>/world.data.override.yaml`
- 合并 descriptor
- 保留 source 顺序
- 被 override 的 source 保留原位置
- override 新增 source 追加到末尾
- `enabled: false` 跳过
- path/schema 字段保留 provenance root：world root 或 override root

3. `source-order.ts`

- YAML 声明顺序
- `after` 拓扑排序
- tie-breaker 使用合并声明顺序
- missing/cycle 生成 error diagnostic

4. `target-uri.ts`

解析并验证：

- `world:metadata.<path>`
- `plugin:<pluginId>/<namespace>`
- `plugin:<pluginId>/<namespace>+lorebook`
- `lorebook`
- `characters`
- `media`
- `indexTo` 只允许 `plugin:<pluginId>/<namespace>`

禁止 metadata path 段：

- `__proto__`
- `constructor`
- `prototype`

5. `source-reader.ts`

- YAML/JSON parse 为 JSON value
- markdown/text 为 string
- 文件大小限制
- diagnostics 包含 source id/path/schema/pointer/message

6. `media.ts`

world load 阶段只扫描摘要：

- 一层目录
- 跳过隐藏文件
- 稳定排序
- 计算 digest/size
- MIME sniff/allowlist diagnostic

7. `world-load.ts`

- 生成 `WorldDataMetadataSummary`
- 只保存 source id、digest、target、schema、importedAt、order、origin/overridden、diagnostic counts
- 可额外保存轻量统计：media count/bytes、source kind；不保存媒体 bytes 或大 value
- `world:metadata.dimensions` 继续投影到 `WorldRecord.metadata.dimensions`，保证 world-init 兼容
- 不保存大 source value
- world load 对 `plugin://` schema 只在插件 registry 已可用时校验；不可用时记录 warning，session import 必须重新校验并可 hard-fail

8. `legacy.ts`

- `dimensions` / `dimensionSources` 转成 synthetic source summary
- `characterBlueprintSources` 转成 synthetic source summary
- 声明 `worldData` 的世界走统一 source 导入
- `characterBlueprintSources` 仅服务旧世界包

### 测试

- path traversal / absolute path / symlink escape
- override root containment
- source order / after / cycle
- key literal vs extractor 规则
- metadata path prototype pollution 拒绝
- worldData summary 不含大 value
- media directory scan 稳定
- 旧 worlds 仍能加载
- 同时声明 `worldData` 与 `characterBlueprintSources` 的世界会跳过旧角色卡 eager-load

## Phase D：Session importer 与 API 集成

负责人：Worker D

### 修改文件

- `apps/server/src/world-data/session-import.ts`
- `apps/server/src/routes/api/session.ts`
- `apps/server/src/routes/api/bootstrap.ts`
- `apps/server/src/app.ts`
- server API tests

### 实现内容

当前状态：Phase C 已完成 world-load summary、override root、本地 source 读取和 `world:metadata.dimensions` 投影；Phase D 已完成 session 创建阶段的通用 importer，支持 `plugin:*/*`、`plugin:*/*+lorebook`、`lorebook`、`characters`、`media + indexTo`、ledger、preflight 和 transaction rollback。`POST /api/worlds/:id/world-data/preflight` 已提供只读预检入口。

1. 注入 `WorldPackageResolver` / `WorldDataImporter`

session import 需要能按 `worldId` 找到 world root，不能依赖 `WorldRecord.metadata.worldData` 里的大数据。具体 wiring：在 `apps/server/src/app.ts` 中先计算 `bundledWorldsDir`、`userWorldsDir`、`worldsDirs`、`covelHome`，再调用 `bootstrapApi({ ..., worldsDirs, covelHome })` 或传入已构造的 `WorldPackageResolver`。resolver 搜索 `worldsDirs/<world-id>/world.yaml` 并校验 manifest id，用户 worlds 应覆盖 bundled worlds。

2. session 创建流程改为：

```text
compute final plugin set
rebuild full import plan from descriptor/source
preflight plugin targets and dataSchemas
preflight duplicate keys / merge
preflight media allowlist / size / digest
beginTx
  createSession
  write plugin_data
  write lorebook_entries
  upsert characters
  write media index plugin_data
  write ledger per committed row
commitTx
MediaStore.recordOwnership()
MediaStore.addRef()
activate plugins
```

3. plugin target 校验

`to` 和 `indexTo` 都必须校验：

- plugin installed
- plugin in final session plugin set
- namespace exists in plugin-level dataSchemas
- `acceptsWorldData: true`

4. key 规则

- YAML/JSON：`key: id` / `characterId` 提取字段
- Markdown/Text：`key` 是 literal
- Media：`filename` 使用完整 basename，包含扩展名；也可使用 literal

5. merge 规则

- same source duplicate key：error
- cross-source same target/key：按最终 source 顺序 replace，warning
- `skipExisting`：同次 import 已有或 session store 已有时跳过
- sync 时 provenance/conflict 优先于 merge

6. ledger

每个 session import 实际 store row 一条 ledger：

- plugin-data
- lorebook
- character
- media index

world load 阶段写入的 `WorldRecord.metadata.worldData` 不进入 session-scoped ledger；它的 provenance 由 summary 的 digest/origin/overridden 表达。若未来需要 world-scoped sync，再另设 world-scoped ledger。

7. media failure policy

- `put()` 失败：DataStore transaction 回滚，不创建 session
- `recordOwnership()` / `addRef()` 失败：执行补偿 rollback：删除刚创建的 session（级联删除或显式删除 plugin_data/lorebook/characters/ledger），清理 importer 新建且未被其他 session 引用的 media asset，不激活插件，返回 error diagnostic。v1 不实现 pending retry 状态；后续如需要再引入 import_failed/session retry。

### 测试

- missing plugin -> session not created
- plugin not selected -> session not created
- namespace lacks `acceptsWorldData` -> rejected
- `indexTo` 无 dataSchemas -> rejected
- transaction rollback 不留下 session/plugin_data/ledger
- `plugin:*+lorebook` 双写
- `effects: [characters]` 创建 character
- media put + indexTo + addRef 后 media-token 可访问
- no new hardcoded gameplay plugin IDs

## Phase E：插件 schemas 与 v1 fixture

负责人：Worker E

### 修改文件

- `plugins/character-blueprint/PLUGIN.md`
- `plugins/character-blueprint/schemas/*.schema.json`
- `plugins/character-presence/PLUGIN.md`
- `plugins/character-presence/schemas/*.schema.json`
- `plugins/living-world-rules/PLUGIN.md`
- `plugins/living-world-rules/schemas/*.schema.json`
- `plugins/char-creator/runtimes/*/PLUGIN.md`
- `plugins/char-creator/schemas/*.schema.json`
- 一个小型 v1 world fixture

### 实现内容

- 为优先插件声明 `dataSchemas`
- JSON Schema `$ref` 仅使用同文件 fragment；不要引入 remote/file `$ref`
- schema 和 handler 接受范围保持一致
- handler tests 增加 importer-accepted payload
- bundled worlds 使用 `worldData` v1 descriptor；Haruka Academy 作为含角色卡的 v1 fixture

### 注意

`character-presence/assets` 是否作为新 namespace 需要和插件当前 handler/UI 对齐。如果现有只有 `presence`，要么新增 `assets` dataSchema，要么示例改为现有 namespace。

## Phase F：文档同步

负责人：Worker E 或单独 docs worker

代码落地时同步更新：

- `devs/docs/world-package-spec.md`
- `docs/reference/plugins.md`
- `docs/guide/plugin-authoring.md`
- `docs/reference/transactions.md`
- 如有 API：`docs/reference/api.md`
- 如有协议/SSE：`docs/reference/protocol.md`
- 如有 UI：`docs/reference/ui-panels.md`

## 并行执行方案

### 推荐 subagent 拆分

```text
Worker A: shared schema + plugin-loader dataSchemas
Worker B: store ledger
Worker C: world-load importer
Worker D: session importer/API integration
Worker E: plugin schemas + fixture + docs
Reviewer 1: correctness/regression review
Reviewer 2: security/isolation review
Reviewer 3: tests/docs review
Fix Worker: apply synthesized review fixes
```

### 依赖关系

```text
A -> C, D, E
B -> D
C -> D
E -> D integration tests
D -> reviewers
```

可并行启动：

- A 和 B 可以立即并行。
- C 可以在 A 的 schema 稳定前用内部临时类型开发，但合并前要对齐 A。
- D 等 A/B/C 输出接口稳定后启动。
- E 可在 A 的 `dataSchemas` 形状稳定后启动。

### 使用 worktree 的建议

如果真的让多个 worker 改代码，建议使用 subagent worktree 模式，避免并发写同一工作区。拆分时尽量避免同一文件冲突：

- A 改 shared/plugin-loader
- B 改 store
- C 改 server world-data loader
- D 改 session/bootstrap/app
- E 改 plugins/world fixture/docs

主 agent 最后负责合并 worktree diff，解决交叉接口冲突。

## Review 与合并流程

1. Worker A/B/C/E 并行完成。
2. 主 agent 合并 A/B/C/E 的接口，跑 targeted tests。
3. Worker D 基于合并后的接口实现 session import。
4. 跑完整 targeted tests：

```bash
pnpm --filter @covel/shared test -- --run
pnpm --filter @covel/plugin-loader test -- --run
pnpm --filter @covel/store test -- --run
pnpm --filter @covel/server test -- --run
pnpm lint
```

5. 启动 3 个 fresh reviewer：

- correctness/regression
- security/framework-plugin isolation
- tests/docs completeness

6. 主 agent synthesis review findings。
7. Fix Worker 只修“必须现在修”的问题。
8. 再跑 targeted tests + `pnpm lint`。
9. 最终总结：改了什么、验证了什么、遗留什么。

## 风险与决策点

### 1. 旧 `characterBlueprintSources` 完全兼容

旧 importer 硬编码 `character-blueprint` / `char-creator`。v1 的通用 plugin target 路径通过 target URI 和 `dataSchemas` 工作；`effects: [characters]` 是框架级兼容映射，用来把角色蓝图投影到 session characters，并镜像到当前 session 已启用、且声明 `dataSchemas.characters.acceptsWorldData: true` 的插件。

决策：legacy shim 只服务没有 `worldData` 的旧世界包。只要 world 声明了 `worldData`，就必须走新 generic importer；同时禁止 v1 source 写入 `world:metadata.characterBlueprints` 来触发旧 shim。后续 phase 再用 data-driven mirror/capability 完全移除 legacy shim。

### 2. `dataSchemas` 放置位置

v1 先放 `PLUGIN.md` frontmatter，loader 合并为 plugin-level registry。后续如果 plugin package manifest 成熟，再迁移到包级文件。

### 3. MediaStore 非事务

固定顺序为：preflight media -> DataStore transaction 内 put/index -> commit -> recordOwnership/addRef -> success。授权失败时 v1 做补偿删除刚创建的 session、清理 importer 新建 media，并返回失败，不实现 pending retry path。

### 4. Sync

`POST /api/worlds/:id/sync-data` 已落地。接口默认 dry-run，基于 `world_data_import_ledger` 只处理 importer 管理的数据：

- `managed=true`
- `sourceWorldId` 等于当前 world
- 当前目标 row 的 hash 与 ledger `valueHash` 一致

当目标 row 被玩家或插件修改时返回 `conflicts.reason = "modified"`；当目标 row 缺失时返回 `conflicts.reason = "missing"`。传 `dryRun:false` 执行写入，传 `force:true` 允许覆盖冲突。media index 删除会清理对应 importer-managed media ref。

开始游戏前的 Web UI 已接入 `POST /api/worlds/:id/world-data/preflight`，会随插件选择展示计划写入、目标摘要和 diagnostics。更复杂的 conflict resolution UI 留给后续 session 内管理界面。

## 最小验收标准

- 旧世界包仍能加载。
- 新 v1 fixture world 能加载并生成轻量 `metadata.worldData`。
- session 创建前完成 world data import。
- plugin-data target 受 dataSchemas 保护。
- media source 能 put/index/addRef 并通过 media-token 访问。
- 每个实际写入 row 都有 ledger。
- 没有新增 framework 对具体玩法 plugin ID 的硬编码。
- `/sync-data` dry-run、apply、modified conflict 有 API 覆盖。
- 开始游戏前插件选择区展示 worldData preflight 结果。
- targeted tests 和 `pnpm lint` 通过。

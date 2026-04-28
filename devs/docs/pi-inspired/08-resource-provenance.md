# 08 · Resource provenance / sourceInfo

> **状态**：P0 proposed · 2026-04-27 结合代码库起草
> **借鉴源**：pi-mono `sourceInfo`（commands/tools/resources 的 path/source/scope/origin）
> **影响范围**：`@covel/plugin-loader` registry/types · server bootstrap · plugin/tool/UI debug surfaces · future package/filtering · docs/reference/plugins.md
> **外部依赖**：无

---

## § 0.0 当前评审结论

（待入。本节预留，外部评审落地后将原文引用 + 在正文加 `评审 #N 修正` marker。）

---

## § 0 为什么写这份文档

Covel 已经有 trust/source 的雏形，但还没有像 pi 一样把“资源从哪里来”贯穿到 runtime/tool/UI/debug。

pi 的工具/命令/资源会暴露 `sourceInfo`，例如：

```ts
{
  name: 'read',
  sourceInfo: {
    path: '<builtin:read>',
    source: 'builtin',
    scope: 'temporary',
    origin: 'top-level',
    baseDir: undefined,
  }
}
```

这对 Covel 更重要，因为 Covel 有：

- `builtin / official / community` trust source；
- core plugin vs optional plugin；
- session `activePlugins`；
- world manifest seeding；
- plugin local tools；
- UI specs；
- future package filtering；
- approval policy；
- debug/traces。

当前代码已经有一部分基础，但没有形成统一 provenance 模型。

---

## § 1 现状盘点

### 1.1 Discovery 已带 source/rootPath

`packages/plugin-loader/src/types.ts`：

```ts
export interface PluginDiscoveryResult {
  readonly id: string;
  readonly rootPath: string;
  readonly isMultiRuntime: boolean;
  readonly pluginMdPaths: readonly string[];
  readonly source?: PluginSource;
}

export type PluginSource = 'builtin' | 'official' | 'community';
```

注释已经说明：外部目录 discover 的 plugin 会被标成 `community`，避免用户自造 `core-evil` 伪装 builtin。

### 1.2 RegistryEntry 已带 source，但 runtime view 丢失 provenance

`PluginRegistryEntry`：

```ts
export interface PluginRegistryEntry {
  readonly id: string;
  readonly summary: PluginSummary;
  readonly manifest?: ParsedPluginMd;
  readonly manifests?: readonly ParsedPluginMd[];
  readonly loadedRuntimes: ReadonlyMap<string, LoadedRuntime>;
  readonly status: PluginEntryStatus;
  readonly error?: string;
  readonly source?: PluginSource;
}
```

但 `PluginRegistry.getActiveRuntimes(sessionId)` 返回：

```ts
readonly RuntimeManifest[]
```

`RuntimeManifest` 是 plugin 自报 manifest + loader 派生 `pluginId`，不包含：

- rootPath；
- PLUGIN.md path；
- source；
- package name/version；
- scope；
- loadedBy；
- filter decision。

因此下游只知道 runtime 叫什么，不知道它从哪里来。

### 1.3 Tool/UI 也缺统一来源

`RuntimeManifest.tools.local` 只是相对路径；`RuntimeManifest.ui` 也是相对路径。bootstrap 会建立 tool access，但 debug/API 很难回答：

- 这个 tool 来自哪个 plugin root？
- 是 builtin tool 还是 plugin local tool？
- local tool 是 community plugin 提供的吗？
- UI panel 是哪个 package/world 激活的？
- filter 为什么 include/exclude 了它？

---

## § 2 设计目标

1. 定义统一 `ResourceProvenance`，覆盖 plugin/runtime/tool/UI/prompt/world/package。
2. provenance 由 loader/registry/server 生成，不信任 plugin 自报。
3. 保留现有 `RuntimeManifest` 纯 manifest 角色，不把 provenance 混进去。
4. 新增 registry view API，在不破坏 `getActiveRuntimes()` 的前提下提供 provenance。
5. 为 #05 filtering、#13 package manifest、approval/debug UI 打地基。
6. 强化框架 ↔ 插件分离：框架通过 provenance/source/capability 判断通用治理规则，而不是通过插件 ID 或路径猜业务含义。

---

## § 3 边界（Non-goals）

- 不在 P0 实现 package manager。
- 不改变 trust 判定策略，只把已有 source/rootPath 结构化贯穿。
- 不把 provenance 写入 plugin-authored PLUGIN.md。
- 不要求所有 API 立刻返回 provenance；P0 先在 registry/runtime/tool debug 层可用。
- 不做权限决策重构；approval/tool scope 后续可读取 provenance。
- 不把 provenance 当业务类型系统使用：`source/community/path` 只能回答“资源从哪里来”，不能让框架推断“这是 narrator/codex/inventory”。业务能力仍通过 manifest `capabilities` / `outputKind` / proposal type 声明。

---

## § 4 总体架构

新增 loader-owned 类型：

```ts
export interface ResourceProvenance {
  readonly source: PluginSource;          // builtin | official | community
  readonly rootPath: string;              // plugin/package root
  readonly manifestPath?: string;         // concrete PLUGIN.md
  readonly resourcePath?: string;         // tool/ui/prompt concrete file
  readonly scope: 'builtin' | 'world' | 'user' | 'dev';
  readonly origin: 'top-level' | 'package' | 'world-manifest';
  readonly loadedBy: 'server-startup' | 'world-manifest' | 'session-activate' | 'dev-reload';
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly packageSource?: string;        // npm/git/local/path later
  readonly worldId?: string;
}
```

新增 view 类型：

```ts
export interface RuntimeRegistryView {
  readonly manifest: RuntimeManifest;
  readonly provenance: ResourceProvenance;
}

export interface ToolRegistryView {
  readonly name: string;
  readonly kind: 'builtin' | 'local';
  readonly ownerPluginId?: string;
  readonly ownerRuntimeId?: string;
  readonly provenance: ResourceProvenance;
}

export interface UiSpecRegistryView {
  readonly slot: 'right' | 'message' | 'left';
  readonly ownerPluginId: string;
  readonly ownerRuntimeId?: string;
  readonly path: string;
  readonly provenance: ResourceProvenance;
}
```

---

## § 5 详细设计

### 5.1 RegistryEntry 持有 base provenance

**当前问题**

`PluginRegistryEntry.source` 只有 trust source，没有 rootPath/manifestPath/scope/origin。

**提议方案**

扩展：

```ts
export interface PluginRegistryEntry {
  ...
  readonly source?: PluginSource;
  readonly provenance?: ResourceProvenance;
}
```

`provenance.source` 与 `source` 保持一致；短期保留 `source` 兼容旧调用。

### 5.2 ParsedPluginMd 记录 file path

**当前问题**

`ParsedPluginMd` 有 `referenceLinks`、`rawFrontmatter`，但没有 `filePath`。`PluginDiscoveryResult.pluginMdPaths` 有路径，但 parse 后 runtime view 不带。

**提议方案**

新增：

```ts
export interface ParsedPluginMd {
  readonly manifest: RuntimeManifest;
  readonly promptTemplate: string;
  readonly referenceLinks: readonly string[];
  readonly rawFrontmatter: Readonly<Record<string, unknown>>;
  readonly filePath?: string;
}
```

如果不想改 parser，可以在 registry view 构造时通过 `PluginDiscoveryResult.pluginMdPaths` 与 manifests 顺序配对。

### 5.3 新增 `getActiveRuntimeViews()`

保持旧 API：

```ts
getActiveRuntimes(sessionId): readonly RuntimeManifest[]
```

新增：

```ts
getActiveRuntimeViews(sessionId): readonly RuntimeRegistryView[]
```

排序与旧 API 一致。

server 可以逐步迁移：

- `actions.ts` 仍用 old manifest list；
- debug/plugins API 用 new view；
- tool approval/logging 可读取 provenance。

### 5.4 Tool provenance

builtin tool provenance：

```ts
{
  source: 'builtin',
  rootPath: '<builtin>',
  resourcePath: '<builtin:plugin-data-set>',
  scope: 'builtin',
  origin: 'top-level',
  loadedBy: 'server-startup'
}
```

local tool provenance：

```ts
{
  ...plugin.provenance,
  resourcePath: path.resolve(pluginRoot, relativeToolPath)
}
```

这能支撑：

- approval UI 显示“community plugin X 提供 local tool Y”；
- trace 记录 tool source；
- #05 tool filtering。

### 5.5 UI spec provenance

UI specs 当前由 manifest `ui.right/message/left` 指向相对路径。建议聚合 `/api/ui-specs` 时带：

```json
{
  "pluginId": "npc-graph",
  "slot": "right",
  "path": "./ui/npc-graph-panel.json",
  "provenance": {...}
}
```

前端 debug 面板可显示来源，但普通玩家 UI 可隐藏。

### 5.6 激活来源 loadedBy

当前 session activation 只存：

```ts
activePlugins: string[]
```

P0 可以先粗略：

- builtin/core auto load → `server-startup`
- session create world seeded → `world-manifest`
- manual enable API → `session-activate`
- dev reload → `dev-reload`

如果需要精确持久化，后续扩展 session plugin scope 结构。

---

## § 6 迁移计划

### P0-a · 类型加法

- `packages/plugin-loader/src/types.ts` 加 `ResourceProvenance` / `RuntimeRegistryView`。
- `PluginRegistryEntry` 加 optional `provenance`。
- 不破坏旧 API。

### P0-b · Registry view

- `PluginRegistry` 增 `getActiveRuntimeViews(sessionId)`。
- `getActiveRuntimes()` 保持从 views map manifest。
- tests 覆盖 source/rootPath 透传。

### P0-c · Server debug/API 消费

- plugins/session API 返回 provenance（至少 debug 字段）。
- tool registry/approval trace 可选带 provenance。
- UI specs 聚合可选带 provenance。

### P1 · Filtering/package 使用

- #05 runtime/tool/UI filtering 读取 `ResourceProvenance`。
- #13 package manifest 使用 packageName/packageVersion/packageSource。

---

## § 7 风险 / Tradeoffs

| 风险 | 缓解 |
|---|---|
| provenance 泄漏服务器绝对路径给普通玩家 | API 区分 debug/admin view；普通 UI 不显示 `rootPath/resourcePath` |
| 类型加太多但短期不用 | P0 只加 registry view + debug consumption，不强制所有路径迁移 |
| manifestPath 与 multi-runtime 顺序配对错误 | 在 parser 层记录 `filePath` 更稳 |
| source 与 provenance.source 双字段漂移 | `source` 作为兼容字段，写入时由 provenance 派生，后续废弃 |

---

## § 8 是否必须现在做？

建议 P0。原因：#05 filtering、#13 package、approval UI、debug traces 都依赖“资源来自哪里”。当前已有 `PluginSource/rootPath`，现在补全成本低；等 package/filtering 做完再补，会形成多套临时来源字段。

---

## § 9 待决问题

1. `ParsedPluginMd` 是否直接加 `filePath`？倾向是。
2. `scope` 枚举是否需要 `project` / `global`？Covel 当前不是 pi 的 CLI project/global 模型，先用 builtin/world/user/dev。
3. 普通 API 是否返回路径？倾向 debug/admin 才返回绝对路径。
4. provenance 是否持久化到 DB？P0 不持久化；snapshot/export 可后续带。

---

## § 10 下一步

1. 在 `plugin-loader/types.ts` 加类型。
2. 在 registry 实现 `getActiveRuntimeViews()`。
3. 更新 plugins API/debug surface 返回 provenance。
4. 写 #05 filtering 设计时强制依赖本提案。

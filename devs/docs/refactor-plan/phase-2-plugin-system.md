# Phase 2: 插件加载与注册系统

> 预计工作量：3-4 天
> 前置依赖：Phase 1（类型系统、PLUGIN.md 解析器）
> 交付物：完整的插件发现、加载、注册、生命周期管理

---

## 2.1 目标

实现插件的完整生命周期：发现 → 渐进式加载 → 注册 → 激活/去激活 → 热重载。

## 2.2 插件发现（Plugin Discovery）

### 2.2.1 目录扫描

```typescript
// @covel/plugin-loader

export interface PluginDiscoveryResult {
  /** 插件 ID（目录名） */
  id: string;
  /** 插件根目录路径 */
  rootPath: string;
  /** 是否为多 Runtime 插件 */
  isMultiRuntime: boolean;
  /** 发现的 PLUGIN.md 路径列表 */
  pluginMdPaths: string[];
}

/**
 * 扫描插件目录，返回所有发现的插件。
 * 仅读取目录结构，不解析文件内容（极轻量）。
 */
export function discoverPlugins(
  pluginsDir: string,
): Promise<PluginDiscoveryResult[]>;
```

### 2.2.2 发现逻辑

```
pluginsDir/
  ├── my-story-plugin/
  │   └── PLUGIN.md              → 单 Runtime 插件
  ├── image-workflow-demo/
  │   ├── PLUGIN.md              → 插件级说明
  │   └── runtimes/
  │       ├── prompt-optimizer/
  │       │   └── PLUGIN.md      → Runtime 1
  │       └── image-generator/
  │           └── PLUGIN.md      → Runtime 2
  └── disabled-plugin/
      └── PLUGIN.md.disabled     → 被禁用，跳过
```

规则：

1. 每个子目录是一个插件候选
2. 如果根目录有 `runtimes/` 子目录 → 多 Runtime 插件
3. 如果根目录直接有 `PLUGIN.md` 且无 `runtimes/` → 单 Runtime 插件
4. `.disabled` 后缀的文件被跳过

## 2.3 渐进式加载（Progressive Loading）

参考 Agent Skills 的三层加载策略：

### Level 0: 轻量发现（框架启动时）

仅加载 `name` + `description`，用于判断插件是否应被激活：

```typescript
export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  pluginType: PluginType;
  runtimeCount: number;
}

/**
 * 快速加载插件摘要（仅读取 frontmatter 的 name/description）。
 * 不解析完整 manifest，不读取 Markdown body。
 */
export function loadPluginSummary(
  discovery: PluginDiscoveryResult,
): Promise<PluginSummary>;
```

### Level 1: Manifest 加载（插件激活时）

加载完整的 frontmatter manifest：

```typescript
/**
 * 加载完整的插件 manifest（所有 frontmatter 字段）。
 * 不加载 Markdown body 和 references。
 */
export function loadPluginManifest(
  discovery: PluginDiscoveryResult,
): Promise<PluginManifest>;
```

### Level 2: 完整加载（Runtime 执行时）

加载 Markdown body（prompt template）和按需加载 references：

```typescript
export interface LoadedRuntime {
  manifest: RuntimeManifest;
  promptTemplate: string;
  references: ParsedReference[];
  outputSchema?: Record<string, unknown>; // JSON Schema
  toolModules: ToolModule[]; // 已加载的工具模块
}

/**
 * 完整加载 Runtime 的所有资源。
 * 仅在 Runtime 即将执行时调用。
 */
export function loadRuntime(
  discovery: PluginDiscoveryResult,
  runtimeName: string,
): Promise<LoadedRuntime>;
```

## 2.4 插件注册表（Plugin Registry）

```typescript
// @covel/plugin-loader

export interface PluginRegistryEntry {
  id: string;
  summary: PluginSummary;
  manifest?: PluginManifest; // Level 1 后可用
  loadedRuntimes: Map<string, LoadedRuntime>; // Level 2 后逐步填充
  status: "discovered" | "registered" | "active" | "disabled" | "error";
  error?: string;
}

export interface PluginRegistry {
  /** 注册插件 */
  register(entry: PluginRegistryEntry): void;

  /** 获取所有已注册插件 */
  getAll(): ReadonlyMap<string, PluginRegistryEntry>;

  /** 按 ID 获取 */
  get(id: string): PluginRegistryEntry | undefined;

  /** 获取所有活跃的 Runtime（按 priority 排序） */
  getActiveRuntimes(sessionId: string): RuntimeManifest[];

  /** 激活/去激活插件 */
  activate(pluginId: string, sessionId: string): void;
  deactivate(pluginId: string, sessionId: string): void;

  /** 订阅注册表变更 */
  onChange(handler: (event: RegistryChangeEvent) => void): () => void;
}

export type RegistryChangeEvent =
  | { type: "plugin-registered"; pluginId: string }
  | { type: "plugin-activated"; pluginId: string; sessionId: string }
  | { type: "plugin-deactivated"; pluginId: string; sessionId: string }
  | { type: "plugin-reloaded"; pluginId: string }
  | { type: "plugin-error"; pluginId: string; error: string };
```

## 2.5 Session 级别的插件作用域

```typescript
export interface SessionPluginScope {
  sessionId: string;
  /** 当前 session 激活的插件 ID 集合 */
  activePluginIds: Set<string>;
  /** 插件配置覆盖（玩家配置） */
  configOverrides: Map<string, Record<string, unknown>>;

  /** 启用插件 */
  enable(pluginId: string): void;
  /** 禁用插件 */
  disable(pluginId: string): void;
  /** 获取 Runtime 的有效配置（默认值 + 覆盖） */
  getEffectiveConfig(
    pluginId: string,
    runtimeId: string,
  ): Record<string, unknown>;
}
```

## 2.6 插件分类与信任级别

```typescript
export type PluginSource = "builtin" | "official" | "community";

export interface PluginTrustInfo {
  source: PluginSource;
  /** 工具调用是否需要审批 */
  requiresApproval: boolean;
  /** 是否自动加载 */
  autoLoad: boolean;
}

/**
 * 内置插件 → 自动加载，工具免审批
 * 官方插件 → 自动加载，工具免审批
 * 社区插件 → 需确认安装，工具需审批
 */
export function getPluginTrustInfo(
  pluginId: string,
  source: PluginSource,
): PluginTrustInfo;
```

## 2.7 热重载

```typescript
export interface PluginWatcher {
  /** 开始监听插件目录 */
  start(pluginsDir: string): void;
  /** 停止监听 */
  stop(): void;
  /** 订阅文件变更事件 */
  onFileChange(handler: (event: FileChangeEvent) => void): () => void;
}

export interface FileChangeEvent {
  type: "created" | "modified" | "deleted";
  pluginId: string;
  filePath: string;
}
```

热重载规则：

1. 监听 `plugins/` 目录的文件变更（使用 `chokidar` 或 Node.js `fs.watch`）
2. 文件变更时重新解析对应的 PLUGIN.md
3. 如果 manifest 变更，更新注册表
4. 当前正在执行的 Turn 不受影响（等待完成后生效）
5. 通过 `PluginRegistry.onChange` 事件通知 session 更新

## 2.8 验收标准

- [ ] 三种插件形态（最简/标准/多 Runtime）均可正确发现和加载
- [ ] 渐进式加载三个级别工作正常
- [ ] 插件注册表支持 CRUD 操作
- [ ] Session 级别的插件作用域可独立管理
- [ ] 热重载可检测文件变更并更新注册表
- [ ] core-plugin 类型不可被用户禁用
- [ ] 单元测试覆盖率 ≥ 80%

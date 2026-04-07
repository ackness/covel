# Phase 4: PluginManager（加载、注册表、热重载）

依赖：Phase 1-3  
包名：`@covel/plugin-manager`  
预计产出：`packages/plugin-manager/`

## 目标

管理插件发现、runtime 注册、tool 注册、导入解析、启停和热重载。

V1 里的 PluginManager 不再围绕 `server/index.ts`、hook 注册、context provider 注入来设计，而是围绕：

- `plugin.json`
- `runtimes/*/runtime.json`
- `tools/`
- `scripts/`
- `references/`

## 1. PluginManager 接口

```typescript
interface PluginManager {
  loadAll(baseDir: string): Promise<PluginLoadResult[]>;
  load(pluginDir: string): Promise<PluginLoadResult>;
  reload(pluginId: string): Promise<void>;
  unload(pluginId: string): Promise<void>;

  enable(pluginId: string, sessionId: string): Promise<void>;
  disable(pluginId: string, sessionId: string): Promise<void>;

  list(): PluginInfo[];
  get(pluginId: string): PluginInfo | undefined;

  readonly registries: PluginRegistries;
}

interface PluginRegistries {
  plugins: PluginRegistry;
  runtimes: RuntimeRegistry;
  tools: ToolRegistry;
}
```

## 2. 加载过程

### 2.1 扫描规则

1. 读取 `plugin.json`
2. 读取 `runtimeIds`
3. 逐个读取 `runtimes/<runtime-id>/runtime.json`
4. 读取每个 runtime 的：
   - `llm.toml`
   - `instructions.md`
   - `output.schema.json`
   - `tools/`
   - `scripts/`
   - `references/`

### 2.2 注册结果

框架需要注册：

- 插件基本信息
- runtime 基本信息
- local tools
- exported tools
- tool import dependency graph

## 3. ToolRegistry

```typescript
interface ToolRegistry {
  register(definition: ResolvedToolDefinition): void;
  unregisterByPlugin(pluginId: string): void;
  resolveForRuntime(pluginId: string, runtimeId: string): ResolvedToolDefinition[];
  getQualified(id: string): ResolvedToolDefinition | undefined;
}
```

### 3.1 解析规则

- `tools/` 下每个文件都要被解析出 metadata
- `exported: true` 的 tool 才能对外提供
- 外部 runtime 必须显式声明 `toolImports`
- 导出方和导入方缺一不可

## 4. 启停规则

### `core-plugin`

- 默认启用
- 玩家不能主动关闭

### 普通 `plugin`

- 可按 session 启用 / 禁用

## 5. 热重载

V1 的热重载必须采用 generation 模型，而不是“清缓存然后重新 import”这么简单。

### 5.1 规则

- 每次 reload 产生新的 `generationId`
- 新触发只使用新 generation
- 旧 generation 的 in-flight runtime 允许跑完并提交
- 同一次调度里不混用新旧 generation

### 5.2 reload 流程

```typescript
async function reload(pluginId: string): Promise<void> {
  const previous = registry.get(pluginId);
  const nextGenerationId = createGenerationId();

  // 1. 重新扫描并解析插件目录
  const next = await loadPluginDefinition(pluginId, nextGenerationId);

  // 2. 原子替换 registry 中的“当前 generation”
  registry.swap(pluginId, next);

  // 3. 标记旧 generation 为 draining
  registry.markDraining(pluginId, previous.generationId);

  // 4. 等待旧 generation 的 in-flight runtime 自然完成
  // 5. 清理旧 generation 的订阅、缓存和引用
}
```

### 5.3 授权兼容

授权记录是 `session + plugin + tool` 维度，不跟 runtime generation 绑定，因此：

- 热重载后原授权继续有效

## 6. 失败容错

- 单个插件加载失败不应阻塞其他插件
- 单个 runtime 解析失败可标记该 runtime 不可用，但插件其余 runtime 可继续加载
- tool schema 解析失败时，至少应阻止该 tool 对外注入

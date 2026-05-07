# World Package 规格文档

时间：2026-04-03
状态：草案 v1

## 1. 概述

将硬编码的种子世界系统（`seed-worlds.ts` + `seed-world-dimensions.ts`）重构为基于文件的 **World Package** 目录格式，对齐 Plugin 的 `plugin.json + PLUGIN.md` 模式。

### 1.1 设计目标

- 世界作为独立目录包发布，非硬编码 TypeScript
- 全面支持 i18n（内置世界至少支持 zh-CN + en-US）
- 普通玩家可通过 UI/LLM 创建世界，无需接触代码
- 创作者/MOD 作者可手写 YAML + Markdown 文件
- 提供 `extract-dimensions` 兼容层：从自然语言 lore 自动提取结构化维度

### 1.2 术语

| 术语              | 含义                                                           |
| ----------------- | -------------------------------------------------------------- |
| **World Package** | 一个目录，包含 `world.yaml` 清单 + `WORLD.*.md` lore 文件      |
| **Lore**          | 自由格式 Markdown，注入 LLM system prompt 作为世界观权威参考   |
| **Dimensions**    | 结构化世界维度数据（JSON/YAML），供插件、UI、Kernel 程序化消费 |
| **Extract**       | 从 lore 文档中由 LLM 自动提取 dimensions 的过程                |

## 2. 目录结构

```
worlds/                          # monorepo 根目录下，平行于 plugins/
  mistport/
    world.yaml                   # 清单 + dimensions
    WORLD.md                     # 默认 lore（fallback / 单语言世界）
    WORLD.zh.md                  # zh-CN lore
    WORLD.en.md                  # en-US lore
  neonridge/
    world.yaml
    WORLD.md                     # zh-CN only
  cloudmere/
    world.yaml
    WORLD.md                     # zh-CN only
```

### 2.1 文件命名约定

| 文件                   | 必需 | 说明                                                                    |
| ---------------------- | ---- | ----------------------------------------------------------------------- |
| `world.yaml`           | 是   | 清单（manifest）+ 内联 dimensions，可选 `worldData` 指向统一数据索引    |
| `WORLD.md`             | 否   | 默认 lore，映射到 `defaultLocale`                                       |
| `WORLD.{lang}.md`      | 否   | 带语言后缀的 lore，`lang` 为 BCP-47 短码                                |
| `data/world.data.yaml` | 否   | v1 统一 world data source 索引；详见 `devs/docs/world-data-filesystem/` |

语言后缀映射规则：

- `WORLD.zh.md` → `zh-CN`
- `WORLD.en.md` → `en-US`
- `WORLD.md` → `world.yaml` 中的 `defaultLocale`

### 2.2 Lore 解析优先级

对于给定 locale `zh-CN`：

1. `WORLD.zh.md` — 精确匹配
2. `WORLD.md` — 当且仅当 `defaultLocale === "zh-CN"` 时作 fallback
3. 无 lore — 允许，dimensions-only 世界合法

## 3. world.yaml 清单 Schema

```yaml
# ── 元信息 ──────────────────────────────────────
schemaVersion: "1.0" # 必需，当前固定 "1.0"
id: mistport # 必需，唯一标识符，kebab-case
name: # 必需，I18nText
  zh-CN: 雾港・裂潮纪
  en-US: Mistport Chronicles
version: "0.1.0" # 必需，semver
summary: # 必需，I18nText，1-2 句概要
  zh-CN: 一座被永恒浓雾包裹的港口城市。潮汐带来远古遗物，也带来危险。
  en-US: A fog-shrouded port city where tides reveal ancient relics and dangers.
defaultLocale: zh-CN # 必需
supportedLocales: [zh-CN, en-US] # 必需，至少包含 defaultLocale
tags: [dark-fantasy, mystery, exploration] # 可选，genre/theme 标签

# ── 插件依赖 ────────────────────────────────────
requiredPlugins: # 可选
  - persona
  - narrator
recommendedPlugins: # 可选
  - guide
  - inventory

# ── 统一数据索引 ────────────────────────────────
worldData: data/world.data.yaml # 可选，v1 world data source 索引

# ── 结构化维度 ──────────────────────────────────
dimensions: # 可选，WorldDimensions；兼容字段
  geography:
    overview:
      zh-CN: 悬崖与海面之间的港口城市...
      en-US: A port city wedged between sea cliffs...
    regions:
      - name:
          zh-CN: 上城
          en-US: Upper City
        description:
          zh-CN: 议会与商会所在地
          en-US: Seat of the Council
        climate:
          zh-CN: 雾气稀薄，偶见天光
          en-US: Thinner fog, occasional sky
        landmarks:
          - name:
              zh-CN: 议事厅
              en-US: Council Hall
            description:
              zh-CN: 议会权力中枢
              en-US: Political nerve center
  factions:
    - id: council # id 不做 i18n
      name:
        zh-CN: 雾港议会
        en-US: Mistport Council
      description:
        zh-CN: 统治上城的政治实体
        en-US: Ruling body of the Upper City
      type: political # enum 值不做 i18n
      influence: major
      leader:
        zh-CN: 陈议长
        en-US: Councilor Chen
      headquarters: Upper City — Council Hall
      relations:
        - targetId: salt-fangs
          type: hostile
  # ... 其余维度省略，schema 同现有 WorldDimensions
```

### 3.0.1 worldData v1

`worldData` 指向 world root 下的 descriptor，推荐路径为 `data/world.data.yaml`。当前 v1 支持：

- `sources` map，按 YAML 声明顺序执行，可用 `after` 声明少量依赖。
- `kind`: `yaml`、`json`、`markdown`、`text`、`media`。
- `to`: `world:metadata.*`、`plugin:*/*`、`plugin:*/*+lorebook`、`lorebook`、`characters`、`media`。
- 用户 descriptor override：`~/.covel/world-overrides/<world-id>/world.data.override.yaml`。
- `WorldRecord.metadata.worldData` 只保存 source id、digest、target、schema、importedAt、order、origin/overridden、diagnostics count。

world load 阶段生成轻量摘要并投影 `world:metadata.dimensions`。session create 阶段会重建 import plan，校验目标插件启用状态、`dataSchemas.acceptsWorldData` 和插件包内 JSON Schema，然后写入 plugin-data、lorebook、characters、media index 与 `world_data_import_ledger`。session、plugin-data、lorebook、characters 与 ledger 写入处于同一个 store transaction。

### 3.1 Zod Schema 定义

新增 `worldPackageMetaSchema`，复用现有 `worldDimensionsSchema`：

```typescript
export const worldPackageMetaSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/),
  name: i18nTextSchema,
  version: z.string().min(1),
  summary: i18nTextSchema,
  defaultLocale: z.string().min(2),
  supportedLocales: z.array(z.string().min(2)).min(1),
  tags: z.array(z.string()).optional(),
  requiredPlugins: z.array(z.string()).optional(),
  recommendedPlugins: z.array(z.string()).optional(),
  worldData: z.string().min(1).optional(),
  dimensions: worldDimensionsSchema.optional(),
});
```

### 3.2 worldRecordCreateSchema 升级

当前 `name` 和 `description` 仅接受 `z.string()`，升级为 `i18nTextSchema`：

```typescript
// Before:
name: z.string().min(1),
description: z.string().min(1),
lore: z.string().optional(),

// After:
name: i18nTextSchema,
description: i18nTextSchema,
lore: i18nTextSchema.optional(),
```

向后兼容：`i18nTextSchema = z.union([z.string().min(1), z.record(z.string().min(1))])`，纯字符串仍然合法。

## 4. World Package Loader

### 4.1 职责

`loadWorldPackages(worldsDir: string): Promise<WorldRecord[]>`

1. 扫描 `worldsDir` 下的子目录
2. 读取并验证每个 `world.yaml`（YAML → JS 对象 → Zod 校验）
3. 扫描 `WORLD.*.md` / `WORLD.md` 文件，组装 i18n lore map
4. 返回 `WorldRecord[]`，每条记录带 `packageId` 标记来源

### 4.2 Lore 文件解析

```
目录扫描 → 匹配 WORLD.{lang}.md 和 WORLD.md
         → 构建 lore: Record<string, string>
         → { "zh-CN": "<zh content>", "en-US": "<en content>" }
```

lang 到 Locale 映射表（可扩展）：

| 文件后缀       | Locale          |
| -------------- | --------------- |
| `.zh`          | `zh-CN`         |
| `.en`          | `en-US`         |
| `.ja`          | `ja-JP`         |
| `.ko`          | `ko-KR`         |
| 无后缀 (`.md`) | `defaultLocale` |

### 4.3 WorldRecord 输出映射

```
world.yaml.id          → WorldRecord.packageId (新增字段)
world.yaml.name        → WorldRecord.name
world.yaml.summary     → WorldRecord.description
lore map               → WorldRecord.lore
world.yaml.defaultLocale → WorldRecord.locale
world.yaml.tags        → WorldRecord.tags
world.yaml.dimensions  → WorldRecord.dimensions
```

### 4.4 依赖

需要在 `@covel/server` 添加 `yaml` npm 依赖（YAML 解析）。

## 5. Store 集成

### 5.1 WorldRecord 类型扩展

```typescript
export interface WorldRecord {
  id: string;
  name: I18nText;
  description: I18nText;
  lore?: I18nText;
  locale?: string; // defaultLocale
  tags?: string[];
  dimensions?: WorldDimensions;
  packageId?: string; // 新增：来源世界包 ID（seed worlds 有，用户创建的无）
  createdAt: string;
  updatedAt?: string;
}
```

### 5.2 Store 初始化变更

MemoryStore / PgServerStore 的种子逻辑从：

```typescript
import { SEED_WORLDS } from "./seed-worlds.js";
for (const seed of SEED_WORLDS) { ... }
```

变为：

```typescript
import { loadWorldPackages } from "./world-package-loader.js";
const seeds = await loadWorldPackages(worldsDir);
for (const seed of seeds) { ... }
```

### 5.3 Mistport 合并

现有 4 个种子世界（World 1-3 中文 + World 4 英文 Mistport）合并为 3 个世界包。
Mistport 的中英 dimensions 合并为 I18nText 对象，中英 lore 拆为两个 .md 文件。

## 6. Extract-Dimensions 兼容层

### 6.1 目的

普通玩家只写 WORLD.md（自然语言世界观），由 LLM 自动提取结构化 dimensions。

### 6.2 流程

```
WORLD.md (lore 文本)
    ↓ POST /api/ai/extract-dimensions
LLM 阅读 lore → 输出 WorldDimensions JSON
    ↓ worldDimensionsSchema Zod 校验
返回结构化 dimensions → 前端 Tab 编辑器预览
    ↓ 用户确认
PATCH /worlds/:id { dimensions }
```

### 6.3 API 端点

```
POST /api/ai/extract-dimensions
Body: { lore: string, locale?: string }
Response (SSE):
  { type: "progress", phase: "extracting" }
  { type: "done", dimensions: WorldDimensions }
  { type: "error", message: string }
```

### 6.4 Prompt 策略

```
系统指令：你是世界观结构化专家。
从提供的世界设定文档中提取以下 9 个维度的结构化数据。
- 只提取文档中明确描述的内容，不要编造
- 输出严格符合 WorldDimensions schema 的 JSON
- 如果某个维度文档中没有提及，省略该字段
```

复用 `worldDimensionsSchema` 做输出校验，与现有 `generate-world.ts` 一致。

### 6.5 Skill 集成

Claude Code skill `/world-extract`：

1. 读取指定目录的 WORLD.md
2. 调用 extract-dimensions 逻辑
3. 将提取的 dimensions 写入 world.yaml
4. 提示用户确认

## 7. 世界创建路径矩阵

| 用户类型   | 输入                      | 处理方式                                  | 接触格式         |
| ---------- | ------------------------- | ----------------------------------------- | ---------------- |
| 小白玩家   | 一句话描述                | `POST /api/ai/generate-world`（现有）     | 无               |
| 创作型玩家 | 写好的世界观文本          | `POST /api/ai/extract-dimensions`（新增） | Markdown         |
| MOD 作者   | `WORLD.md` + `world.yaml` | loader 直接加载                           | YAML + Markdown  |
| Agent      | `/world-create` skill     | 生成全套文件                              | YAML（agent 写） |

## 8. 实施阶段

### Phase 1: Schema & Types

- 导出 `i18nTextSchema`
- 新增 `worldPackageMetaSchema`
- 升级 `worldRecordCreateSchema` 支持 I18nText
- WorldRecord 增加 `packageId` 字段

### Phase 2: World Package Loader

- 添加 `yaml` 依赖到 `@covel/server`
- 实现 `world-package-loader.ts`
- 单元测试（TDD：先写测试）

### Phase 3: 世界包文件

- 创建 `worlds/` 目录和 3 个世界包
- Mistport 中英合并
- 验证 loader 能正确加载

### Phase 4: Store 集成

- MemoryStore / PgServerStore 使用 loader
- 删除旧 `seed-worlds.ts` / `seed-world-dimensions.ts`
- 回归测试

### Phase 5: Extract-Dimensions API

- `POST /api/ai/extract-dimensions` 端点
- 前端"从 lore 提取维度"按钮

### Phase 6: Skill & 文档

- 更新 `skills/world-authoring/SKILL.md`
- 创建 `/world-create` 和 `/world-extract` skill

## 9. 测试策略

- **world-package-loader.test.ts**: loader 核心逻辑（有效/无效包、缺失文件、i18n lore 组装）
- **world-schema.test.ts**: `worldPackageMetaSchema` 校验（合法/非法 manifest）
- **store 回归**: 现有 memory-store.test.ts / pg-server-store.test.ts 确保种子加载正常
- **API 回归**: `POST /worlds` 同时接受 string 和 I18nText

## 10. 不在范围内

- 世界包的发布/分发系统（marketplace）
- 世界包版本升级/迁移
- 前端世界包导出功能（后续可加）
- 世界包间的依赖关系

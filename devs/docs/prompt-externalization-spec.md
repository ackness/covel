# Prompt 外部化规格

## 1. 动机

代码库中有 8 处硬编码的 LLM prompt 字符串（总计 ~420 行），分散在 server 路由和插件逻辑中。这使得：

- 非开发者无法直接编辑/优化 prompt
- 双语 prompt 通过 if/else 分支管理，难以维护
- 无法在不改代码的情况下 A/B 测试不同 prompt

## 2. 目标

- 所有 LLM prompt 模板以 markdown 文件形式存储在固定位置
- 支持 i18n：`<name>.zh.md` / `<name>.en.md` 自动根据 locale 选择
- 支持 `{{variable}}` 模板变量注入动态内容
- 内存缓存，零运行时 I/O 开销（首次加载后）
- 与现有 `@covel/context` PromptAssembler 集成

## 3. 目录结构

```
prompts/                           # 顶层 prompt 模板目录
  server/                          # Server 路由级 prompt（非插件系统）
    generate-world.md              # 世界生成 system prompt
    extract-dimensions.md          # 维度提取 system prompt

plugins/<plugin>/prompts/          # 每个插件自有的 prompt 目录
  <purpose>.zh.md                  # 中文版
  <purpose>.en.md                  # 英文版
```

### 命名规范

| 模式           | 用途                          |
| -------------- | ----------------------------- |
| `<name>.md`    | 单语言 / locale 无关的 prompt |
| `<name>.zh.md` | 中文 prompt                   |
| `<name>.en.md` | 英文 prompt                   |
| `{{variable}}` | 模板变量占位符                |

### Locale 解析顺序

```
loadPrompt("persona-rules", "zh-CN")
  → persona-rules.zh.md     (精确匹配 lang prefix)
  → persona-rules.en.md     (回退到英文)
  → persona-rules.md        (回退到无 locale 版本)
  → Error                   (文件不存在)
```

## 4. API 设计

### `@covel/context` 新增导出

```typescript
// packages/context/src/template/prompt-loader.ts

/**
 * 从目录加载 locale-aware 的 prompt 模板文件。
 * 结果缓存在内存中，同一路径+locale 仅读一次磁盘。
 */
export function loadPrompt(
  dir: string, // prompt 文件所在目录（绝对路径）
  name: string, // prompt 名称（不含 locale 后缀和 .md）
  locale: string, // e.g. "zh-CN"
): Promise<string>;

/**
 * 清空 prompt 缓存（仅测试用）。
 */
export function clearPromptCache(): void;
```

```typescript
// packages/context/src/template/prompt-interpolator.ts

/**
 * 简单的 mustache-style {{variable}} 替换。
 * 不支持条件/循环 — 保持模板纯声明式。
 * 未替换的变量原样保留（不报错），便于调试。
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string;
```

### 用法示例

```typescript
import { loadPrompt, interpolate } from "@covel/context";

const template = await loadPrompt(
  resolve(import.meta.dirname, "../prompts"),
  "generate-world",
  "zh-CN",
);
const prompt = interpolate(template, { locale: "zh-CN" });
```

## 5. 待外部化的 Prompt 清单

### A. Server 路由 Prompt

| #   | 当前位置                                                    | 目标文件                               | 模板变量     |
| --- | ----------------------------------------------------------- | -------------------------------------- | ------------ |
| 1   | `routes/ai/generate-world.ts` `buildSystemPrompt()`         | `prompts/server/generate-world.md`     | `{{locale}}` |
| 2   | `routes/ai/extract-dimensions.ts` `buildExtractionPrompt()` | `prompts/server/extract-dimensions.md` | `{{locale}}` |

### B. 插件 Context Provider Prompt

| #   | 当前位置                                    | 目标文件                                      | 模板变量     |
| --- | ------------------------------------------- | --------------------------------------------- | ------------ |
| 3   | `persona/server/context/persona-context.ts` | `persona/prompts/persona-rules.{zh,en}.md`    | 无（纯静态） |
| 4   | `guide/server/context/guide-context.ts`     | `guide/prompts/guide-instructions.{zh,en}.md` | 无           |
| 5   | `combat/server/context-provider.ts`         | `combat/prompts/combat-rules.{zh,en}.md`      | 无           |

### C. 插件逻辑 Prompt

| #   | 当前位置                                                           | 目标文件                                                | 模板变量                                                     |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------ |
| 6   | `memory/server/logic.ts` `buildSummaryPrompt()`                    | `memory/prompts/summary-prompt.{zh,en}.md`              | `{{existingSummary}}`, `{{narrative}}`, `{{eventLines}}`     |
| 7   | `init-wizard/server/logic.ts` `buildTransitionPrompt()`            | `init-wizard/prompts/transition-prompt.{zh,en}.md`      | `{{narrative}}`                                              |
| 8   | `core-char-tracker/server/logic.ts` `buildFieldExtractionPrompt()` | `core-char-tracker/prompts/field-extraction.{zh,en}.md` | `{{fieldDescriptions}}`, `{{existingInfo}}`, `{{narrative}}` |

### D. 小清理

| #   | 当前位置                                                                 | 处理方式       |
| --- | ------------------------------------------------------------------------ | -------------- |
| 9   | `ai-provider/adapters/anthropic-messages.ts` `"Respond with JSON only."` | 提取为命名常量 |

## 6. 不在范围内

- **PLUGIN.md** — 已经外部化，不需要改
- **动态数据格式化** — 骰子/物品/任务摘要是数据展示代码
- **`[Locale: xx-XX]`** — 单行格式字符串，不值得外部化
- **测试文件中的 prompt** — 测试 fixture 保持内联
- **Section 标题翻译** — 属于 i18n label，不是 prompt

## 7. 实施阶段

### Phase 1: 基础设施 — Prompt Loader + Interpolator

- `packages/context/src/template/prompt-loader.ts`
- `packages/context/src/template/prompt-interpolator.ts`
- `packages/context/tests/prompt-template.test.ts`
- 导出到 `@covel/context` barrel

### Phase 2: Server 路由 Prompt 外部化

- 创建 `prompts/server/generate-world.md`
- 创建 `prompts/server/extract-dimensions.md`
- 更新两个路由文件使用 `loadPrompt()` + `interpolate()`

### Phase 3: 插件 Context Provider Prompt 外部化

- `persona/prompts/persona-rules.{zh,en}.md`
- `guide/prompts/guide-instructions.{zh,en}.md`
- `combat/prompts/combat-rules.{zh,en}.md`
- 更新各 context provider 使用 `loadPrompt()`

### Phase 4: 插件逻辑 Prompt 外部化

- `memory/prompts/summary-prompt.{zh,en}.md`
- `init-wizard/prompts/transition-prompt.{zh,en}.md`
- `core-char-tracker/prompts/field-extraction.{zh,en}.md`
- 更新各 logic 模块使用 `loadPrompt()` + `interpolate()`

### Phase 5: 小清理 + 验证

- Anthropic JSON directive 常量化
- 全量 lint + test

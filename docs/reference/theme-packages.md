# Theme Package Reference

这份文档描述 Covel 主题包的正式契约。面向两类读者：

- 想稳定分发主题包的高级玩家
- 维护 Covel 前端主题系统的开发者

## 1. 主题系统入口

主题系统由这几部分组成：

- 运行时注册表：`apps/web/src/theme-system/registry.ts`
- 运行时样式注入：`apps/web/src/theme-system/runtime.ts`
- 导入解析：`apps/web/src/theme-system/validate.ts`
- 持久化：`apps/web/src/theme-system/storage.ts`
- 内置主题包：`apps/web/src/themes/builtins/*`
- 外观工作室（见 §9）：token 覆盖 `overrides.ts` · 可编辑 token 清单 `token-schema.ts` · 另存为主题 `theme-export.ts` · 颜色工具 `color.ts`

当前运行时主题切换入口是：

```html
<html data-theme="paper" data-scheme="dark" class="dark"></html>
```

其中：

- `ui.appearance` 持久化主题包 ID，并应用为 `data-theme`
- `ui.scheme` 持久化颜色模式，并应用为 `data-scheme` 与 Tailwind 兼容的 `.dark`
- 主题包的 `schemes` 决定可用颜色模式；只支持单一模式的主题会自动把 `ui.scheme` 对齐到可用值

## 2. 支持的导入格式

### 2.1 CSS 文件

运行时会从 CSS 中解析 `data-theme` 选择器：

```css
html[data-theme="ember"] {
  --color-background: #14171d;
}

html[data-theme="ember"].dark {
  --color-background: #090b10;
}
```

解析规则：

- 必须至少出现一个 `html[data-theme="..."]` 选择器
- 一个 CSS 文件只能声明一个主题 ID
- 只有同一个主题 ID 的选择器包含 `.dark` 时，运行时才会把 `schemes` 视为 `["light", "dark"]`
- 其他 `.dark` 选择器不会影响主题模式推断

### 2.2 JSON 文件

JSON 结构：

```json
{
  "id": "ember",
  "label": {
    "zh-CN": "余烬",
    "en-US": "Ember"
  },
  "schemes": ["light", "dark"],
  "description": {
    "zh-CN": "深色余烬主题",
    "en-US": "A dark ember theme"
  },
  "cssText": "html[data-theme=\"ember\"] { --color-background: #14171d; }"
}
```

## 3. JSON 字段契约

| 字段          | 类型                               | 说明                                           |
| ------------- | ---------------------------------- | ---------------------------------------------- |
| `id`          | `string`                           | 主题 ID，匹配 `/^[a-z0-9][a-z0-9-]{1,47}$/`    |
| `label`       | `string \| Record<string, string>` | 显示名称                                       |
| `schemes`     | `("light" \| "dark")[]`            | 支持的颜色模式                                 |
| `description` | `string \| Record<string, string>` | 可选说明                                       |
| `cssText`     | `string`                           | 主题 CSS 内容，必须只声明与 `id` 相同的主题 ID |

## 4. 内置主题包结构

内置主题目录结构：

```text
apps/web/src/themes/builtins/
  modern/
    manifest.json
    theme.css
  paper/
    manifest.json
    theme.css
  abyss/
    manifest.json
    theme.css
  aurora/
    manifest.json
    theme.css
```

`aurora` 是效果参考实现：玻璃拟态、`@property` 驱动的流动渐变、消息入场动画、以及 §6.6 的状态驱动特效。要写"花哨"主题时直接抄它。

`manifest.json` 结构：

```json
{
  "id": "paper",
  "label": {
    "zh-CN": "Paper",
    "en-US": "Paper"
  },
  "source": "builtin",
  "schemes": ["light", "dark"],
  "description": {
    "zh-CN": "温暖、偏叙事阅读器的纸本风格。",
    "en-US": "A warm editorial reading style."
  }
}
```

## 5. 共享 token 契约

主题包最核心的职责是覆盖语义 token。

### 5.1 颜色 token

- `--color-background`
- `--color-foreground`
- `--color-card`
- `--color-card-foreground`
- `--color-popover`
- `--color-popover-foreground`
- `--color-primary`
- `--color-primary-foreground`
- `--color-secondary`
- `--color-secondary-foreground`
- `--color-muted`
- `--color-muted-foreground`
- `--color-accent`
- `--color-accent-foreground`
- `--color-destructive`
- `--color-destructive-foreground`
- `--color-border`
- `--color-input`
- `--color-ring`

### 5.2 表面 token

- `--surface-page`
- `--surface-rail`
- `--surface-inset`
- `--surface-elevated`
- `--surface-dialog`
- `--surface-player`
- `--surface-empty`
- `--border-subtle`

兼容旧主题的别名：

- `--surface-app`
- `--surface-panel`
- `--surface-panel-strong`

### 5.3 规则与强调 token

- `--rule-color`
- `--rule-strong-color`
- `--rule-style`
- `--rule-thickness`
- `--rule-strong-thickness`
- `--accent-primary`
- `--accent-secondary`
- `--accent-warning`
- `--accent-danger`
- `--accent-success`

### 5.4 圆角、布局与氛围 token

- `--radius-card`
- `--radius-control`
- `--radius-dialog`
- `--radius-chip`
- `--panel-header-height`
- `--panel-section-padding-x`
- `--panel-section-padding-y`
- `--rail-width-left`
- `--rail-width-right`
- `--composer-max-width`
- `--session-column-max-width`
- `--ambience-image`
- `--ambience-blend`
- `--ambience-opacity`
- `--noise-image`
- `--noise-opacity`

### 5.5 字体与排版 token

- `--font-sans`
- `--font-display`
- `--font-serif`
- `--font-mono`
- `--type-display`
- `--type-body`
- `--type-mono`
- `--type-meta`
- `--eyebrow-font-family`
- `--eyebrow-font-size`
- `--eyebrow-font-weight`
- `--eyebrow-letter-spacing`
- `--eyebrow-text-transform`
- `--title-font-family`
- `--title-font-style`
- `--title-font-weight`
- `--title-letter-spacing`
- `--title-text-transform`
- `--story-font-family`
- `--story-font-size`
- `--story-line-height`
- `--story-font-weight`
- `--story-letter-spacing`
- `--story-max-width`
- `--meta-font-family`
- `--meta-font-size`
- `--meta-letter-spacing`
- `--meta-text-transform`

### 5.6 阴影 token

- `--shadow-card`
- `--shadow-dialog`
- `--shadow-pop`

## 6. 共享语义 hook 契约

### 6.1 结构层

- `.ui-panel-header`
- `.ui-panel-section`
- `.ui-panel-footer`
- `.ui-rule`
- `.ui-outline-rail`

### 6.2 排版层

- `.ui-title`
- `.ui-entry-title`
- `.ui-eyebrow`
- `.ui-narrative`
- `.ui-empty-title`
- `.ui-empty-copy`

### 6.3 组件表面

- `.ui-card-surface`
- `.ui-dialog-shell`
- `.ui-input-shell`
- `.ui-chip`
- `.ui-chip-name`
- `.ui-chip-dot`

### 6.4 会话体验

- `.ui-session-column`
- `.ui-message-row`
- `.ui-player-message-row`
- `.ui-message-player`
- `.ui-message-assistant`
- `.ui-composer-frame`
- `.ui-composer-input`
- `.ui-composer-submit`

### 6.5 细节效果

- `.ui-meter-track`
- `.ui-meter-fill`
- `.ui-pulse-dot`
- `.ui-cursor`

### 6.6 状态属性（状态驱动特效）

除了类名，框架还把当前回合状态写在 `<html>` 上，让纯 CSS 能对游戏正在发生的事做出反应：

| 属性           | 取值                                       | 含义                 |
| -------------- | ------------------------------------------ | -------------------- |
| `data-turn`    | `idle` / `executing` / `waiting` / `error` | 回合活动状态         |
| `data-session` | `active` / `paused` / `ended`              | 会话生命周期         |
| `data-theme`   | 主题 ID                                    | 当前主题（作用域用） |
| `data-scheme`  | `light` / `dark`                           | 当前明暗模式         |

`waiting` 优先于 `executing`：回合还开着，但内核在等玩家操作（表单、选择），这才是值得高亮的状态。

```css
/* AI 正在生成时，输入框呼吸 */
html[data-theme="my-theme"][data-turn="executing"] .ui-composer-input {
  animation: my-breathe 2.4s ease-in-out infinite;
}
```

这些属性由框架自身发布，只覆盖内核知道的状态。插件专属状态（场景、情绪、战斗）需要一条按 capability 声明的通道，框架不会硬编码插件 ID，目前尚未开放。

## 7. 运行时行为

导入主题时，运行时流程是：

1. 读取文件内容
2. 解析主题 ID 和 CSS
3. 验证导入格式
4. 保存到本地设置
5. 注入 `<style data-theme-style="theme-id">`
6. 重新注册到 `ui.appearance`
7. 根据 `schemes` 校正 `ui.scheme`
8. 在设置面板和主题库中显示

## 8. 持久化行为

自定义主题保存在 `ui.customThemes` 设置项中。每条记录包含：

- `id`
- `label`
- `cssText`
- `schemes`
- `description`
- `importedAt`
- `fileName`

运行时会把这些记录恢复为 `ThemeDefinition`，并与内置主题一起排序和注册。

## 9. 外观工作室（token 覆盖 / 另存为主题）

玩家不写 CSS 也能改外观：设置 → 外观提供逐 token 的控件（`token-schema.ts` 的 `TOKEN_GROUPS` 定义哪些 token 可编辑、用什么控件、有哪些预设值，包括字体栈 `FONT_STACKS` 与氛围底纹 `AMBIENCE_PRESETS`）。

- **存储**：覆盖值存在设置项 `ui.appearanceTokens`，形状为 `{ shared, light, dark }`——**颜色按明暗模式分开存，尺寸 / 字体 / 圆角在两种模式间共享**。单个值上限 2048 字符（防止粘贴 data-URL 撑爆 localStorage 配额、连累其它设置）。
- **生效方式**：`applyTokenOverrides()` 把 `{...shared, ...当前 scheme}` 作为**内联 style 写到 `<html>`**，因此优先级高于主题包 CSS；上一轮写入但本轮已移除的属性会被显式清掉，不留孤儿。非法 CSS 值由 CSSOM 直接丢弃——失败即回落到主题自己的值。
- **基线读取**：`readTokenDefaults()` 临时撤下覆盖读出主题原值，再在同一同步块里恢复，所以控件能显示「未覆盖时是什么」且浏览器不会画出中间态。
- **另存为主题**：`theme-export.ts` 的 `buildThemeCss()` 把当前覆盖编译成标准 `html[data-theme="..."]` CSS，`slugifyThemeId()` / `ensureThemeId()` 生成不冲突的 ID，产物就是一个普通自定义主题包（走 §8 的 `ui.customThemes` 持久化），可导出分发。

覆盖是**全局的、不按主题分桶**（`ui.appearanceTokens` 只有 `shared` / `light` / `dark` 三个桶）：换主题后同一批覆盖继续叠加在新主题之上。想回到主题原貌需显式清除覆盖（`clearOverrides` / 逐项 `clearTokenOverride`）。写入前经 `isAdjustableToken` 过滤——只有 `TOKEN_GROUPS` 声明过的 token 能被覆盖，任意 CSS 变量无法经此通道注入。

## 10. 兼容性建议

想获得稳定兼容性的主题包，推荐遵守这组策略：

- 优先覆盖 token
- 局部视觉差异使用 `.ui-*` hook
- 亮色与暗色都提供完整的前景色和边界色
- 叙事主题显式覆盖 `--story-*` token
- 工具主题显式覆盖 `--surface-*`、`--radius-*`、`--title-*` token

## 10. 参考示例

内置主题可以作为实际参考：

- `apps/web/src/themes/builtins/modern/theme.css`
- `apps/web/src/themes/builtins/paper/theme.css`
- `apps/web/src/themes/builtins/abyss/theme.css`

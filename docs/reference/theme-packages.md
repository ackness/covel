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

当前运行时主题切换入口是：

```html
<html data-theme="paper" class="dark">
```

其中：

- `data-theme` 决定主题包
- `.dark` 决定颜色模式

## 2. 支持的导入格式

### 2.1 CSS 文件

运行时会从 CSS 中解析第一个 `data-theme` 选择器：

```css
html[data-theme="ember"] {
  --color-background: #14171d;
}
```

解析规则：

- 至少出现一个 `data-theme="..."` 选择器
- 第一个匹配到的主题 ID 作为主题包 ID
- 文件中出现 `.dark` 选择器时，运行时会把 `schemes` 视为 `["light", "dark"]`

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

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 主题 ID，匹配 `/^[a-z0-9][a-z0-9-]{1,47}$/` |
| `label` | `string \| Record<string, string>` | 显示名称 |
| `schemes` | `("light" \| "dark")[]` | 支持的颜色模式 |
| `description` | `string \| Record<string, string>` | 可选说明 |
| `cssText` | `string` | 主题 CSS 内容 |

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
```

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

- `--surface-app`
- `--surface-panel`
- `--surface-panel-strong`
- `--surface-dialog`
- `--surface-player`
- `--surface-empty`
- `--border-subtle`

### 5.3 圆角与布局 token

- `--radius-card`
- `--radius-control`
- `--radius-dialog`
- `--radius-chip`
- `--panel-header-height`
- `--panel-section-padding-x`
- `--panel-section-padding-y`
- `--composer-max-width`
- `--session-column-max-width`

### 5.4 字体与排版 token

- `--font-display`
- `--font-serif`
- `--font-mono`
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

### 5.5 阴影 token

- `--shadow-card`
- `--shadow-dialog`

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

## 7. 运行时行为

导入主题时，运行时流程是：

1. 读取文件内容
2. 解析主题 ID 和 CSS
3. 验证导入格式
4. 保存到本地设置
5. 注入 `<style data-theme-style="theme-id">`
6. 重新注册到 `ui.appearance`
7. 在设置面板和主题库中显示

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

## 9. 兼容性建议

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

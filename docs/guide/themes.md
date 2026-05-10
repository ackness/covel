# Covel 主题包指南

Covel 的主题系统已经统一为“主题包”模式。玩家可以通过一个 CSS 文件，或者一个带 `cssText` 的 JSON 文件，创建自己的界面风格，并在设置中长期复用。

这份文档直接回答三个问题：

1. 主题包长什么样
2. 主题包应该遵守什么规范
3. 玩家应该按什么步骤创建、导入、迭代自己的主题

---

## 1. 主题包是什么

一个 Covel 主题包由两部分组成：

- **主题 ID**：决定作用域选择器，写法是 `html[data-theme="你的主题ID"]`
- **主题样式**：覆盖 Covel 提供的语义 token 和语义 hook

主题包选择会保存到 `ui.appearance`，颜色模式会保存到 `ui.scheme`。运行时会把它们应用到 `<html data-theme="..." data-scheme="...">`；暗色模式同时保留 `.dark` class，供 Tailwind 分支和旧主题继续工作。

你可以把它理解成一层“换皮配置”：

- 颜色来自 token
- 圆角来自 token
- 字体来自 token
- 局部布局微调来自 `.ui-*` 语义 hook

Covel 会负责：

- 注册主题
- 应用主题
- 存储你导入的主题
- 在下次启动时继续显示在 Appearance 下拉菜单里

---

## 2. 最小可用主题包

最小主题包只需要一个 CSS 文件：

```css
html[data-theme="ember"] {
  --color-background: #14171d;
  --color-foreground: #edf2f7;
  --color-card: #1a1f29;
  --color-primary: #8fb4ff;
  --color-border: #2b3442;

  --surface-panel: #181d27;
  --surface-panel-strong: #1d2430;
  --surface-dialog: #1d2430;

  --story-font-family: "Newsreader", serif;
  --story-font-size: 1.0625rem;
  --story-line-height: 1.75;
  --story-max-width: 42rem;

  --radius-card: 0.875rem;
  --radius-control: 0.625rem;
}
```

这个文件导入后就能成为一个可选主题。

如果你需要亮色和暗色两套方案，可以继续补：

```css
html[data-theme="ember"].dark {
  --color-background: #0d1015;
  --color-foreground: #edf2f7;
  --color-card: #171b22;
}
```

---

## 3. 主题 ID 规范

主题 ID 决定了选择器和持久化 key。推荐遵守这组规则：

- 只使用小写字母、数字、连字符
- 以字母或数字开头
- 长度控制在 `2-48` 个字符
- 一个主题包只使用一个主题 ID

推荐示例：

- `ember`
- `modern-warm`
- `jade-paper`
- `night-ledger`

推荐把文件名也保持一致：

```text
ember.css
modern-warm.css
night-ledger.theme.json
```

---

## 4. 两种导入格式

### 4.1 CSS 主题包

这是最直接、最推荐的格式。

特点：

- 适合大多数玩家
- 便于手写和反复调整
- 文件结构最简单

示例：

```css
html[data-theme="jade-paper"] {
  --color-background: oklch(96% 0.02 120);
  --color-foreground: oklch(22% 0.02 140);
  --color-primary: oklch(48% 0.08 155);
  --surface-panel: oklch(98% 0.01 120);
  --radius-card: 1rem;
}
```

### 4.2 JSON 主题包

这个格式适合分享、归档和二次分发。

示例：

```json
{
  "id": "jade-paper",
  "label": {
    "zh-CN": "玉笺",
    "en-US": "Jade Paper"
  },
  "schemes": ["light", "dark"],
  "description": {
    "zh-CN": "带青绿色调的纸本阅读风格",
    "en-US": "An editorial paper style with jade accents"
  },
  "cssText": "html[data-theme=\"jade-paper\"] { --color-background: #f7fbf5; }"
}
```

字段含义：

- `id`：主题 ID
- `label`：显示名称
- `schemes`：支持的模式，常见值是 `["light"]` 或 `["light", "dark"]`
- `description`：可选说明
- `cssText`：真正生效的 CSS 内容，里面只能声明与 `id` 相同的主题 ID

---

## 5. 创建主题的推荐顺序

### 第一步：确定主题方向

先为主题定一个明确方向。Covel 的主题最容易做出质感的方向有三类：

- **工具型**：冷色、紧凑、边界清晰、信息密度高
- **阅读型**：暖色、留白多、行高宽松、标题更有叙事感
- **沉浸型**：深色、对比柔和、重点区域有氛围光感

一个主题只服务一个主方向，视觉会更稳。

### 第二步：先定基础 token

先覆盖这组核心 token：

- `--color-background`
- `--color-foreground`
- `--color-card`
- `--color-primary`
- `--color-border`
- `--surface-panel`
- `--surface-panel-strong`
- `--surface-dialog`
- `--radius-card`
- `--radius-control`

这一步完成后，界面已经会出现明显风格变化。

### 第三步：再定阅读体验

如果你的主题偏阅读型，再补这组 token：

- `--story-font-family`
- `--story-font-size`
- `--story-line-height`
- `--story-font-weight`
- `--story-letter-spacing`
- `--story-max-width`

### 第四步：最后调局部语义 hook

如果你想进一步改变面板、输入框、消息区的气质，再覆盖 `.ui-*` 语义 hook。

---

## 6. 推荐 token 清单

### 6.1 核心颜色 token

这组 token 决定整个主题的主视觉：

- `--color-background`
- `--color-foreground`
- `--color-card`
- `--color-card-foreground`
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

### 6.2 表面层级 token

这组 token 决定界面的空间关系：

- `--surface-page`
- `--surface-rail`
- `--surface-inset`
- `--surface-elevated`
- `--surface-dialog`
- `--surface-player`
- `--surface-empty`
- `--border-subtle`

旧主题别名仍然可用：

- `--surface-app`
- `--surface-panel`
- `--surface-panel-strong`

### 6.3 规则与强调 token

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

### 6.4 圆角、尺寸与氛围 token

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
- `--noise-image`
- `--noise-opacity`

### 6.5 字体与排版 token

- `--font-display`
- `--font-serif`
- `--font-mono`
- `--title-font-family`
- `--title-font-style`
- `--title-font-weight`
- `--title-letter-spacing`
- `--title-text-transform`
- `--eyebrow-font-family`
- `--eyebrow-font-size`
- `--eyebrow-font-weight`
- `--eyebrow-letter-spacing`
- `--eyebrow-text-transform`
- `--story-font-family`
- `--story-font-size`
- `--story-line-height`
- `--story-font-weight`
- `--story-letter-spacing`
- `--story-max-width`

### 6.6 阴影 token

- `--shadow-card`
- `--shadow-dialog`
- `--shadow-pop`

---

## 7. 语义 hook 规范

Covel 为主题包暴露了一组稳定的语义 hook。玩家可以通过这些类名调整局部风格。

### 7.1 面板与结构

- `.ui-panel-header`
- `.ui-panel-section`
- `.ui-panel-footer`
- `.ui-rule`
- `.ui-outline-rail`

### 7.2 排版与内容

- `.ui-title`
- `.ui-entry-title`
- `.ui-eyebrow`
- `.ui-narrative`
- `.ui-empty-title`
- `.ui-empty-copy`

### 7.3 卡片与输入

- `.ui-card-surface`
- `.ui-dialog-shell`
- `.ui-input-shell`
- `.ui-chip`
- `.ui-chip-name`
- `.ui-chip-dot`

### 7.4 会话与消息

- `.ui-session-column`
- `.ui-message-row`
- `.ui-player-message-row`
- `.ui-message-player`
- `.ui-message-assistant`
- `.ui-composer-frame`
- `.ui-composer-input`
- `.ui-composer-submit`

### 7.5 细节效果

- `.ui-meter-track`
- `.ui-meter-fill`
- `.ui-pulse-dot`
- `.ui-cursor`

---

## 8. 一个完整主题包模板

下面是一份适合直接复制的模板：

```css
html[data-theme="my-theme"] {
  --color-background: #f6f2eb;
  --color-foreground: #241f1b;
  --color-card: #fffdf8;
  --color-card-foreground: #241f1b;
  --color-primary: #7a4b2f;
  --color-primary-foreground: #fffaf2;
  --color-border: #d9c8b5;
  --color-input: #d9c8b5;
  --color-muted: #efe4d7;
  --color-muted-foreground: #7d6f63;

  --surface-page: #f6f2eb;
  --surface-rail: #fffaf2;
  --surface-inset: #efe4d7;
  --surface-elevated: #fffdf8;
  --surface-dialog: #fffdf8;
  --surface-player: transparent;

  --rule-color: #d9c8b5;
  --accent-primary: #7a4b2f;

  --radius-card: 1rem;
  --radius-control: 0.75rem;
  --radius-dialog: 1rem;

  --title-font-family: "Newsreader", serif;
  --title-font-style: italic;
  --title-font-weight: 400;
  --title-text-transform: none;

  --story-font-family: "Newsreader", serif;
  --story-font-size: 1.125rem;
  --story-line-height: 1.8;
  --story-max-width: 42rem;
}

html[data-theme="my-theme"] .ui-rule {
  border-style: dashed;
}

html[data-theme="my-theme"] .ui-message-player {
  background: transparent;
  color: var(--color-foreground);
  border-width: 0 0 0 2px;
  border-color: var(--color-primary);
  border-radius: 0;
  padding-left: 0.875rem;
  padding-right: 0;
  padding-block: 0;
}

html[data-theme="my-theme"].dark {
  --color-background: #14110f;
  --color-foreground: #f1e7dc;
  --color-card: #1d1916;
  --color-card-foreground: #f1e7dc;
  --color-primary: #ddb08c;
  --color-primary-foreground: #1a130f;
  --color-border: #3d322b;
  --color-input: #3d322b;
}
```

---

## 9. 导入与复用流程

### 9.1 导入步骤

1. 打开 `Settings`
2. 进入 `General`
3. 找到 `Theme Library`
4. 点击 `Import theme`
5. 选择 `.css`、`.json`、`.theme` 或 `.theme.json` 文件
6. 导入完成后，主题会自动出现在 `Appearance` 下拉菜单里
7. 如果主题只支持单一颜色模式，`Color scheme` 会自动锁定到可用模式

### 9.2 复用方式

导入后的主题会自动保存在本地。之后你可以：

- 直接在 Appearance 中切换主题包
- 在 Color scheme 中切换亮色和暗色
- 在 Theme Library 中重新应用
- 导出 JSON 包分享给别人

---

## 10. 主题包编写规范

这组规则能保证主题在未来版本中保持稳定：

### 10.1 作用域规范

所有规则都写在当前主题 ID 的作用域下：

```css
html[data-theme="my-theme"] { ... }
html[data-theme="my-theme"] .ui-panel-header { ... }
html[data-theme="my-theme"].dark { ... }
```

### 10.2 优先覆盖 token

优先覆盖 token，再覆盖 `.ui-*` hook。这样主题的可维护性更高，适配面更广。

### 10.3 局部调整使用语义 hook

当你想调整局部布局和视觉细节时，直接覆盖 `.ui-*` hook。

推荐示例：

```css
html[data-theme="ledger"] .ui-panel-header {
  border-bottom-style: dashed;
}

html[data-theme="ledger"] .ui-chip {
  background: transparent;
}
```

### 10.4 设计方向保持一致

颜色、字体、圆角、阴影统一服务一个主题方向，成品会更完整。

---

## 11. 自检清单

一个合格主题包通常满足这份清单：

- 有清晰的主题 ID
- 所有规则都在 `html[data-theme="..."]` 作用域内
- 一个主题包只声明一个 `data-theme` ID
- 至少覆盖一组核心颜色 token
- 至少覆盖 `--surface-rail`、`--surface-elevated` 和 `--surface-dialog`
- 至少覆盖 `--radius-card` 和 `--radius-control`
- 叙事主题覆盖了 `--story-*` token
- 亮色和暗色模式的对比度都足够清晰
- 导入后能出现在 Appearance 下拉菜单里
- 切换主题后，Session、Onboarding、Settings 的风格保持一致

---

## 12. 推荐练习路径

如果你第一次写 Covel 主题，最顺手的路径是：

1. 复制一个内置主题作为起点
2. 先改颜色 token
3. 再改半径和字体
4. 最后改 `.ui-message-player`、`.ui-rule`、`.ui-chip` 这三个 hook

这条路径很适合做出一套风格完整、维护简单、可持续迭代的主题包。

---

## 13. 进阶参考

更详细的字段、契约和内部加载机制见：

- [../reference/theme-packages.md](../reference/theme-packages.md)

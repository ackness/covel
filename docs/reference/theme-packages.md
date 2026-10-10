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
- 布局预设（见 §3.1）：`layout.ts`（预设表、校验、发布到 `<html>`）· `use-theme-layout.ts`（组件读取当前布局）· 结构样式 `apps/web/src/styles/layout.css`
- 外观工作室（见 §9）：token 覆盖 `overrides.ts` · 可编辑 token 清单 `token-schema.ts` · 另存为主题 `theme-export.ts` · 颜色工具 `color.ts`

当前运行时主题切换入口是：

```html
<html
  data-theme="panel"
  data-scheme="dark"
  class="dark"
  data-layout="panel"
  data-nav="rail"
  data-panel-tabs="bar"
  data-backdrop="none"
  data-world-list="cards"
  data-turn-notes="inline"
></html>
```

其中：

- `ui.appearance` 持久化主题包 ID，并应用为 `data-theme`；默认值是 `stage`（舞台）；已保存的主题选择保持不变
- 主题包的 `layout` 解析后写入 `data-layout` 及各选项属性（见 §3.1）；没有单独的布局设置项，布局随主题包切换
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
  "layout": { "preset": "panel", "nav": "top" },
  "cssText": "html[data-theme=\"ember\"] { --color-background: #14171d; }"
}
```

CSS 文件没有地方声明 `layout`，按 CSS 导入的主题使用 `classic` 布局。需要其他布局时使用 JSON 格式。

> **信任边界**：导入的主题 CSS 按原样应用。导入校验会拒绝 `@import`，但不过滤 `url(...)`（背景图、`@font-face` 字体等），所以主题可以让客户端向任意外部地址发请求。只导入来源可信的主题包。

## 3. JSON 字段契约

| 字段          | 类型                               | 说明                                           |
| ------------- | ---------------------------------- | ---------------------------------------------- |
| `id`          | `string`                           | 主题 ID，匹配 `/^[a-z0-9][a-z0-9-]{1,47}$/`    |
| `label`       | `string \| Record<string, string>` | 显示名称                                       |
| `schemes`     | `("light" \| "dark")[]`            | 支持的颜色模式                                 |
| `description` | `string \| Record<string, string>` | 可选说明                                       |
| `layout`      | `ThemeLayoutSpec`                  | 可选布局声明，见 §3.1；省略时为 `classic`      |
| `group`       | `string`                           | 可选分组 ID，格式同 `id`，见 §3.2              |
| `groupLabel`  | `string \| Record<string, string>` | 可选分组显示名，见 §3.2                        |
| `cssText`     | `string`                           | 主题 CSS 内容，必须只声明与 `id` 相同的主题 ID |

### 3.1 布局预设（`layout`）

token 和语义 hook 只能改外观。导航放在哪、右侧面板页签长什么样、会话如何使用世界美术、世界列表怎么排、每回合的结果放在哪，这些是结构，由主题包的 `layout` 声明：先选一个预设，再按需覆盖单个选项。

```ts
interface ThemeLayoutSpec {
  preset?: "classic" | "book" | "stage" | "panel"; // 省略为 classic
  nav?: "top" | "rail";
  panelTabs?: "rail" | "bar";
  backdrop?: "ambient" | "scene" | "banner" | "none";
  worldList?: "covers" | "cards" | "list" | "showcase";
  turnNotes?: "fold" | "inline" | "margin";
}
```

| 选项        | 取值       | 效果                                                                                |
| ----------- | ---------- | ----------------------------------------------------------------------------------- |
| `nav`       | `top`      | 顶部导航条                                                                          |
|             | `rail`     | 桌面宽度下改为左侧图标导航栏；窄屏仍用顶部导航条和菜单弹层                          |
| `panelTabs` | `rail`     | 右侧面板用纵向图标条切换                                                            |
|             | `bar`      | 右侧面板顶部用带文字的横向页签；放不下时可横向滚动，末尾多一个列出全部页签的按钮    |
| `backdrop`  | `ambient`  | 会话顶部一层很淡的世界图                                                            |
|             | `scene`    | 当前场景图铺满会话区（`stage.backdrop@1` 槽位，缺失时回退世界头图），正文收进右侧栏 |
|             | `banner`   | 世界图作为章节横幅放在第一条消息上方，随历史一起滚动                                |
|             | `none`     | 不显示世界图                                                                        |
| `worldList` | `covers`   | 整卡封面的世界卡片（两列）                                                          |
|             | `cards`    | 上图下文的卡片（三列），顶部有「继续上次的冒险」和搜索框；封面悬停轮播场景图        |
|             | `list`     | 一行一个世界的阅读列表                                                              |
|             | `showcase` | 选中世界的封面和场景图轮播铺满全屏，立绘排在简介下方，其他世界排成缩略图条          |
| `turnNotes` | `fold`     | 每回合的只读结果（检定、状态变化、新发现）折叠在正文下方                            |
|             | `inline`   | 最新一回合的结果默认展开，更早的仍然折叠                                            |
|             | `margin`   | 结果放在正文旁的页边栏；会话区不够宽时退回正文下方                                  |

| 预设      | `nav`  | `panelTabs` | `backdrop` | `worldList` | `turnNotes` |
| --------- | ------ | ----------- | ---------- | ----------- | ----------- |
| `classic` | `top`  | `rail`      | `ambient`  | `covers`    | `fold`      |
| `book`    | `top`  | `bar`       | `banner`   | `list`      | `margin`    |
| `stage`   | `top`  | `bar`       | `scene`    | `showcase`  | `inline`    |
| `panel`   | `rail` | `bar`       | `none`     | `cards`     | `inline`    |

规则：

- 取值是封闭枚举，对象不允许未知键。JSON 导入时 `layout` 不合法会整体拒绝该主题包；已存储的主题包里不合法的 `layout` 会被丢弃并回退到 `classic`。
- 框架的结构样式按**选项**属性匹配（如 `html[data-backdrop="scene"]`），不按主题 ID 或预设名。覆盖了单个选项的自定义主题包同样得到对应结构。
- 组件通过 `useThemeLayout()` 读取当前布局；新增一个结构选项需要同时改 `layout.ts` 的枚举与预设表、消费它的组件，以及本节表格。
- 「另存为主题包」会带上来源主题的 `layout`。

### 3.2 风格与配色分组（`group`）

设置里的「风格方案」按 `group` 把主题包归成卡片：同一个 `group` 的主题包是一个风格，各成员是这个风格下的配色。没有声明 `group` 的主题包自成一个风格（分组 ID 就是它自己的 `id`）。

- 每个成员仍是完整、可独立选择的主题包；`ui.appearance` 存的始终是主题包 ID，没有单独的「配色」设置项。
- 卡片名称取第一个声明了 `groupLabel` 的成员；都没有声明时取 `id` 与分组 ID 相同的那个成员的 `label`，再没有则取第一个成员的 `label`。内置主题排在前面，导入的主题包无法改掉内置分组的名称。
- 配色的名称是成员自己的 `label`；`id` 与分组 ID 相同的成员显示为「默认」。
- 卡片的缩略图、说明和布局取当前选中的成员，未选中时取第一个成员。框架不要求同组成员布局一致，但同组混用不同布局会让玩家困惑。
- 「另存为主题包」会把新主题包归入来源主题的分组，作为该风格下的一个新配色。
- 给某个风格加配色：导入一个 `group` 指向该风格的主题包即可，例如 `"group": "panel"`。

## 4. 内置主题包结构

内置主题目录结构：

```text
apps/web/src/themes/builtins/
  panel/
    manifest.json
    theme.css
  book/
    manifest.json
    theme.css
  stage/
    manifest.json
    theme.css
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

`panel`（面板）、`book`（书卷）、`stage`（舞台）是三套「风格方案」，各自声明一个同名布局预设，是写带布局主题包的参考实现。`paper` / `modern` / `abyss` / `aurora` 使用 `classic` 布局，并声明 `"group": "classic"`，在设置里合成一个「经典」风格的四种配色。

`aurora` 是效果参考实现：玻璃拟态、通过 `transform` 旋转静态渐变图层实现的流光、消息入场动画、以及 §6.6 的状态驱动特效。渐变图层按视口对角线加模糊留白确定尺寸，旋转时覆盖横竖屏；避免逐帧修改渐变角度，从而减少滚动期间的重复栅格化。要写"花哨"主题时直接抄它。

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

带布局的内置主题在 manifest 里多一个 `layout` 字段，例如 `"layout": { "preset": "book" }`。

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
- `--surface-session`：游戏中央面板底色，未设置时回退到 `--surface-page`；可用半透明色让底层主题流光透出。
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

中文字体默认用系统自带的（如 `"PingFang SC"`、`"Microsoft YaHei"`、`"Songti SC"`）。应用不从字体服务加载中文网络字体：它们体积大，会在加载过程中让整页文字反复重排，字体服务不可达时还会拖慢首屏。

随应用打包了一款标题字体 `"ZCOOL XiaoWei"`（站酷小薇，OFL 1.1；文件在 `apps/web/public/fonts/zcool-xiaowei/`，字体声明在 `apps/web/src/styles/fonts.css`）。它只有 400 一个字重，只在有主题用到这个字体族时才会被读取，`stage` 用它做标题。主题包可以直接在字体栈里写这个名字，但不要给它设粗体。

主题包不能 `@import`，所以字体栈里其余的中文字体都应是系统字体，并以通用族名（`sans-serif` / `serif`）收尾。

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
- `--story-color`（叙事正文颜色，默认跟随 `--color-foreground`；外观设置按明暗模式分别保存）
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

Markdown 的正文、标题、强调和引用使用主题文字色，链接和行内代码使用主题主色；叙事区域的正文、标题、强调和引用使用 `--story-color`。叙事 Markdown 的字号、行高、字重、字距和栏宽由 `--story-*` 控制。样式位于 `apps/web/src/styles/narrative.css`，使用不分层的规则覆盖 Typography 的 `utilities` 默认值。

### 5.6 阴影 token

- `--shadow-card`
- `--shadow-dialog`
- `--shadow-pop`

## 6. 共享语义 hook 契约

### 6.1 结构层

- `.ui-app-header`：顶部导航条
- `.ui-nav-rail`：`nav: "rail"` 时的左侧导航栏
- `.ui-nav-item`：导航项（两种导航共用，当前项带 `aria-current="page"`）
- `.ui-session-header`：会话顶部工具条；其中 `.ui-session-title` 是标题（`backdrop: "scene"` 且有场景名时是场景名，否则是世界名），`.ui-view-switch` 是「文本 / 舞台」切换（选中项带 `data-state="on"`），`.ui-session-action` 是返回、设置、更多、面板开关这些按钮，`.ui-menu-item` 是「更多」菜单里的条目
- `.ui-session-thumb`：工具条里世界名前的世界缩略图。默认隐藏，主题用 `display: block` 打开并给出尺寸
- `.ui-panel-status`：`panelTabs: "bar"` 时右侧面板页签下方的玩家状态条；`.ui-panel-status-name` 是玩家名，`.ui-panel-status-title` 是状态条的标题（「手记」），默认隐藏，主题用 `display: block` 打开
- `.ui-panel-tabbar` / `.ui-panel-tab` / `.ui-panel-tab-icon`：`panelTabs: "bar"` 时右侧面板的页签条、页签和页签图标（当前页签带 `data-state="active"`）。页签放不下时页签条末尾出现 `.ui-panel-tab-menu` 按钮，点开是全部页签的网格
- `.ui-scroll-fade`：放不下而横向滚动的条（页签条、世界缩略图条）。被截断的一侧渐隐，由 `data-fade-start` / `data-fade-end` 标出是哪一侧
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
- `.ui-session-backdrop`：中央面板顶部的世界装饰图和渐隐层；可加静态遮罩使其融入半透明底色。
- `.ui-session-scene-scrim`：`backdrop: "scene"` 时盖在场景图上的暗化层
- `.ui-scene-hud`：`backdrop: "scene"` 时叠在场景图左下的在场角色与玩家状态；`.ui-scene-card` 是其中每块半透明底板，`.ui-scene-cast[data-focused="true"]` 是当前焦点角色，`.ui-scene-speaking` 是「正在说话」标记
- `.ui-chapter-banner`：`backdrop: "banner"` 时第一条消息上方的章节横幅；`.ui-chapter-banner-scrim` 是图上的暗化层
- `.ui-status-meters`：玩家状态量表（面板状态条与场景 HUD 共用），量表本身沿用 `.ui-meter-track` / `.ui-meter-fill`
- `.ui-status-items` / `.ui-status-item`：玩家随身物品的列表和单个物品标签（同样两处共用）
- `.ui-panel-dialog`：插件面板「放大」后的大对话框
- `.ui-summary`：状态摘要的「标签—内容」列表（无范围的数值属性和插件提供的 `session.summary@1` 条目）；`.ui-summary-label` 是标签，`.ui-summary-value` 是内容，带 `data-tone="info" | "success" | "warning" | "danger"`
- `.ui-turn-updates`：每回合只读结果的折叠块（`<details>`，展开时带 `[open]`）；`turnNotes: "margin"` 时它就是页边批注
- `.ui-choice-list` / `.ui-choice`：供玩家选择的选项（插件用 `ChoiceList` / `Choice` 组件声明）。`.ui-choice` 是一个按钮，选中带 `data-selected="true"`，里面依次是 `.ui-choice-index`（序号，默认隐藏；内容是 CSS 计数器 `ui-choice`，主题可以改成汉字数字或键帽）、`.ui-choice-content`（含 `.ui-choice-title` 和 `.ui-choice-body`）、`.ui-choice-eyebrow`（标签，`data-tone` 在 `.ui-choice` 上）。选项下方带次要动作时，外面多一层 `.ui-choice-row`，动作在 `.ui-choice-actions` 里。舞台视图决策面板里的选项另带 `.ui-stage-choice-item`（入场动画与焦点环）
- `.ui-story-surface`：消息流、待发送区和输入框的共同容器；`backdrop: "scene"` 时就是右侧的故事栏，底色取 `--surface-story`
- `.ui-message-row`：带 `data-role="user" | "assistant"`
- `.ui-message-role`：消息上方的角色标签（「玩家」/「助手」），主题可隐藏或改成行内标记
- `.ui-player-message-row`
- `.ui-message-player`
- `.ui-message-assistant`
- `.ui-composer`：输入区外层
- `.ui-composer-frame`
- `.ui-composer-input`
- `.ui-composer-submit`
- `.ui-world-heading`、`.ui-world-enter`、`.ui-world-tag`、`.ui-world-tile`、`.ui-world-row`、`.ui-world-showcase`、`.ui-world-thumb`：世界选择页各排法的标题、主按钮（进入或继续）、标签和条目
- `.ui-world-continue`、`.ui-world-search`：`worldList: "cards"` 时列表上方的「继续上次的冒险」横幅和搜索框

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
| `data-layout`  | 布局预设名                                 | 当前主题的布局预设   |

布局的各选项另有 `data-nav`、`data-panel-tabs`、`data-backdrop`、`data-world-list`、`data-turn-notes`（取值见 §3.1）。

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
- **生效方式**：`applyTokenOverrides()` 把 `{...shared, ...当前 scheme}` 作为**内联 style 写到 `<html>`**，优先于主题包的普通声明；源主题的 `!important` 声明仍可压过覆盖，因此可调 token 应避免使用 `!important`。上一轮写入但本轮已移除的属性会被显式清掉，不留孤儿。非法 CSS 值由 CSSOM 直接丢弃——失败即回落到主题自己的值。
- **基线读取**：`readTokenDefaults()` 临时撤下覆盖读出主题原值，再在同一同步块里恢复，所以控件能显示「未覆盖时是什么」且浏览器不会画出中间态。
- **另存为主题**：`theme-export.ts` 的 `buildThemeCss()` 接收当前主题定义，将源 CSS 的作用域重绑定到新 ID，再追加完整 token 快照。伪元素、渐变、媒体查询、回合状态和 `@layer` 顺序全部保留；源 CSS 的 `!important` 优先级不变。`theme-css-derive.ts` 只替换选择器和动画标识符，不通过 CSSOM 重新序列化，因此不会丢弃当前浏览器尚未支持的规则。动画定义、`animation` / `animation-name` 及其引用的自定义属性同步使用新主题独立的动画名。再次另存时只替换生成的尾部快照，不累积源规则或动画名称前缀。源 CSS 与最终产物均走导入校验，产物不依赖原主题 ID，可以按 §8 导出、删除原主题后重新导入。`slugifyThemeId()` / `ensureThemeId()` 生成不冲突的主题 ID。

覆盖是**全局的、不按主题分桶**（`ui.appearanceTokens` 只有 `shared` / `light` / `dark` 三个桶）：换主题后同一批覆盖继续叠加在新主题之上。想回到主题原貌需显式清除覆盖（`clearOverrides` / 逐项 `clearTokenOverride`）。写入前经 `isAdjustableToken` 过滤——只有 `TOKEN_GROUPS` 声明过的 token 能被覆盖，任意 CSS 变量无法经此通道注入。

外观微调和重置等待真实持久化结果：保存失败时显示错误，撤销本次失败草稿与预览，恢复已保存值；更晚发起的编辑不被旧失败回调撤销。提交正常返回但被忽略（例如空的长度输入）时，也按实际保存值重绘预览；旧提交完成不覆盖后来编辑。覆盖订阅的回滚重绘也会保留仍待提交的新预览。关闭面板或切换明暗模式时仍提交原模式的待保存编辑，但迟到回调不会重绘新面板或新模式。

主题库应用、导入和另存为主题都等待 `ui.appearance` 持久化；失败不继续清覆盖、清名称或报告完整成功。已保存的自定义主题记录可以保留，主题记录、选择与覆盖之间不提供跨步骤自动回滚事务。

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

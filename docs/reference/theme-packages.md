# 主题包

主题包决定 Covel 界面的样子：颜色、字体、圆角，以及导航和面板怎么摆。这一页是主题包的正式契约，列出它的文件格式、每个字段、可以覆盖的变量和可以用的类名。

它面向两类读者：

- 想稳定分发主题包的高级玩家
- 维护 Covel 前端主题系统的开发者

想一步步做出第一个主题，先看[做一个主题](../recipes/themes.md)。

本页会反复用到三个词：

- **token**：主题可以改的一个 CSS 变量，例如 `--color-background`。
- **hook**：框架放在界面元素上的固定类名，例如 `.ui-composer`。主题用它给某一块单独写样式。
- **布局**：结构上的选择，例如导航在顶部还是左侧。

## 1. 主题系统入口

主题系统由这几部分组成：

| 部分                | 位置                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 运行时注册表        | `apps/web/src/theme-system/registry.ts`                                                                                            |
| 运行时样式注入      | `apps/web/src/theme-system/runtime.ts`                                                                                             |
| 导入解析            | `apps/web/src/theme-system/validate.ts`                                                                                            |
| 持久化              | `apps/web/src/theme-system/storage.ts`                                                                                             |
| 内置主题包          | `apps/web/src/themes/builtins/*`                                                                                                   |
| 布局预设（见 §3.1） | `layout.ts`（预设表、校验、发布到 `<html>`）· `use-theme-layout.ts`（组件读取当前布局）· 结构样式 `apps/web/src/styles/layout.css` |
| 外观工作室（见 §9） | token 覆盖 `overrides.ts` · 可编辑 token 清单 `token-schema.ts` · 另存为主题 `theme-export.ts` · 颜色工具 `color.ts`               |

当前主题和布局写在 `<html>` 元素上。切换主题就是改这些属性：

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

- `ui.appearance` 这个设置保存主题包的 ID，并写成 `data-theme`。默认值是 `stage`（舞台）。已经保存的主题选择保持不变。
- 主题包的 `layout` 解析之后，写成 `data-layout` 和各个选项属性（见 §3.1）。没有单独的布局设置项：布局跟着主题包切换。
- `ui.scheme` 保存颜色模式（明 / 暗），并写成 `data-scheme` 和 Tailwind 兼容的 `.dark` 类。
- 主题包的 `schemes` 决定它支持哪些颜色模式。只支持一种模式的主题会自动把 `ui.scheme` 改成它支持的那个值。

## 2. 支持的导入格式

主题包可以是一个 CSS 文件，也可以是一个 JSON 文件。

### 2.1 CSS 文件

运行时从 CSS 里找 `data-theme` 选择器，从中读出主题 ID：

```css
html[data-theme="ember"] {
  --color-background: #14171d;
}

html[data-theme="ember"].dark {
  --color-background: #090b10;
}
```

解析规则：

- 至少要出现一个 `html[data-theme="..."]` 选择器。
- 一个 CSS 文件只能声明一个主题 ID。
- 只有这个主题 ID 的选择器带了 `.dark`，运行时才认为它的 `schemes` 是 `["light", "dark"]`。
- 其他的 `.dark` 选择器不影响颜色模式的推断。

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

CSS 文件里没有地方声明 `layout`，所以按 CSS 导入的主题使用 `classic` 布局。需要其他布局时用 JSON 格式。

> [!WARNING]
> **主题 CSS 是不可信内容。** 它与设置页共用一个文档，仍可改变或遮挡界面；只导入你愿意使用的主题。`@import` 被拒绝，页面 CSP 禁止从外部主机加载样式、字体和图片，包括 CSS 的 `url()`、`image-set()` 和 `@font-face`。本源、内嵌图片和本地字体仍可使用。
>
> 导入主题文件或在外观工作室提交背景时，普通 `url(https://…)` 图片先下载成内嵌数据，再保存。只接受 PNG、JPEG、WebP、GIF 和 AVIF，每张最多 5 MiB，15 秒超时。图片主机须允许跨域读取（CORS）；请求不带凭据或 referrer。下载失败则不保存本次修改。远程字体和转义形式的远程 URL 不受支持；已有主题的外链资源须重新导入图片或改成本地资源。备份和原始 JSON 不会自动下载图片，CSP 仍然生效。

## 3. JSON 字段契约

| 字段          | 类型                               | 说明                                           |
| ------------- | ---------------------------------- | ---------------------------------------------- |
| `id`          | `string`                           | 主题 ID，匹配 `/^[a-z0-9][a-z0-9-]{1,47}$/`    |
| `label`       | `string \| Record<string, string>` | 显示名称                                       |
| `schemes`     | `("light" \| "dark")[]`            | 支持的颜色模式；省略时为 `["light", "dark"]`   |
| `description` | `string \| Record<string, string>` | 可选说明                                       |
| `layout`      | `ThemeLayoutSpec`                  | 可选布局声明，见 §3.1；省略时为 `classic`      |
| `group`       | `string`                           | 可选分组 ID，格式同 `id`，见 §3.2              |
| `groupLabel`  | `string \| Record<string, string>` | 可选分组显示名，见 §3.2                        |
| `cssText`     | `string`                           | 主题 CSS 内容，必须只声明与 `id` 相同的主题 ID |

### 3.1 布局预设（`layout`）

token 和 hook 只能改外观。下面这些是结构，由主题包的 `layout` 声明：

- 导航放在哪；
- 右侧面板的页签长什么样；
- 会话怎样使用世界的美术；
- 世界列表怎么排；
- 每回合的结果放在哪。

写法是先选一个预设，再按需要覆盖单个选项：

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

每个选项的取值：

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
|             | `cards`    | 上图下文的卡片（三列），顶部有“继续上次的冒险”和搜索框；封面悬停轮播场景图          |
|             | `list`     | 一行一个世界的阅读列表                                                              |
|             | `showcase` | 选中世界的封面和场景图轮播铺满全屏，立绘排在简介下方，其他世界排成缩略图条          |
| `turnNotes` | `fold`     | 每回合的只读结果（检定、状态变化、新发现）折叠在正文下方                            |
|             | `inline`   | 最新一回合的结果默认展开，更早的仍然折叠                                            |
|             | `margin`   | 结果放在正文旁的页边栏；会话区不够宽时退回正文下方                                  |

每个预设对应的选项：

| 预设      | `nav`  | `panelTabs` | `backdrop` | `worldList` | `turnNotes` |
| --------- | ------ | ----------- | ---------- | ----------- | ----------- |
| `classic` | `top`  | `rail`      | `ambient`  | `covers`    | `fold`      |
| `book`    | `top`  | `bar`       | `banner`   | `list`      | `margin`    |
| `stage`   | `top`  | `bar`       | `scene`    | `showcase`  | `inline`    |
| `panel`   | `rail` | `bar`       | `none`     | `cards`     | `inline`    |

规则：

- **取值是固定的。** 只能用上表列出的值，对象里不允许出现不认识的键。JSON 导入时 `layout` 不合法，整个主题包被拒绝。已经存下来的主题包里不合法的 `layout` 会被丢弃，回到 `classic`。
- **结构样式认选项，不认主题。** 框架的结构样式按**选项**属性匹配（例如 `html[data-backdrop="scene"]`），不按主题 ID，也不按预设名。所以只覆盖了一个选项的自定义主题包，同样得到对应的结构。
- **给开发者。** 组件通过 `useThemeLayout()` 读取当前布局。新增一个结构选项，需要同时改三处：`layout.ts` 的枚举和预设表、使用它的组件、本节的表格。
- **另存为主题包**会带上来源主题的 `layout`。

### 3.2 风格与配色分组（`group`）

设置里的“风格方案”按 `group` 把主题包归成卡片。`group` 相同的主题包是同一个风格，每个成员是这个风格下的一种配色。没有声明 `group` 的主题包自成一个风格，分组 ID 就是它自己的 `id`。

- **每个成员仍是完整的主题包**，可以单独选中。`ui.appearance` 存的始终是主题包 ID，没有单独的“配色”设置项。
- **卡片的名字**按这个顺序取：
  1. 第一个声明了 `groupLabel` 的成员；
  2. 都没有声明时，`id` 和分组 ID 相同的那个成员的 `label`；
  3. 再没有，第一个成员的 `label`。

  内置主题排在前面，所以导入的主题包改不掉内置分组的名字。

- **配色的名字**是成员自己的 `label`。`id` 和分组 ID 相同的成员显示为“默认”。
- **卡片的缩略图、说明和布局**取当前选中的成员；都没选中时取第一个成员。框架不要求同组成员的布局一致，但同组混用不同的布局会让玩家困惑。
- **另存为主题包**会把新主题包归入来源主题的分组，作为这个风格下的一种新配色。
- **给某个风格加配色**：导入一个 `group` 指向这个风格的主题包即可，例如 `"group": "panel"`。

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

- `panel`（面板）、`book`（书卷）、`stage`（舞台）是三套“风格方案”。它们各自声明一个同名的布局预设，是写带布局的主题包时的参考实现。
- `paper` / `modern` / `abyss` / `aurora` 使用 `classic` 布局，并声明 `"group": "classic"`。在设置里，它们合成一个“经典”风格的四种配色。
- `aurora` 是效果的参考实现：玻璃拟态、流光、消息入场动画，以及 §6.6 的状态驱动特效。想写一个“花哨”的主题，直接照它写。

`aurora` 的流光是这样做的：用 `transform` 旋转一个静态的渐变图层。图层的尺寸按视口对角线加上模糊的留白来定，所以旋转时横屏竖屏都盖得住。它不逐帧修改渐变的角度，这样滚动时浏览器不必反复重新绘制。

`manifest.json` 结构：

```json
{
  "id": "paper",
  "label": {
    "zh-CN": "纸本",
    "en-US": "Paper"
  },
  "source": "builtin",
  "schemes": ["light", "dark"],
  "description": {
    "zh-CN": "温暖、偏叙事阅读器的纸本风格。",
    "en-US": "A warm editorial reading style."
  },
  "group": "classic",
  "groupLabel": {
    "zh-CN": "经典",
    "en-US": "Classic"
  }
}
```

带布局的内置主题在 manifest 里多一个 `layout` 字段，例如 `"layout": { "preset": "book" }`。

## 5. 共享 token 契约

主题包最核心的工作是覆盖语义 token。下面按类别列出全部 token。

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
- `--surface-session`：游戏中央面板的底色。没有设置时用 `--surface-page`。可以用半透明色，让底层的主题流光透出来。
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

先说可以用哪些字体：

- **中文字体用系统自带的**，例如 `"PingFang SC"`、`"Microsoft YaHei"`、`"Songti SC"`。应用不从字体服务加载中文网络字体：它们体积大，加载过程中会让整页文字反复重排，字体服务连不上时还会拖慢首屏。
- **随应用打包的拉丁字体**：`"Inter"`、`"Fraunces"`、`"Newsreader"`、`"Geist"` 和 `"Geist Mono"`。主题包可以直接在字体栈里写这些名字。
- **随应用打包的一款中文标题字体**：`"ZCOOL XiaoWei"`（站酷小薇）。主题包可以直接在字体栈里写这个名字，但不要给它设粗体，因为它只有 400 一个字重。
- **主题包不能 `@import`。** 所以字体栈里其余的中文字体都应该是系统字体，并以通用族名（`sans-serif` / `serif`）结尾。

打包字体的细节：

- 拉丁字体：SIL OFL 1.1，来自 `@fontsource-variable/*` 包，字体声明在 `apps/web/src/styles/fonts.css`。只打包了拉丁子集和内置主题用到的样式（Fraunces、Newsreader 含 400 斜体；字重是可变轴）。首屏不向任何字体服务发请求，离线和桌面端的表现一致。
- 这些字体用 `font-display: block`。本地文件几毫秒就能就绪，所以不会出现先用后备字体、再换字体的整页重排。
- `"ZCOOL XiaoWei"`：OFL 1.1，文件在 `apps/web/public/fonts/zcool-xiaowei/`，字体声明在 `apps/web/src/styles/fonts.css`。只有当某个主题用到这个字体族时它才会被读取。`stage` 用它做标题。

token 列表：

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
- `--story-color`（叙事正文的颜色，默认跟随 `--color-foreground`；外观设置按明暗模式分别保存）
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

这些 token 作用在哪：

- 普通 Markdown 的正文、标题、强调和引用用主题的文字色；链接和行内代码用主题的主色。
- 叙事区域的正文、标题、强调和引用用 `--story-color`。
- 叙事 Markdown 的字号、行高、字重、字距和栏宽由 `--story-*` 控制。
- 样式在 `apps/web/src/styles/narrative.css`。它用不分层的规则来覆盖 Typography 在 `utilities` 层里的默认值。

### 5.6 阴影 token

- `--shadow-card`
- `--shadow-dialog`
- `--shadow-pop`

## 6. 共享语义 hook 契约

下面是框架放在界面元素上的类名。主题可以用它们给某一块单独写样式。

### 6.1 结构层

| hook                                                        | 是什么                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `.ui-app-header`                                            | 顶部导航条                                                                                                          |
| `.ui-nav-rail`                                              | `nav: "rail"` 时的左侧导航栏                                                                                        |
| `.ui-nav-item`                                              | 导航项。两种导航共用，当前项带 `aria-current="page"`                                                                |
| `.ui-session-header`                                        | 会话顶部工具条，里面的类名见下                                                                                      |
| `.ui-session-thumb`                                         | 工具条里世界名前面的世界缩略图。默认隐藏，主题用 `display: block` 打开并给出尺寸                                    |
| `.ui-panel-status`                                          | `panelTabs: "bar"` 时，右侧面板页签下方的玩家状态条，里面的类名见下                                                 |
| `.ui-panel-tabbar` / `.ui-panel-tab` / `.ui-panel-tab-icon` | `panelTabs: "bar"` 时右侧面板的页签条、页签和页签图标。当前页签带 `data-state="active"`                             |
| `.ui-panel-tab-menu`                                        | 页签放不下时，页签条末尾出现的按钮。点开是全部页签的网格                                                            |
| `.ui-scroll-fade`                                           | 放不下而横向滚动的条（页签条、世界缩略图条）。被截断的一侧渐隐，由 `data-fade-start` / `data-fade-end` 标出是哪一侧 |

没有额外说明的 hook：

- `.ui-panel-header`
- `.ui-panel-section`
- `.ui-panel-footer`
- `.ui-rule`
- `.ui-outline-rail`

`.ui-session-header` 里面：

- `.ui-session-title`：标题。`backdrop: "scene"` 且有场景名时是场景名，否则是世界名。
- `.ui-view-switch`：“文本 / 舞台”切换。选中项带 `data-state="on"`。
- `.ui-session-action`：返回、设置、更多、面板开关这些按钮。
- `.ui-menu-item`：“更多”菜单里的条目。

`.ui-panel-status` 里面：

- `.ui-panel-status-name`：玩家名。
- `.ui-panel-status-title`：状态条的标题（“手记”）。默认隐藏，主题用 `display: block` 打开。

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

| hook                                                                                                                                | 是什么                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `.ui-session-backdrop`                                                                                                              | 中央面板顶部的世界装饰图和渐隐层。可以加一层静态遮罩，让它融进半透明的底色                             |
| `.ui-session-scene-scrim`                                                                                                           | `backdrop: "scene"` 时盖在场景图上的暗化层                                                             |
| `.ui-scene-hud`                                                                                                                     | `backdrop: "scene"` 时叠在场景图左下角的在场角色和玩家状态，里面的类名见下                             |
| `.ui-chapter-banner`                                                                                                                | `backdrop: "banner"` 时第一条消息上方的章节横幅；`.ui-chapter-banner-scrim` 是图上的暗化层             |
| `.ui-status-meters`                                                                                                                 | 玩家状态量表。面板状态条和场景 HUD 共用；量表本身沿用 `.ui-meter-track` / `.ui-meter-fill`             |
| `.ui-status-items` / `.ui-status-item`                                                                                              | 玩家随身物品的列表和单个物品标签。同样两处共用                                                         |
| `.ui-panel-dialog`                                                                                                                  | 插件面板“放大”后的大对话框                                                                             |
| `.ui-summary`                                                                                                                       | 状态摘要的“标签—内容”列表：没有范围的数值属性，以及插件提供的 `session.summary@1` 条目。里面的类名见下 |
| `.ui-turn-updates`                                                                                                                  | 每回合只读结果的折叠块（`<details>`，展开时带 `[open]`）。`turnNotes: "margin"` 时它就是页边批注       |
| `.ui-choice-list` / `.ui-choice`                                                                                                    | 给玩家选的选项（插件用 `ChoiceList` / `Choice` 组件声明），里面的类名见下                              |
| `.ui-story-surface`                                                                                                                 | 消息流、待发送区和输入框的共同容器。`backdrop: "scene"` 时它就是右侧的故事栏，底色取 `--surface-story` |
| `.ui-message-row`                                                                                                                   | 带 `data-role="user" \| "assistant"`                                                                   |
| `.ui-message-role`                                                                                                                  | 消息上方的角色标签（“玩家” / “助手”）。主题可以隐藏它，或改成行内标记                                  |
| `.ui-composer`                                                                                                                      | 输入区外层                                                                                             |
| `.ui-world-heading`、`.ui-world-enter`、`.ui-world-tag`、`.ui-world-tile`、`.ui-world-row`、`.ui-world-showcase`、`.ui-world-thumb` | 世界选择页各种排法的标题、主按钮（进入或继续）、标签和条目                                             |
| `.ui-world-continue`、`.ui-world-search`                                                                                            | `worldList: "cards"` 时列表上方的“继续上次的冒险”横幅和搜索框                                          |

没有额外说明的 hook：

- `.ui-session-column`
- `.ui-player-message-row`
- `.ui-message-player`
- `.ui-message-assistant`
- `.ui-composer-frame`
- `.ui-composer-input`
- `.ui-composer-submit`

`.ui-scene-hud` 里面：

- `.ui-scene-card`：每一块半透明的底板。
- `.ui-scene-cast[data-focused="true"]`：当前焦点角色。
- `.ui-scene-speaking`：“正在说话”标记。

`.ui-summary` 里面：

- `.ui-summary-label`：标签。
- `.ui-summary-value`：内容，带 `data-tone="info" | "success" | "warning" | "danger"`。

`.ui-choice` 是一个按钮，选中时带 `data-selected="true"`。它里面依次是：

- `.ui-choice-index`：序号，默认隐藏。内容是 CSS 计数器 `ui-choice`，主题可以把它改成汉字数字或键帽。
- `.ui-choice-content`：含 `.ui-choice-title` 和 `.ui-choice-body`。
- `.ui-choice-eyebrow`：标签。它的 `data-tone` 写在 `.ui-choice` 上。

选项下方带次要动作时，外面多一层 `.ui-choice-row`，动作在 `.ui-choice-actions` 里。舞台视图决策面板里的选项另外带 `.ui-stage-choice-item`（入场动画和焦点环）。

### 6.5 细节效果

- `.ui-meter-track`
- `.ui-meter-fill`
- `.ui-pulse-dot`
- `.ui-cursor`

### 6.6 状态属性（状态驱动特效）

除了类名，框架还把当前回合的状态写在 `<html>` 上。这样纯 CSS 就能对游戏里正在发生的事做出反应：

| 属性           | 取值                                       | 含义                 |
| -------------- | ------------------------------------------ | -------------------- |
| `data-turn`    | `idle` / `executing` / `waiting` / `error` | 回合活动状态         |
| `data-session` | `active` / `paused` / `ended`              | 会话生命周期         |
| `data-theme`   | 主题 ID                                    | 当前主题（作用域用） |
| `data-scheme`  | `light` / `dark`                           | 当前明暗模式         |
| `data-layout`  | 布局预设名                                 | 当前主题的布局预设   |

布局的各个选项另有 `data-nav`、`data-panel-tabs`、`data-backdrop`、`data-world-list`、`data-turn-notes`，取值见 §3.1。

`waiting` 优先于 `executing`：回合还开着，但内核在等玩家操作（表单、选择）。这才是值得高亮的状态。

```css
/* AI 正在生成时，输入框呼吸 */
html[data-theme="my-theme"][data-turn="executing"] .ui-composer-input {
  animation: my-breathe 2.4s ease-in-out infinite;
}
```

> [!NOTE]
> 这些属性由框架自己发布，只覆盖内核知道的状态。插件专属的状态（场景、情绪、战斗）目前不能用来驱动主题：框架不会写死插件 ID，这需要一条按能力声明的通道，现在还没有开放。

## 7. 运行时行为

导入主题时，运行时按这个顺序做：

1. 读取文件内容
2. 解析主题 ID 和 CSS
3. 验证导入格式
4. 保存到本地设置
5. 注入 `<style data-theme-style="theme-id">`
6. 重新注册到 `ui.appearance`
7. 根据 `schemes` 校正 `ui.scheme`
8. 在设置面板和主题库中显示

## 8. 持久化行为

自定义主题保存在 `ui.customThemes` 这个设置项里。每条记录包含：

- `id`
- `label`
- `cssText`
- `schemes`
- `description`
- `layout`
- `group`
- `groupLabel`
- `importedAt`
- `fileName`

运行时把这些记录恢复成 `ThemeDefinition`，和内置主题一起排序、注册。

## 9. 外观工作室（token 覆盖 / 另存为主题）

玩家不写 CSS 也能改外观。“设置 → 外观”为每个可调的 token 提供一个控件。哪些 token 可以改、用什么控件、有哪些预设值，由 `token-schema.ts` 的 `TOKEN_GROUPS` 定义，其中包括字体栈 `FONT_STACKS` 和氛围底纹 `AMBIENCE_PRESETS`。

**覆盖值存在哪。**

- 存在设置项 `ui.appearanceTokens` 里，形状是 `{ shared, light, dark }`。
- **颜色按明暗模式分开存；尺寸、字体、圆角在两种模式之间共用。**
- 单个值最长 2048 个字符。这是为了防止有人粘贴 data-URL 撑爆 localStorage 的配额，连累其他设置。

**覆盖是全局的，不按主题分开存。** `ui.appearanceTokens` 只有 `shared` / `light` / `dark` 三个桶。换主题之后，同一批覆盖继续叠在新主题上。想回到主题原来的样子，需要明确清除覆盖（`clearOverrides`，或逐项 `clearTokenOverride`）。

**覆盖怎样生效。**

- `applyTokenOverrides()` 把 `{...shared, ...当前 scheme}` 作为**内联 style 写到 `<html>` 上**，所以它优先于主题包的普通声明。
- 源主题里带 `!important` 的声明仍然能压过覆盖。因此可调的 token 应该避免使用 `!important`。
- 上一轮写入、这一轮已经移除的属性会被明确清掉，不留残余。
- 不合法的 CSS 值由浏览器（CSSOM）直接丢弃，结果就是回到主题自己的值。
- 写入之前经过 `isAdjustableToken` 过滤：只有 `TOKEN_GROUPS` 声明过的 token 能被覆盖。任意的 CSS 变量不能通过这条通道注入。

**控件怎样知道“没覆盖时是什么”。** `readTokenDefaults()` 临时撤下覆盖，读出主题的原值，再在同一个同步块里恢复。所以控件能显示原值，浏览器也不会画出中间的状态。

**另存为主题。** `theme-export.ts` 的 `buildThemeCss()` 接收当前的主题定义，把源 CSS 的作用域改绑到新的 ID 上，再在末尾追加一份完整的 token 快照。

- 伪元素、渐变、媒体查询、回合状态和 `@layer` 的顺序全部保留。源 CSS 里 `!important` 的优先级不变。
- `theme-css-derive.ts` 只替换选择器和动画标识符，不经过 CSSOM 重新序列化。所以当前浏览器还不支持的规则不会被丢掉。
- 动画定义、`animation` / `animation-name`，以及引用它们的自定义属性，一起改用新主题自己的动画名。
- 再次另存时，只替换末尾那份生成的快照，不会越存越多地累积源规则或动画名前缀。
- 源 CSS 和最终产物都要通过导入校验。产物不依赖原主题的 ID：可以按 §8 导出，删掉原主题后重新导入。
- `slugifyThemeId()` / `ensureThemeId()` 生成不冲突的主题 ID。

**保存失败时。** 外观微调和重置都等待真实的持久化结果：

- 保存失败时显示错误，撤销这一次失败的草稿和预览，恢复已保存的值。在它之后才发起的编辑不会被旧的失败回调撤销。
- 提交正常返回、但实际被忽略时（例如长度输入是空的），也按实际保存的值重新画预览。旧的提交完成时，不覆盖后来的编辑。
- 覆盖订阅引起的回滚重绘，同样保留还在等待提交的新预览。
- 关闭面板或切换明暗模式时，仍然会提交原模式下还没保存的编辑。但迟到的回调不会重绘新的面板或新的模式。

主题库里的“应用”、导入和另存为主题，都等 `ui.appearance` 持久化完成：

- 失败时不会继续清覆盖、清名称，也不会报告“完全成功”。
- 已经保存的自定义主题记录可以保留。主题记录、选择和覆盖这三步之间，没有跨步骤的自动回滚。

## 10. 兼容性建议

想让主题包长期稳定可用，推荐这样做：

- 优先覆盖 token
- 局部视觉差异使用 `.ui-*` hook
- 亮色与暗色都提供完整的前景色和边界色
- 叙事主题显式覆盖 `--story-*` token
- 工具主题显式覆盖 `--surface-*`、`--radius-*`、`--title-*` token

<a id="10-参考示例"></a>

## 11. 参考示例

内置主题可以当作实际的参考：

- `apps/web/src/themes/builtins/modern/theme.css`
- `apps/web/src/themes/builtins/paper/theme.css`
- `apps/web/src/themes/builtins/abyss/theme.css`

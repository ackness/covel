# 制作和分享主题

这一页讲怎样给 Covel 换一套自己的界面：颜色、字体、圆角，甚至界面的结构。它写给玩家和设计师，也写给愿意手写一点 CSS 的人。

有两条路，可以只走第一条：

- **不写代码**：在设置里挑一套接近的风格，调到满意，存成自己的主题。约十分钟。
- **手写 CSS**：写一个主题文件，可以加动画、玻璃效果这类设置里调不出来的东西。

两条路做出来的都是同一种东西，叫**主题包**：一个可以导出、发给别人、再导入的文件。

## 先认识几个词

打开 **设置 → 外观**，会看到这几样：

| 界面上的名字 | 是什么                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| 风格方案     | 一张张卡片，每张是一种风格。内置的有“面板”“书卷”“舞台”和“经典”。风格之间不只颜色不同，界面的结构也不同 |
| 配色         | 同一种风格下的几套颜色。“经典”下面有“纸本”“现代”“深渊”“极光”四种                                       |
| 颜色模式     | 亮色或暗色。有的主题只有一种，这时开关会自动锁定                                                       |
| 精细调整     | 在当前主题的基础上，一项一项地改颜色、字体和尺寸                                                       |
| 主题库       | 你导入和保存的主题都在这里，可以应用、导出、删除                                                       |

每一种配色都是一个完整的主题包。你做的主题最后也会成为某个风格下的一种配色，或者自成一个风格。

## 路线一：不写代码

### 1. 选一套最接近的风格

在 **设置 → 外观 → 风格方案** 里点一张卡片，选中后立即生效。有多种配色的风格，在卡片下面的“配色”里再选一种。

先选对风格很重要，因为界面的结构是跟着风格走的：

| 风格 | 导航     | 右侧面板的页签 | 游戏里的世界图   | 世界列表       | 每回合的结果       |
| ---- | -------- | -------------- | ---------------- | -------------- | ------------------ |
| 经典 | 顶部     | 竖排的图标     | 顶部一层很淡的图 | 整张封面的卡片 | 折叠在正文下方     |
| 书卷 | 顶部     | 带文字的页签   | 开头的章节横幅   | 阅读列表       | 放在正文旁的页边   |
| 舞台 | 顶部     | 带文字的页签   | 场景图铺满       | 封面展示       | 最新一回合默认展开 |
| 面板 | 左侧图标 | 带文字的页签   | 不显示           | 上图下文的卡片 | 最新一回合默认展开 |

这些结构在设置里改不了。你存出来的主题会沿用所选风格的结构。

### 2. 在“精细调整”里改

往下找到“精细调整”。可以调的东西按区域分成八组，点开一组就能改：

| 分组       | 能改什么                                           |
| ---------- | -------------------------------------------------- |
| 叙事正文   | 故事文字的颜色、字体、字号、行高、字重、字距、栏宽 |
| 界面文字   | 界面的字体、标题和小标签的样式                     |
| 区域背景   | 页面、侧栏、卡片、对话框、玩家消息的底色           |
| 文字与描边 | 文字颜色、次要文字颜色、主色、分隔线               |
| 强调色     | 主强调色、次强调色，以及成功、警告、危险的颜色     |
| 氛围背景   | 背景底纹和它的浓淡                                 |
| 形状与投影 | 卡片、按钮、对话框的圆角，卡片的阴影               |
| 区域尺寸   | 各个面板的宽度、高度与内边距                       |

“叙事正文”一组带一块“阅读预览”，改的时候能直接看到效果。

要知道的三件事：

- **颜色按模式分开保存。** 你在亮色模式下改的颜色只作用于亮色模式。切到暗色模式要再调一遍。字体、字号、圆角和尺寸是两种模式共用的。
- **调整不跟着主题走。** 换了一套主题，你改过的那些项还会叠在新主题上。想看新主题的原貌，点“全部重置”。
- **每一项都能单独恢复。** 点那一项旁边的重置按钮，就回到主题的默认值。

### 3. 存成自己的主题

在“精细调整”里找到“另存为主题包”，填一个名字，点“另存为”。

Covel 会把当前的主题和你的全部调整合成一个独立的新主题，然后自动切换过去，并清空“精细调整”里的改动，因为那些值已经在新主题里了。原主题的渐变、动画和玻璃效果都会保留。

新主题出现在两个地方：

- “风格方案”里，作为原来那个风格下的一种新配色。
- “主题库”里，标着“自定义”。

用同一个名字再存一次，会更新这个主题，而不是多出一个。

### 4. 导出，发给别人

展开“主题库”，在你的主题那一行点导出。得到一个名为 `<主题ID>.theme.json` 的文件。把它发给别人即可。

对方的导入方法见下面的[导入一个主题](#导入一个主题)。

> [!NOTE]
> “精细调整”右上角也有“导入”和“导出”。那一对按钮导出的只是你改过的那几项，不是完整的主题。要分享完整的主题，用“另存为主题包”之后在“主题库”里导出。

## 导入一个主题

1. 打开 **设置 → 外观**，展开“主题库”。
2. 点“导入主题”，选一个 `.css`、`.json`、`.theme` 或 `.theme.json` 文件。
3. 导入成功后会提示“已导入 ……”，并且立刻切换到这个主题。

导入的主题保存在这台设备的设置里，下次启动还在。换一台设备要重新导入。

> [!WARNING]
> 主题 CSS 能改变或遮挡界面，但页面策略禁止它加载外部资源。背景图片会在导入时下载。格式和限制见[主题包参考](../reference/theme-packages.md)。

## 路线二：手写一个主题

手写主题就是写一段 CSS。Covel 的界面是用一组有名字的“变量”上色的，例如“页面底色”“正文颜色”“卡片圆角”。你的主题给这些变量赋上新的值，界面就变了。不需要知道界面内部的结构。

### 1. 写一个最小的主题

新建一个文件 `ember.css`：

```css
html[data-theme="ember"] {
  --color-background: #f6f2eb;
  --color-foreground: #241f1b;
  --color-card: #fffdf8;
  --color-primary: #7a4b2f;
  --color-border: #d9c8b5;

  --surface-rail: #fffaf2;
  --surface-elevated: #fffdf8;
  --surface-dialog: #fffdf8;

  --radius-card: 1rem;
  --radius-control: 0.75rem;

  --story-font-family: "Newsreader", serif;
  --story-font-size: 1.125rem;
  --story-line-height: 1.8;
}
```

`ember` 是这个主题的 ID。按上一节的方法导入这个文件，它就出现在“风格方案”和“主题库”里，名字取自文件名（`ember.css` 显示为 “Ember”）。

### 2. 加上暗色

再加一段，选择器后面多一个 `.dark`：

```css
html[data-theme="ember"].dark {
  --color-background: #14110f;
  --color-foreground: #f1e7dc;
  --color-card: #1d1916;
  --color-primary: #ddb08c;
  --color-border: #3d322b;
}
```

> [!IMPORTANT]
> CSS 文件里有没有 `.dark` 这一段，决定了这个主题支持哪些颜色模式。没有这一段的 CSS 主题只有亮色模式。想做一个只有暗色的主题，要用下面的 JSON 格式，并写 `"schemes": ["dark"]`。

### 3. 遵守四条规则

导入时 Covel 会检查主题文件，不符合就拒绝，并说明原因。

| 规则                                                                    | 写错时的提示                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 主题 ID 只用小写字母、数字和连字符，以字母或数字开头，长 2 到 48 个字符 | `Theme id must use lowercase letters, numbers, and hyphens.`       |
| 一个文件只用一个主题 ID                                                 | `Theme CSS must use exactly one data-theme id.`                    |
| 每一条规则都以 `html[data-theme="你的ID"]` 开头                         | `Every theme rule must be scoped to [data-theme="…"] — found "…".` |
| 不能用 `@import`                                                        | `Theme CSS must not use @import.`                                  |

另外，不要用内置主题的 ID（`panel`、`book`、`stage`、`paper`、`modern`、`abyss`、`aurora`）。内置主题总是优先，同名的自定义主题会被丢掉。

### 4. 该先改哪些变量

变量很多，但不用全写。没写的变量会用框架的基础值。按这个顺序来，每一步都能看到明显的变化：

| 顺序 | 改什么         | 变量                                                                                                          |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | 主色调         | `--color-background`、`--color-foreground`、`--color-card`、`--color-primary`、`--color-border`               |
| 2    | 各个区域的底色 | `--surface-page`、`--surface-rail`、`--surface-inset`、`--surface-elevated`、`--surface-dialog`               |
| 3    | 圆角           | `--radius-card`、`--radius-control`、`--radius-dialog`                                                        |
| 4    | 故事的阅读感受 | `--story-font-family`、`--story-font-size`、`--story-line-height`、`--story-max-width`、`--story-color`       |
| 5    | 标题           | `--title-font-family`、`--title-font-style`、`--title-font-weight`                                            |
| 6    | 分隔线和强调色 | `--rule-color`、`--rule-style`、`--accent-primary`、`--accent-success`、`--accent-warning`、`--accent-danger` |
| 7    | 阴影和氛围     | `--shadow-card`、`--shadow-dialog`、`--ambience-image`、`--noise-opacity`                                     |

几个容易用错的变量：

- `--surface-session` 是游戏中央区域的底色，没写时用 `--surface-page`。可以写半透明的颜色，让下面的背景效果透出来。
- `--story-color` 只管故事正文的颜色，没写时跟着 `--color-foreground`。
- `--surface-player` 是玩家消息的底色，写 `transparent` 就没有气泡。

全部变量的清单见[主题包参考](../reference/theme-packages.md)的第 5 节。

> [!TIP]
> 你写的变量越完整，玩家在“精细调整”里能在你的主题上改的东西就越多。反过来，玩家可以改掉你的任何一个变量，所以不要指望某个颜色一定不被改动来保证文字看得清。也不要给这些变量加 `!important`，那会让玩家的调整失效。

### 5. 调局部的样子

变量管不到的细节，用界面上一组固定的类名来调。它们都以 `.ui-` 开头，写法是在主题 ID 后面接上类名：

```css
html[data-theme="ember"] .ui-rule {
  border-style: dashed;
}

html[data-theme="ember"] .ui-message-player {
  background: transparent;
  border-width: 0 0 0 2px;
  border-color: var(--color-primary);
  border-radius: 0;
  padding-left: 0.875rem;
}
```

最常用的几个：

| 类名                                          | 是界面的哪一块         |
| --------------------------------------------- | ---------------------- |
| `.ui-app-header`、`.ui-nav-rail`              | 顶部导航条、左侧导航栏 |
| `.ui-panel-header`、`.ui-panel-section`       | 右侧面板的标题和分区   |
| `.ui-panel-tabbar`、`.ui-panel-tab`           | 右侧面板带文字的页签   |
| `.ui-title`、`.ui-eyebrow`                    | 标题、标题上方的小标签 |
| `.ui-narrative`                               | 故事正文               |
| `.ui-message-player`、`.ui-message-assistant` | 玩家的消息、故事的消息 |
| `.ui-composer`、`.ui-composer-input`          | 输入框一带             |
| `.ui-choice-list`、`.ui-choice`               | 给玩家选的选项         |
| `.ui-card-surface`、`.ui-dialog-shell`        | 卡片、对话框           |
| `.ui-chip`、`.ui-rule`                        | 小标签、分隔线         |
| `.ui-turn-updates`                            | 每回合结果的折叠块     |

先改变量，变量做不到再用类名。这样主题在以后的版本里更不容易坏。全部类名见[主题包参考](../reference/theme-packages.md)的第 6 节。

**给选项加上序号。** 玩家按数字键 1 到 9 可以选中对应的选项。序号默认不显示，主题可以把它显示出来，数字、汉字都行：

```css
html[data-theme="ember"] .ui-choice-index {
  display: block;
}
html[data-theme="ember"] .ui-choice-index::before {
  content: counter(ui-choice, cjk-ideographic);
}
```

**让界面随游戏状态变化。** Covel 把“现在回合进行到哪了”写在页面的最外层，主题可以据此加效果。例如模型正在写故事时，让输入框缓缓明暗：

```css
html[data-theme="ember"][data-turn="executing"] .ui-composer-input {
  animation: ember-breathe 2.4s ease-in-out infinite;
}

@keyframes ember-breathe {
  50% {
    opacity: 0.6;
  }
}
```

`data-turn` 的取值是 `idle`（空闲）、`executing`（正在生成）、`waiting`（等玩家填表或选择）、`error`（出错）。还有哪些状态可用，见[主题包参考](../reference/theme-packages.md)的 6.6 节。

内置的“极光”主题是一个可以照抄的例子：渐变图层、玻璃效果、发光，以及上面这种随状态变化的效果，它都用到了。文件在 [`apps/web/src/themes/builtins/aurora/theme.css`](../../apps/web/src/themes/builtins/aurora/theme.css)。

<a id="fonts"></a>

### 6. 字体

主题里不能用 `@import` 引入网络上的字体样式表。字体建议从下面两类里选：

- **随应用自带的字体**，可以直接写名字：`"Inter"`、`"Fraunces"`、`"Newsreader"`、`"Geist"`、`"Geist Mono"`，以及中文标题字体 `"ZCOOL XiaoWei"`（站酷小薇）。
- **玩家系统里的字体**，例如 `"PingFang SC"`、`"Microsoft YaHei"`、`"Songti SC"`。

写字体时总是列几个候选，最后用 `serif` 或 `sans-serif` 收尾：

```css
--story-font-family: "Newsreader", "Songti SC", serif;
```

两点注意：

- 自带的字体只包含拉丁字母。中文正文要靠系统字体。
- `"ZCOOL XiaoWei"` 只有一种粗细。不要给它设粗体。

## 选界面的结构

CSS 只能改外观。导航在顶部还是左侧、页签长什么样、游戏里怎样用世界的图片，这些是结构。要选结构，主题得写成 JSON 格式：

```json
{
  "id": "ember",
  "label": { "zh-CN": "余烬", "en-US": "Ember" },
  "description": { "zh-CN": "暖色的纸本阅读风格" },
  "schemes": ["light", "dark"],
  "layout": { "preset": "book", "nav": "rail" },
  "cssText": "html[data-theme=\"ember\"] { --color-background: #f6f2eb; }"
}
```

| 字段          | 必填 | 意思                                                                               |
| ------------- | ---- | ---------------------------------------------------------------------------------- |
| `id`          | 是   | 主题 ID，规则同上                                                                  |
| `label`       | 是   | 显示的名字。可以是一句话，也可以按语言分别写                                       |
| `cssText`     | 是   | 主题的 CSS，整段放进一个字符串。里面只能用和 `id` 相同的主题 ID                    |
| `schemes`     | 否   | 支持的颜色模式：`["light"]`、`["dark"]` 或 `["light", "dark"]`。不写时算两种都支持 |
| `description` | 否   | 一句说明                                                                           |
| `layout`      | 否   | 界面结构。不写时是 `classic`                                                       |
| `group`       | 否   | 把这个主题放到哪个风格下面，作为它的一种配色                                       |
| `groupLabel`  | 否   | 风格卡片的名字                                                                     |

`layout` 里先用 `preset` 选一套预设：`classic`、`book`、`stage`、`panel`，对应前面表格里的“经典”“书卷”“舞台”“面板”。需要的话再单独改其中一项。上面的例子用了书卷的结构，但把导航换到了左侧。

可以单独改的五项是 `nav`、`panelTabs`、`backdrop`、`worldList`、`turnNotes`，取值见[主题包参考的布局预设](../reference/theme-packages.md#31-布局预设layout)。`layout` 里写了不认识的项或值，整个主题会被拒绝导入。

> [!TIP]
> 手写 JSON 里的 `cssText` 很别扭，因为引号都要转义。更省事的做法是：先导入 CSS 文件，在“主题库”里导出，得到一份已经转好的 JSON，再往里加 `layout`。

### 做某个风格下的一种新配色

想给内置的“面板”风格加一套蓝色，写 `group`：

```json
{
  "id": "panel-ocean",
  "label": { "zh-CN": "海蓝", "en-US": "Ocean" },
  "group": "panel",
  "layout": { "preset": "panel" },
  "cssText": "html[data-theme=\"panel-ocean\"] { /* 完整的变量和类名规则 */ }"
}
```

导入后，“面板”卡片下面的“配色”里会多出“海蓝”。

> [!IMPORTANT]
> 同一个风格下的配色互相不继承。你的配色里没写的变量，用的是框架的基础值，不是“面板”风格的值。想在某个风格的基础上只改几个颜色，最稳妥的办法是走路线一：选中那个风格，调好，另存为主题包，导出后再手改。

不写 `group` 的主题自成一个风格，有自己的一张卡片。

## 把两条路接起来

设置里调基础的颜色和排版很快，手写 CSS 能加特效。两者可以接起来用：

1. 在“精细调整”里把颜色和字体调好。
2. “另存为主题包”。
3. 在“主题库”里导出 JSON。
4. 在 `cssText` 里手写动画、玻璃效果、发光。
5. 重新导入。ID 相同，所以会更新原来的那个主题。

## 一份完整的模板

可以直接复制，把 `my-theme` 换成你的 ID：

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

## 发出去之前检查一遍

- 导入后能在“风格方案”里找到它。
- 亮色和暗色都切一遍，文字在每种底色上都看得清。
- 世界列表、游戏界面、设置这三处都看一眼，风格是一致的。
- 进一局游戏，等一个回合跑完：正文、玩家消息、选项、输入框、右侧面板都正常。
- 把窗口拉窄再看一遍。
- 定了核心颜色、`--surface-rail`、`--surface-elevated`、`--surface-dialog`，以及 `--radius-card` 和 `--radius-control`。偏阅读的主题还定了 `--story-*`。

一个主题只表达一个方向，成品会更完整。常见的三个方向：

| 方向   | 特点                                     |
| ------ | ---------------------------------------- |
| 工具型 | 冷色、紧凑、边界清楚、一屏能看到很多信息 |
| 阅读型 | 暖色、留白多、行高宽松、标题有叙事感     |
| 沉浸型 | 深色、对比柔和、重点区域有光感           |

## 没有按预期工作时

| 现象                                                                               | 原因和处理                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 导入时提示 `Theme CSS must include a selector like html[data-theme="your-theme"].` | 文件里没有任何 `data-theme` 选择器。每条规则都要以它开头                     |
| 导入时提示 `Every theme rule must be scoped to …`                                  | 有一条规则没有以你的主题 ID 开头。提示里引用了那条规则的开头                 |
| 导入时提示 `Theme CSS must use exactly one data-theme id that matches "…".`        | JSON 的 `id` 和 `cssText` 里的主题 ID 不一样                                 |
| 导入时提示 `Theme CSS must not use @import.`                                       | 删掉 `@import`。字体的写法见上面的[字体](#fonts)一节                         |
| 导入成功，但主题没有出现，或者之后不见了                                           | 用了内置主题的 ID。换一个 ID                                                 |
| 导入的 CSS 主题切不到暗色                                                          | 文件里没有 `html[data-theme="…"].dark` 这一段。加上它再导入一次              |
| 改了某个变量，界面没变                                                             | 你在“精细调整”里改过同一项，那里的值优先。点那一项的重置按钮，或者“全部重置” |
| 换了主题，颜色还是怪怪的                                                           | 同上。“精细调整”里的改动不跟着主题走                                         |
| 我的配色里有些地方变成了默认的样子                                                 | 配色不继承同风格的其他成员。没写的变量用的是框架的基础值，要自己写全         |
| 中文没有用上我写的字体                                                             | 那款字体玩家的系统里没有。自带的字体只含拉丁字母，中文要列出系统字体作候选   |

## 接下来

- **查全部变量、类名和字段。** 见[主题包参考](../reference/theme-packages.md)。
- **让自己写的插件界面跟着主题变。** 见[给插件加界面](../plugins/ui.md#让界面跟着风格走)。
- **给世界配封面和场景图。** 有些风格会把世界的图片铺满屏幕，见[世界美术方向](../worlds/art-direction.md)。

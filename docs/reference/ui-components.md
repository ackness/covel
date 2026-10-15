# 界面组件

这一页列出插件界面能用的全部组件：每个组件叫什么、做什么、有哪些主要属性。写 `ui/*.json` 的插件作者在这里查名字和属性。

插件的界面是一份 JSON（UI spec），只能用这里列出的组件来搭。面板和消息块怎样被发现、接上数据并画出来，见[前端面板架构](./ui-panels.md)。

## Authoring tip

- **组件从哪来。** `apps/web/src/lib/catalog.tsx` 导出 `covelRegistry`，各个渲染器按职责放在 `apps/web/src/lib/catalog/` 下。插件只能用注册在这里的组件：词汇由框架定，插件用它来组合。
- **在插件里引用。** 在 `ui/*.json` 里写 `"component": "<Name>"`，名字和下文完全一致。spec 文件通过 `PLUGIN.md` 的 `contributes.ui.right` / `ui.message` 被发现。
- **文字与校验。** spec 里写 English，译文写在 `locales/<locale>.yaml` 的 `messages` 一节（见 [ui-panels.md](./ui-panels.md#插件-ui-文本规范)）。运行 `pnpm check:i18n`：它包含 `check-plugin-i18n`，会拒绝 spec 里的中文，并要求内置插件的每条界面文字都有中文译文。
- **找出这一页还没写到的组件。** 完整的清单随时可以搜出来：

  ```bash
  rg ": ComponentRenderer = |export function createFilterContainer" apps/web/src/lib/catalog.tsx apps/web/src/lib/catalog
  rg "^  [A-Z][a-zA-Z]+," apps/web/src/lib/catalog.tsx   # registry entries
  ```

  代码里有、这一页没有的组件，请补上。以工作区里的文件为准。

## Data bindings cheat sheet

| 需求                 | 写法                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 读状态               | `{ "$state": "/path" }`                                                                                            |
| 读写状态（双向绑定） | `{ "$bindState": "/path" }`                                                                                        |
| 迭代数组             | `repeat: { "statePath": "/path", "key": "id" }`                                                                    |
| 迭代当前项里的子数组 | `repeat: { "statePath": { "$item": "items" }, "key": "id" }`                                                       |
| 读当前项的字段       | `{ "$item": "field" }`                                                                                             |
| 读写当前项的字段     | `{ "$bindItem": "field" }`                                                                                         |
| 当前序号             | `{ "$index": true }`                                                                                               |
| 命名的子区域         | `slots: { "header": [{ "component": "Text" }], "content": [{ "component": "Stack" }] }`                            |
| 变换一个值           | `$format`、`$math`、`$concat`、`$count`、`$truncate`、`$pluralize` 或 `$join`（在 action 的参数里同样可用）        |
| 多语言文字           | 在 `content` / `label` / `placeholder` / `title` / `message` 等属性里写 English，在 `locales/<locale>.yaml` 里翻译 |

## Components

表里标了 _(I18nText)_ 的属性是显示给玩家的文字，会按语言翻译。

### Layout

| 组件        | 用途               | 主要属性                                     |
| ----------- | ------------------ | -------------------------------------------- |
| `Stack`     | 把子元素竖着排。   | `gap`（字符串，直接作为样式）                |
| `Row`       | 把子元素横着排。   | `gap`、`align`（`center` / `start` / `end`） |
| `Grid`      | CSS 网格。         | `cols`（数字）                               |
| `Separator` | 一条横向的分隔线。 | —                                            |

### Display

| 组件              | 用途                                                                                                                                                                                                                                                                                                                                                           | 主要属性                                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Text`            | 一段文字，可调样式。                                                                                                                                                                                                                                                                                                                                           | `content` _(I18nText)_、`variant`（`muted`）、`weight`（`bold`）、`size`（`xs` / `sm` / `lg`）、`align`（`center`）                                                                                                                                               |
| `Badge`           | 带颜色的小标签。                                                                                                                                                                                                                                                                                                                                               | `label` _(I18nText)_、`color`（`red` / `amber` / `blue` / `green` / `purple` / `cyan`）                                                                                                                                                                           |
| `Icon`            | 按名字显示一个 Lucide 图标。                                                                                                                                                                                                                                                                                                                                   | `name`（kebab-case，例如 `book-open`）、`size`（`xs` / `sm` / `md` / `lg`）                                                                                                                                                                                       |
| `TagList`         | 一排字符串标签。                                                                                                                                                                                                                                                                                                                                               | `tags`（string[]）                                                                                                                                                                                                                                                |
| `Prose`           | 叙事段落。支持 `**bold**`，按两个换行分段。                                                                                                                                                                                                                                                                                                                    | `content`（string）                                                                                                                                                                                                                                               |
| `Source`          | 小号的出处标签。                                                                                                                                                                                                                                                                                                                                               | `label`（string）                                                                                                                                                                                                                                                 |
| `Image`           | 显示一张图。图由 MediaRef 给出，经媒体库解析。没有绑定 ref 时显示占位块。`zoom: true` 时点击可放大（共用的 `MediaPreviewDialog`）；`framed: true` 时放进一个圆角带边框的卡片（悬停高亮），和生图画廊的缩略图一致。                                                                                                                                             | `ref` _(MediaRef，推荐)_、`src` _(早期 spec 用的写法，同样接受 MediaRef)_、`alt`（string）、`aspectRatio`（CSS 比例，默认 `"1/1"`）、`rounded`（`none` / `sm` / `md` / `lg`）、`fit`（`cover` / `contain`）、`zoom`（布尔，点击放大）、`framed`（布尔，卡片外框） |
| `Media`           | 显示图片、音频、视频或文件。资源由 MediaRef 给出，经媒体库解析。                                                                                                                                                                                                                                                                                               | `ref` _(MediaRef，推荐)_、`src` _(早期 spec 用的写法，同样接受 MediaRef)_、`as`（`auto` / `image` / `audio` / `video`）、`alt`、`aspectRatio`、`rounded`、`fit`                                                                                                   |
| `AudioPlayer`     | 跟随主题、自己绘制的音频播放器。它不用浏览器原生的 `<audio controls>` 外观，而是一行扁平的播放条，颜色和圆角取自 `--color-primary` / `--color-muted` / `--color-border` / `--radius-card`。有播放 / 暂停、可拖动的进度条（鼠标和键盘）、`M:SS / M:SS` 时间、倍速选择（0.75× / 1× / 1.25× / 1.5× / 2×）和下载按钮。ref 缺失或解析失败时显示“音频不可用”占位块。 | `ref` _(MediaRef)_、`src` _(同样接受 MediaRef)_、`alt`（string，也是默认下载文件名的主体）、`downloadName`（覆盖文件名）、`className`                                                                                                                             |
| `MediaGallery`    | 声明式的媒体列表：预览、下载，可选的重新生成。                                                                                                                                                                                                                                                                                                                 | `items`、`idField`、`refField`，可选的 `titleField`、`statusField`、`durationField`、`errorField`、`fields`、`rerunAction`                                                                                                                                        |
| `JobList`         | 声明式的任务列表：可展开的详情、复制、状态 / 错误，可选的重新运行。                                                                                                                                                                                                                                                                                            | `items`，可选的 `idField`、`statusField`、`messageField`、`errorField`、`durationField`、`fields`、`rerunAction`                                                                                                                                                  |
| `PortraitGallery` | 来自 `character.visual@1` 的角色图像，可预览，可选上传。                                                                                                                                                                                                                                                                                                       | 可选的 `replaceAction`                                                                                                                                                                                                                                            |
| `CandidateList`   | 把一段文字的几个版本显示成选项：选一个就运行 `acceptAction`；把它的文字存成草稿或直接发送，是选项下方的次要动作。可选一个“重新生成”动作。                                                                                                                                                                                                                      | `candidates`，可选的 `idField`、`contentField`、`acceptedId`、`turnId`、`hiddenWhen`、`detailFields`、`acceptAction`、`regenerateAction`，以及各个标签                                                                                                            |

**`PortraitGallery` 上传时的顺序。** 它先恢复会话的工作区，再上传替换用的媒体，然后经共用的插件授权流程调用声明的 runtime。授权重试时复用已经上传的媒体引用。runtime 的失败始终显示给玩家，包括 HTTP 成功、但结果里报告失败的情况。

**能用的图标。** `Icon.name` 和插件面板的图标只能用一份固定的名单。这样插件不能把整个 Lucide 图标库拉进客户端的包。目前的名字是：

`anchor`、`backpack`、`book-marked`、`book-open`、`book-user`、`brain`、`calendar-days`、`check-circle-2`、`compass`、`dices`、`gem`、`handshake`、`headphones`、`heart`、`id-card`、`image`、`loader`、`map`、`map-pin`、`megaphone`、`mic`、`network`、`scroll-text`、`search`、`shield`、`skull`、`sliders-horizontal`、`sparkles`、`swords`、`turtle`、`user`、`user-search`、`users`、`users-round`、`wand`、`waves`、`x-circle`。

`BookOpen` 这样的 PascalCase 写法会被规范化成同一个名字。不认识的名字不显示图标（面板页签用 `HelpCircle` 兜底）。

### Data

| 组件                  | 用途                                                                                                                                    | 主要属性                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Card`                | 带边框的容器。                                                                                                                          | `variant`（`glow` / `subtle`）                                                                                                                                                                             |
| `CardList`            | 把 `Card` 子元素竖着排。                                                                                                                | —                                                                                                                                                                                                          |
| `EntryCard`           | 通用词条卡片，分类标签和稀有度样式由提供者声明。                                                                                        | `title` _(I18nText)_、`category`（string）、`content` _(I18nText)_、`tags`（string[]）、`rarity`（string）、`categoryOptions`、`rarityOptions`、`icon`、`color`、`collapsible`、`defaultExpanded`、`isNew` |
| `StatBar`             | 标签加一条 `value/max` 的数值条。                                                                                                       | `label` _(I18nText)_、`value`（数字）、`max`（数字）                                                                                                                                                       |
| `Progress`            | 百分比样式的进度条。                                                                                                                    | `label` _(I18nText)_、`value`（数字）、`max`（数字）                                                                                                                                                       |
| `Accordion`           | `Section` 子元素的竖向外层容器。                                                                                                        | —                                                                                                                                                                                                          |
| `Section`             | 可以折叠的标题加正文。                                                                                                                  | `title` _(I18nText)_、`icon`、`defaultOpen`（布尔）                                                                                                                                                        |
| `JsonView`            | 按形状显示任意 JSON 值：基础类型直接显示，数组显示成标签列表，对象显示成 key: value。                                                   | `value`（任意）                                                                                                                                                                                            |
| `EntryList`           | 声明式的条目列表：标题、说明、徽标和带标签的字段。                                                                                      | `items`、`titleField`，可选的 `idField`、`descriptionFields`、`badgeFields`、`fields`、`dateField`、`footerField`                                                                                          |
| `SceneCastList`       | 来自 `stage.cast@1` 的在场角色：名字、类型和说明。                                                                                      | 无                                                                                                                                                                                                         |
| `CharacterFieldsView` | 按 schema 显示一个角色的 `fields` 对象。它读会话 World Model 的 `characterSchema`，按类别分组（bio/stats/abilities/equipment/social）。 | `value`（角色的 `fields` 对象）                                                                                                                                                                            |
| `CharacterAvatar`     | 按角色 ID 从 `character.visual@1` 取的头像，点击放大。                                                                                  | `characterId`，可选的 `size`（默认 `28`）                                                                                                                                                                  |

`EntryCard` 的 `category` 和 `rarity` 是提供者定义的数据键，没有内置枚举或默认稀有度。`categoryOptions` 是 `{ value, label, icon?, color? }` 数组：用 `value` 匹配类别，`label` 按 UI 语言解析，图标和颜色可由条目的 `icon` / `color` 覆盖。`rarityOptions` 是 `{ value, tone?, color? }` 数组：匹配稀有度后，`tone` 控制边线（`muted` / `primary` / `info` / `success` / `warning` / `danger`），`color` 控制类别徽标（`red` / `amber` / `blue` / `green` / `purple` / `cyan`）。缺少匹配项时显示原类别键、通用书本图标和中性色。使用 `FilterContainer` 时，把这两组数组放在行模板的 `EntryCard.props` 中；数据键用 `$item` 绑定。spec 的 `label` 只写英文，译文放在插件的 `locales/<locale>.yaml` 的 `messages` 中，不需要把双语名称写进模型数据。

### Interactive

| 组件              | 用途                                                                                                                                                | 主要属性                                                                                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`          | 可以点击的按钮。插件声明的交互会在按钮上显示“已选中”的反馈。                                                                                        | `label` _(I18nText)_、`variant`（`default` / `primary` / `danger` / `ghost`）、`size`（`compact` / `md`）；`on.click.action` = `draftMessage` / `selectChoice` / …                                                                                                                 |
| `ChoiceList`      | 一组让玩家挑选的选项。它给里面的 `Choice` 编号；序号显不显示、显示成什么（数字、汉字数字、键帽），由当前主题决定。                                  | 子元素：`Choice`                                                                                                                                                                                                                                                                   |
| `Choice`          | 一个选项，渲染成一个按钮。它的草稿排队等待发送时显示“已选”，它的 runtime 调用进行中时显示“忙”。在当前回合里，数字键 1–9 点击第 n 个可见的选项。     | `title` _(I18nText，必填)_、`description` _(I18nText)_、`tag` _(I18nText)_、`tone`（给 tag 上色：`primary` / `info` / `success` / `warning` / `danger`，或一个 `Badge` 的颜色名）；`on.click.action` = `draftMessage` / `selectChoice` / `invokeRuntime` / …                       |
| `Input`           | 单行文本输入。                                                                                                                                      | `label` _(I18nText)_、`placeholder` _(I18nText)_、`value`（用 `$bindState` 绑定）                                                                                                                                                                                                  |
| `Textarea`        | 多行文本输入（等宽字体，可调大小）。                                                                                                                | `label` _(I18nText)_、`placeholder` _(I18nText)_、`rows`（数字，默认 `8`）、`value`（用 `$bindState` 绑定）                                                                                                                                                                        |
| `SearchInput`     | 带搜索图标的输入框。                                                                                                                                | `placeholder` _(I18nText)_、`value`                                                                                                                                                                                                                                                |
| `Select`          | 下拉选择。                                                                                                                                          | `label` _(I18nText)_、`options`（`[{ value, label }]`）、`value`                                                                                                                                                                                                                   |
| `Switch`          | 布尔开关。                                                                                                                                          | `label` _(I18nText)_、`checked`（用 `$bindState` 绑定）                                                                                                                                                                                                                            |
| `FilterBar`       | 横向的切换组（多选一）。                                                                                                                            | `options`（`[{ value, label, icon? }]`）、`value`                                                                                                                                                                                                                                  |
| `Tabs`            | 页签条。用 `$bindState` 绑定当前值；可选的 `counts` 在标签后面加上 `(N)`。                                                                          | `tabs`（`[{ value, label, icon?, color? }]`）、`value`、`counts`（`Record<value, number>`）                                                                                                                                                                                        |
| `FilterContainer` | 保存搜索词和当前页签，为过滤后的每行渲染一个子树。 | `items`（数组绑定）、`itemTemplate`（节点）、`searchPlaceholder`、`searchFields`（path[]）、`filterField`、`filterTabs`、`itemKeyField`、`emptyMessage`、`showCounts`、`footer`（字符串或 `{ component, props }`） |

可访问性：

- `Input`、`Textarea` 和 `Select` 把本地化的 `label` 关联到一个稳定、唯一的控件 ID 上，重复出现的控件也一样。点击标签会聚焦对应的控件。
- `Switch` 用原生的、不会提交表单的按钮，带 `role="switch"`，标签就是它的可访问名称。Tab 聚焦它，Space 或 Enter 切换它绑定的 `checked` 值。
- 请给控件写一个说明性的标签。placeholder 不能代替标签。
- 这些控件遵守所在面板的交互锁，spec 里没有新增 `disabled` 属性。

### FilterContainer 行模板

把每行的界面放进 `props.itemTemplate`，可以组合布局、按钮、徽标和其他目录组件：

```json
{
  "component": "FilterContainer",
  "props": {
    "items": {
      "$state": "/entries"
    },
    "searchFields": [
      "value/title"
    ],
    "searchPlaceholder": "Search…",
    "filterField": "value/status",
    "filterTabs": [
      {
        "value": "all",
        "label": "All"
      },
      {
        "value": "active",
        "label": "Active"
      }
    ],
    "itemKeyField": "key",
    "itemTemplate": {
      "component": "Row",
      "children": [
        {
          "component": "Text",
          "props": {
            "content": {
              "$item": "value/title"
            }
          }
        },
        {
          "component": "Badge",
          "props": {
            "label": {
              "$map": {
                "$item": "value/status"
              },
              "labels": {
                "active": "Active",
                "done": "Done"
              },
              "fallback": "Unknown"
            }
          }
        },
        {
          "component": "Button",
          "props": {
            "label": "Open"
          },
          "on": {
            "click": {
              "action": "invokeRuntime",
              "params": {
                "runtimeId": "notes/open",
                "payload": {
                  "key": {
                    "$item": "key"
                  }
                }
              }
            }
          }
        }
      ]
    }
  }
}
```

`items` 绑定状态中的数组：用 `{ "$state": "/entries" }`，在外层重复项中用 `{ "$item": "rows" }`。对应的 `$bindState` / `$bindItem` 写法也可用。缺失或非数组数据按空列表显示。

模板里的 `$item` 读取当前行，`$index` 是原数组里从零开始的索引；搜索和页签过滤不会重排索引。`$bindItem` 和嵌套 `repeat` 仍指向原行。`itemKeyField` 为每行提供稳定身份，建议写唯一键（通常是 `key`）。不写时用原索引。

行模板和普通节点使用相同的状态、动作处理器和锁定规则。不要在 `FilterContainer` 本身写 `children` 或 `repeat`。旧的 `itemComponent`、`itemPropMap`、`itemLiteralProps` 已删除：把组件与固定属性放进模板，把字段路径改成 `$item` 表达式。

### 值标签映射

`{ "$map": <值表达式>, "labels": { "<值>": "<文字>" }, "fallback": <可选表达式> }` 把数据键转换成显示文字。字符串、数字和布尔值按字符串键精确匹配；只查 `labels` 自己声明的键。找不到时计算 `fallback`，省略时保留原值。空标签仍是有效的匹配。

`labels` 的值和字符串 `fallback` 可在插件的 `locales/<locale>.yaml` 中翻译。作用域前缀分别用 `label|` 和 `fallback|`；没有译文时显示英文。值表达式、映射键和动作参数不翻译。这样模型数据只保存 `active` 等键，界面按 UI 语言显示标签。

### Form

| 组件           | 用途                       | 主要属性                                                                                                                                                                                                                                                      |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Form`         | 带边框的表单容器。         | —                                                                                                                                                                                                                                                             |
| `FormHeader`   | `Form` 的标题栏。          | 见 `apps/web/src/lib/catalog/session-renderers.tsx`（属性直接传给标题栏的布局）                                                                                                                                                                               |
| `FormField`    | 一个带标签、有类型的字段。 | `fieldType`（`text` / `textarea` / `number` / `select` / `checkbox`）、`min`、`max`、`step`（数字字段）、`label` _(I18nText)_、`placeholder` _(I18nText)_、`required`（布尔）、`options`（`[{ value, label }]`）、`value`（用 `$bindState` 绑定）、`disabled` |
| `SubmitButton` | 主提交按钮，带禁用状态。   | `label` _(I18nText)_、`disabled`（布尔）；用 `on.click` 发出 `click`                                                                                                                                                                                          |

- 数字字段有内容时绑定的是数字；复选框绑定的是布尔值。
- 已提交的表单只显示保存的提交值；空值或缺失字段显示为空，不读取当前表单的草稿。未保存提交值的开发会话无法还原当时的答案，需要重建会话并重新提交才能保留这些答案。
- 浏览器的输入限制只是改善交互，不能代替服务端校验。
- 用 `create-form` 创建的表单在提交时保留它声明的字段类型和限制。插件的校验器可以在写入提交之前检查跨字段的规则。

见[表单工具](./tools.md#create-form)和[插件测试](../plugins/testing.md)。

### Message

| 组件            | 用途                                             | 主要属性                                                                                          |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `PlayerMessage` | 靠右的玩家聊天气泡（Paper 主题下有另一种样式）。 | `content`（string）                                                                               |
| `Alert`         | 信息 / 成功 / 警告 / 错误通知。                  | `level`（`info` / `success` / `warning` / `error`）、`title` _(I18nText)_、`message` _(I18nText)_ |

### Visualization

| 组件              | 用途                                                                                                                                                                        | 主要属性                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GraphCanvas`     | 力导向关系图，用 `react-force-graph-2d`（按需加载，gzip 后约 60 KB）。它画面板给它的节点和边。                                                                              | `nodes`、`edges`、`node`、`edge`、`height?`、`emptyText?` |
| `WorldDimensions` | 按 schema 显示会话维度的值和版本。宿主校验过的 runtime 元数据可用时，还提供编辑和待结算恢复。它读公开的会话快照，不读作者写的初值，也不读插件 namespace；不需要写任何绑定。 | —                                                         |

**`WorldDimensions`**

- 它接受作者定义的任意 ID，按各自的 schema 显示标量、嵌套值、数组和命名记录集合。
- 公开的条目里没有初值和维护规则。
- 写入通过宿主提供的手动 runtime，并带上 `expectedVersion`。冲突后的刷新，以及明确的重试 / 人工处理 / 跳过，见[动态维度面板](./ui-panels.md#动态维度总览与修正)。

**`GraphCanvas` 的数据映射**

- `nodes` 和 `edges` 可以是数组，也可以是“键 → 记录”的对象。
- `node` 必填映射：`idField`、`labelField`、`colors`（按类型）和 `defaultColor`。`typeField`、`summaryField`、`labelsField` 可省略。
- `edge` 必填映射：`idField`、`sourceField`、`targetField`。`relationField`、`strengthField`、`factField`、`inactiveField`、`defaultColor` 和 `colors`（`positive`、`negative`、`neutral`）可省略。
- 字段路径相对于每条记录。缺少端点的边不显示。
- 没有强度字段或记录缺少强度值时，边使用 `defaultColor`，其次用 `colors.neutral`，最后用灰色 `#94a3b8`。模型线宽为 1，画布最小线宽为 2.5，布局距离为 110。
- 有限数值强度保留原有行为：模型线宽为 `1 + abs(strength) * 2`，布局距离为 `110 + abs(strength) * 30`。配置 `colors` 后，强度 ≥ 0.33 用 positive，≤ -0.33 用 negative，其余用 neutral；未配置则用默认颜色。非数值、NaN 和无穷强度会丢弃该边。
- 配置的 inactive 字段不是 `undefined` 就隐藏该边，`0`、`false` 和 `null` 也算。
- 可用 `emptyText`（I18nText）覆盖默认空状态“暂无图数据。”。
- 面板把自己的 namespace 绑定到这些属性上。组件自己不选择插件或 namespace。

**`GraphCanvas` 的更新方式**

- 数据只有元信息变化时，它刷新节点摘要和关系文字，模拟保留原有节点的身份、位置和固定状态。
- 只有拓扑变了才发布一份新的模拟数据。已有边 ID 的任意一个端点变了，也算拓扑变化。
- 选中高亮：每次数据或选择变化时，把直接相邻的节点算一次；绘制节点时用常数时间的成员检查。

### Multimodal

| 组件               | 用途                                                                                                                                       | 主要属性                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `AssetRender`      | 显示一份 `AssetGenerateView` 提案。它按 `view.modality` 交给对应的渲染器（图片 / 音频 / 通用链接）。                                       | `view`（`AssetGenerateView`）、`sessionId?`（覆盖“当前会话”的查找） |
| `AssetTurnSidebar` | 把一个回合里记录的每个生成资源都显示出来（来自 `state.assetsByTurn`，由 `asset.generated` SSE 处理器填入）。回合里没有资源时什么都不显示。 | `turnId`、`sessionId?`                                              |

## 组件目录的边界

json-render 提供布局、文字、表单、媒体、数值条、关系图和可组合的重复行。目录有意保持有限：通用表格、统计图、自定义动画或计时器，以及名单外的图标，需要在 `webview` 面板里自行实现，见[自己画界面](../plugins/ui.md#8-自己画界面)。`webview` 仍受同一套沙箱和动作权限限制。

已有的 `WorldDimensions` 表格、宿主 Markdown 表格、组件加载动画和舞台过渡仍可使用；它们不是可自由配置的通用表格或动画接口。图表图片、动画图片和视频也可以直接用媒体组件显示。

## Summary

目前一共 50 个组件。权威的清单是 `apps/web/src/lib/catalog.tsx` 导出的 `covelRegistry`；渲染器的实现在 `apps/web/src/lib/catalog/` 下。

新增一个组件时：

1. 把它的准确名字加进 `packages/shared/src/types/plugin-ui.ts` 的 `PLUGIN_UI_COMPONENT_NAMES`，再在 `covelRegistry` 里注册它的渲染器。注册表有类型约束：少一个或多一个映射，TypeScript 检查都会失败。
2. 在这一页对应的小节里加一行。
3. 它接受玩家可见的字符串时，让这些字符串经过 `resolveI18n` / `useI18nResolver()`，这样切换语言时子树会重新渲染。

## Structured list props and actions

这一节讲列表类组件（`EntryList`、`MediaGallery`、`JobList`、`CandidateList` 等）怎样读数据，以及它们的动作怎样写。运行时的 schema 在 `packages/shared/src/schemas/catalog.ts`。

**列表数据。**

- 列表接受一个记录数组。除 `CandidateList` 之外，也接受“键 → 记录”的对象；这时每条记录会多一个 `key` 字段。
- 字段选择器是相对于每条记录、用点分隔的路径，可以包含数组下标。
- `fields` 的每一项是 `{ path, label? }`，`label` 支持 I18nText。
- 插件在自己的 UI spec 里把自己存储的数据形状映射过来。组件不读插件存储。

**`CandidateList`。**

- `candidates` 是数组。默认的选择器是 `id` 和 `content`。
- `hiddenWhen: { field, equals }` 隐藏符合条件的记录，但它们仍留在动作能读到的范围里。
- `acceptedId` 标出当前选中的那一条。
- “草稿 / 发送”用的是会话动作。可选的 accept / regenerate 动作调用你提供的 RPC。

**动作的写法。** 一个 catalog 动作是 `{ pluginId, runtimeId, payload, label? }`。

- `pluginId` 必须是这份 spec 所属插件的 ID，直接写死。
- `payload` 里的值按字面使用。唯一的例外是值恰好为 `{ "from": "path" }`：这种选择器从 `item`（当前行）、`props`（组件属性）或 `upload`（替换立绘时上传得到的 MediaRef）里取值。

```json
{
  "pluginId": "my-plugin",
  "runtimeId": "my-plugin/save",
  "payload": {
    "id": { "from": "item.id" },
    "ref": { "from": "upload" }
  }
}
```

**动作怎样执行。**

- RPC 动作走共用的工作区恢复和授权流程。
- 上传只在工作区恢复之后才准备，授权重试时复用。
- 拥有这个 runtime 的插件负责校验 payload 并实现业务规则，例如替换默认立绘、同时保留其他变体。
- 这是当前唯一的契约。插件专用的组件名和跨插件的头像绑定已经不存在，开发中的 UI spec 需要按这里的写法更新。

`MediaGallery` 和 `JobList` 可用 `emptyText`（I18nText）覆盖“暂无媒体。”和“暂无任务。”。图库按 MIME 显示图片、音频、视频或下载链接，播放控件不放在预览按钮内。图库与预览窗口下载时按 MIME 选择后缀，未知格式使用 `.bin`，不转换文件内容。

**`JobList.relatedMedia`。** 可选。它把你提供的媒体记录关联到任务行上：

```ts
{ items, itemField, matchField, refField?, idField?, titleField? }
```

宿主拿任务的 `itemField` 值和每条媒体记录的 `matchField` 比较，空值不算匹配。这样任务行可以显示关联的预览，而组件不需要知道 prompt 字段，也不需要读第二个插件 namespace。

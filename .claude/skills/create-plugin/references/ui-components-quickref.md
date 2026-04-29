# UI Components 速查（json-render spec 作者用）

写 `ui/<spec>.json` 时的组件清单 + props + 数据绑定语法。本文是 SDK 级合约。

> **承诺**：所有 framework 注册的组件、所有支持的 prop、所有 binding 语法都已穷举。生成的 spec 不应该依赖任何此处未列出的组件名。

## Spec 文件结构

```jsonc
{
  "id": "<unique-id>",                   // 必填：tab/block 的 stable id
  "group": "<group-key>",                // 可选：右侧多个 spec 共享 group → 同一个 Tab 组
  "groupLabel": { "zh": "...", "en": "..." }, // group 的显示名
  "groupOrder": 470,                     // group 的排序（越小越靠前）
  "label": { "zh": "...", "en": "..." }, // Tab 标题（i18n）
  "icon": "headphones",                  // Lucide 图标名（kebab-case）
  "alwaysRender": true,                  // 即使 dataSource 为空也渲染（默认 false）

  "dataSource": {                        // 可选；声明就让框架自动加载本插件的 plugin-data
    "namespace": "tracks"                // 数据放在 /entries 状态路径下
  },

  "emptyState": {
    "message": { "zh": "...", "en": "..." }
  },

  "view": {                              // 必填：组件树根
    "component": "Stack",
    "props": { "gap": "sm" },
    "children": [ ... ],
    "on": { ... }                        // 事件 binding
  }
}
```

`dataSource.namespace` 让 `PluginPanel` 自动从 `plugin_data` 读 `(sessionId, pluginId, namespace)` 全部行，摊平成 `state["/entries"] = [{key, value}, ...]`。spec 内用 `repeat: { statePath: "/entries", key: "key" }` 迭代。

## 数据绑定语法

| 写法 | 含义 |
|---|---|
| `{ "$state": "/path" }` | 读 state 树某路径（root 是 `/`） |
| `{ "$bindState": "/path" }` | 双向绑定（input/select/switch 用） |
| `{ "$item": "field" }` | 当前 repeat 迭代项的字段。支持 `field/sub/sub2` 链式 |
| `{ "$bindItem": "field" }` | 双向绑定到当前 item |
| `{ "$index": true }` | 当前迭代下标 |
| `repeat: { "statePath": "/entries", "key": "id" }` | 把 statePath 指向的数组迭代渲染 children |

I18nText 字段（`label` / `content` / `placeholder` / `title` / `message`）接受：
- 字符串字面量（直接显示）
- `{ "zh": "...", "en": "..." }` 对象（按 locale 解析）
- `{ "$item": "..." }` / `{ "$state": "..." }` 绑定

> CJK 字符**禁止**直接写在 spec 里——必须用 `{ "zh": "..." }` 形式，否则前端 `pnpm check:i18n` 会拦截。生成 spec 时遇到中文字符默认就要包成 I18nText。

## `on.click.action` —— 框架内置 5 个 action

按钮 / submit / 选项的 `on.click` 字段：

```jsonc
"on": {
  "click": {
    "action": "<action-name>",
    "params": { ... }
  }
}
```

| `action` | `params` | 行为 |
|---|---|---|
| `invokeRuntime` | `{ runtimeId: string, payload?: object }` | POST `/api/sessions/:id/plugin-rpc` `{ pluginId, runtimeId, payload }` 触发本插件指定 runtime。**最常用**——任何"按钮触发后台任务"都用这个 |
| `invokePluginAction` | `{ action: string, payload?: object }` | 触发本插件 PLUGIN.md `rpc:` 里声明的 action handler |
| `draftMessage` | `{ text: string, selectionGroup?: string }` | 把 text 暂存为 composer 草稿（玩家可以再编辑后发送） |
| `selectChoice` | 选项相关参数 | 在多选场景里选中一项 |
| `submitForm` | （从所属 Form 上下文自动取） | 提交所属 `Form` 块 |

`params` 里可以用 `{ "$state": "..." }` / `{ "$item": "..." }` 把 state / item 字段动态喂进去。

> `invokeRuntime` 不需要插件再写 React handler——框架默认 handler 已注册，处理 toast、approval-flow（社区插件首次会弹确认框）、background job 反馈等。

## 组件清单

### Layout

| 组件 | 用途 | 关键 props |
|---|---|---|
| `Stack` | 垂直堆叠 | `gap`: `xs`/`sm`/`md`/`lg` |
| `Row` | 水平排列 | `gap`, `align`: `start`/`center`/`end` |
| `Grid` | CSS grid | `cols`: number |
| `Separator` | 分隔线 | — |

### Display

| 组件 | 用途 | 关键 props |
|---|---|---|
| `Text` | 文本 | `content` (I18nText), `variant`: `muted`, `weight`: `bold`, `size`: `xs`/`sm`/`lg`, `align`: `center` |
| `Badge` | 小色块 | `label` (I18nText), `color`: `red`/`amber`/`blue`/`green`/`purple`/`cyan` |
| `Icon` | Lucide 图标 | `name` (kebab-case), `size`: `xs`/`sm`/`md`/`lg` |
| `TagList` | 字符串 tag 列表 | `tags`: string[] |
| `Prose` | 段落正文（支持 `**bold**`，按双换行分段） | `content`: string |
| `Source` | 出处小标签 | `label`: string |
| `Image` | 图片，从 MediaRef 解析 | `ref`: MediaRef, `alt`, `aspectRatio` (default `1/1`), `rounded`: `none`/`sm`/`md`/`lg`, `fit`: `cover`/`contain` |
| `Media` | **通用多媒体**——按 mime 自动渲染图/音/视频/下载链接 | `ref`: MediaRef, `as`: `auto`/`image`/`audio`/`video`, `alt`, `aspectRatio`, `rounded`, `fit` |
| `ImageGallery` | 框架自带画廊（专门给图像生成插件用） | `pluginId`: string |
| `ImageJobs` | 框架自带 jobs 视图（async 任务进度） | `pluginId`: string |

### Data

| 组件 | 用途 | 关键 props |
|---|---|---|
| `Card` | 卡片容器 | `variant`: `glow`/`subtle` |
| `CardList` | 卡片列表（垂直） | — |
| `EntryCard` | 图鉴条目卡（带 rarity / category icon） | `title` (I18nText), `category`, `content` (I18nText), `tags`, `rarity`: `legendary`/`rare`/`uncommon`/`common`, `icon`, `color`, `collapsible`, `defaultExpanded`, `isNew` |
| `StatBar` | label + 数值条 | `label` (I18nText), `value`, `max` |
| `Progress` | 百分比进度条 | `label` (I18nText), `value`, `max` |
| `Accordion` | 折叠容器（包 `Section`） | — |
| `Section` | 可折叠 section | `title` (I18nText), `icon`, `defaultOpen`: boolean |
| `JsonView` | 通用 JSON 渲染（自动选 inline/list/key-value） | `value`: any |
| `CharacterFieldsView` | 框架自带——角色字段视图 | — |

### Interactive

| 组件 | 用途 | 关键 props |
|---|---|---|
| `Button` | 按钮 | `label` (I18nText), `variant`: `default`/`primary`/`danger`/`ghost`, `size`: `compact`/`md`; **必须**配 `on.click.action` |
| `Input` | 文本输入 | `label` (I18nText), `placeholder` (I18nText), `value` (`$bindState`) |
| `SearchInput` | 带 🔍 的输入 | `placeholder`, `value` |
| `Select` | 下拉 | `label` (I18nText), `options`: `[{ value, label }]`, `value` |
| `Switch` | 开关 | `label` (I18nText), `checked` (`$bindState`) |
| `FilterBar` | 横向 toggle 组（pick-one） | `options`: `[{ value, label, icon? }]`, `value` |
| `Tabs` | Tab 条 | `tabs`: `[{ value, label, icon?, color? }]`, `value` (`$bindState`), `counts`: `{ [value]: number }` 可选 |
| `FilterContainer` | 自带 search + tab 状态的复合容器 | 见下方"复合组件"小节 |

### Form

| 组件 | 用途 | 关键 props |
|---|---|---|
| `Form` | 表单容器（带边框） | — |
| `FormHeader` | 标题区 | — |
| `FormField` | 单字段 | `fieldType`: `text`/`select`, `label`, `placeholder`, `required`, `options`, `value` (`$bindState`), `disabled` |
| `SubmitButton` | 提交按钮 | `label`, `disabled`; `on.click.action: "submitForm"` |

### Message（chat 区）

| 组件 | 用途 | 关键 props |
|---|---|---|
| `PlayerMessage` | 玩家发的右侧气泡 | `content`: string |
| `Alert` | 通知 | `level`: `info`/`success`/`warning`/`error`, `title` (I18nText), `message` (I18nText) |

### Visualization

| 组件 | 用途 | 关键 props |
|---|---|---|
| `GraphCanvas` | 力引导图（lazy-load 60KB）。读 `pluginData[pluginId][nodesNamespace]` + `[edgesNamespace]` | `pluginId`, `nodesNamespace`, `edgesNamespace`, `height?` |
| `WorldDimensions` | 当前世界结构化维度（geography / factions / power...） | — |

### Multimodal（asset.generate 渲染）

| 组件 | 用途 | 关键 props |
|---|---|---|
| `AssetRender` | 单个 asset 渲染（从 trace 取） | — |
| `AssetTurnSidebar` | 当前 turn 已生成的 assets 侧栏 | — |

## 复合组件：`FilterContainer`

带 search input + filter tabs + 列表渲染的一体化组件。比手写 Tabs+Input+CardList 简单：

```jsonc
{
  "component": "FilterContainer",
  "props": {
    "items": { "$state": "/entries" },
    "searchPlaceholder": { "zh": "搜索...", "en": "Search..." },
    "searchFields": ["value/title", "value/description"],
    "filterField": "value/category",
    "filterTabs": [
      { "value": "all",     "label": { "zh": "全部",  "en": "All" } },
      { "value": "monster", "label": { "zh": "怪物",  "en": "Monsters" }, "icon": "skull" }
    ],
    "itemComponent": "EntryCard",
    "itemPropMap": {
      "title":    "value/title",
      "category": "value/category",
      "content":  "value/description"
    },
    "itemKeyField": "key",
    "showCounts": true,
    "emptyMessage": { "zh": "无匹配", "en": "No matches" }
  }
}
```

## 媒体渲染速查

```jsonc
// 图片
{ "component": "Image",
  "props": { "ref": { "$item": "value/ref" }, "alt": { "$item": "value/prompt" }, "aspectRatio": "1/1" } }

// 音频（auto-detect mime → <audio controls>）
{ "component": "Media",
  "props": { "ref": { "$item": "value/ref" }, "as": "audio", "alt": { "$item": "value/text" } } }

// 视频
{ "component": "Media",
  "props": { "ref": { "$item": "value/ref" }, "as": "video", "aspectRatio": "16/9" } }

// 通用（auto 按 mime 选）
{ "component": "Media", "props": { "ref": { "$item": "value/ref" }, "as": "auto" } }
```

> **⚠️ 已知限制**：`Media`/`Image` 都**没有** `autoPlay` / `controls`(默认就有) / playback-speed prop——浏览器原生 `<audio controls>` 已自带播放/暂停/拖动时间轴，右键可以调速，overflow 菜单可下载。要做"narrator 完成自动播放"目前还需要前端 framework 改进；插件可以把 `autoPlay: true` 写进 plugin-data，等 prop 落地。

## 完整 spec 样例

### 右侧 Tab：自动同步音频列表

```jsonc
{
  "id": "mimo-tts-audio-tab",
  "group": "tts-studio",
  "groupLabel": { "zh": "旁白", "en": "Narration" },
  "groupOrder": 470,
  "label": { "zh": "TTS 音频", "en": "TTS audio" },
  "icon": "headphones",
  "alwaysRender": true,
  "dataSource": { "namespace": "tracks" },
  "emptyState": {
    "message": { "zh": "暂无音频", "en": "No audio yet" }
  },
  "view": {
    "component": "Stack",
    "props": { "gap": "sm" },
    "children": [{
      "component": "CardList",
      "repeat": { "statePath": "/entries", "key": "key" },
      "children": [{
        "component": "Card",
        "children": [
          {
            "component": "Row",
            "props": { "gap": "sm", "align": "center" },
            "children": [
              { "component": "Badge", "props": { "label": { "$item": "value/triggeredBy" }, "color": "blue" } },
              { "component": "Text",  "props": { "content": { "$item": "value/turnId" }, "size": "xs", "variant": "muted" } }
            ]
          },
          {
            "component": "Media",
            "props": { "ref": { "$item": "value/ref" }, "as": "audio", "alt": { "$item": "value/text" } }
          },
          { "component": "Text", "props": { "content": { "$item": "value/text" }, "size": "xs", "variant": "muted" } }
        ]
      }]
    }]
  }
}
```

### 消息内按钮：手动触发后台 runtime

```jsonc
{
  "id": "mimo-tts-speak-button",
  "group": "tts-studio",
  "label": { "zh": "朗读", "en": "Speak" },
  "icon": "mic",
  "alwaysRender": true,
  "view": {
    "component": "Card",
    "props": { "variant": "subtle" },
    "children": [{
      "component": "Row",
      "props": { "gap": "sm", "align": "center" },
      "children": [
        { "component": "Icon", "props": { "name": "volume-2", "size": "sm" } },
        {
          "component": "Button",
          "props": { "label": { "zh": "朗读这一段", "en": "Speak" }, "variant": "primary", "size": "compact" },
          "on": {
            "click": {
              "action": "invokeRuntime",
              "params": { "runtimeId": "mimo-tts/manual-narrate" }
            }
          }
        }
      ]
    }]
  }
}
```

### 表单 + submit

```jsonc
{
  "id": "my-form",
  "label": { "zh": "设置", "en": "Settings" },
  "view": {
    "component": "Form",
    "children": [
      { "component": "FormHeader", "props": { "title": { "zh": "我的设置", "en": "My settings" } } },
      {
        "component": "FormField",
        "props": {
          "fieldType": "select",
          "label": { "zh": "音色", "en": "Voice" },
          "options": [
            { "value": "v1", "label": "Voice 1" },
            { "value": "v2", "label": "Voice 2" }
          ],
          "value": { "$bindState": "/draft/voice" }
        }
      },
      {
        "component": "SubmitButton",
        "props": { "label": { "zh": "保存", "en": "Save" } },
        "on": { "click": { "action": "submitForm" } }
      }
    ]
  }
}
```

## 调试小贴士

- spec 写错框架不会拒载，但渲染会跳过未识别组件——前端浏览器 console 会打印 `[json-render] unknown component: Foo`
- 用 `JsonView` 兜底：渲染 dataSource 取到的数据但 binding 没绑对时 `{ "component": "JsonView", "props": { "value": { "$state": "/entries" } } }` 一眼能看到状态
- I18nText 不渲染中文 → 检查是不是写成裸字符串了，框架要求中文必须包对象
- repeat 不出条目 → 检查 `dataSource.namespace` 拼写、检查 plugin-data 表里实际 namespace 名

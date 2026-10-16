# 给插件加界面

这一页讲怎样让插件在游戏里显示内容：侧栏的一个面板、正文里的一块内容、一组选项、一张表单，以及完全自己画的界面。它写给已经有一个能运行的插件、现在想让玩家看到它的作者。

读完后，你会把[第一个插件](./first-plugin.md)里的“酒馆传闻”面板改成自己的样子，再给它加一块正文内容。绝大部分界面只需要写 JSON，不需要写前端代码。

## 开始之前

- 做完[第一个插件](./first-plugin.md)，手上有 `~/.covel/plugins/tavern-rumors/`。
- 下面的命令都在 Covel 仓库的根目录运行。

界面文件里的文字用英文写，中文写在 `locales/zh.yaml` 的 `messages` 下。这一页的每一步都会带上对应的译文。

## 先选对位置

插件的内容可以出现在几个固定的位置。先按你想做的事选位置，再看对应的小节。

| 想做的事                                     | 用什么                                              | 显示在哪                         | 要写什么             |
| -------------------------------------------- | --------------------------------------------------- | -------------------------------- | -------------------- |
| 可以随时翻看的完整数据（图鉴、背包、关系图） | 侧栏面板 `ui.right`                                 | 右侧面板的一个页签               | 一份 JSON            |
| 跟着某个回合出现的内容（建议、摘要、提示）   | 正文内容块 `ui.message`                             | 正文里，挂在那个回合下面         | 一份 JSON            |
| 给玩家选的选项                               | `ChoiceList` / `Choice` 组件                        | 正文里；舞台视图的决策区         | JSON，或一次工具调用 |
| 必须回答才能继续的表单                       | `create-form` 工具                                  | 正文里，回答之前输入框是锁住的   | 一次工具调用         |
| 一眼就该看到的状态（目标、时间、行囊）       | 状态摘要 `session.summary@1`                        | 面板页签下方，或场景图上的状态条 | 十几行代码           |
| 场景图、立绘、背景音乐                       | 框架预留的画面位置                                  | 舞台视图、场景背景、头像         | 一段提供数据的代码   |
| 现成组件画不出来的界面（地图、棋盘、小游戏） | 自己的 HTML 文件 `webview`                          | 右侧面板；也可以挂到舞台的决策区 | 一个 HTML 文件       |
| 玩家要读的故事                               | 不是界面。由 `io.visibility: story` 的 runtime 输出 | 正文                             | 提示词               |

判断顺序是：现成的组件够用就用组件，不够再写 HTML，都放不下再去提议让框架增加新的位置。

> [!NOTE]
> 这一页把框架提供的现成组件统称为“组件”。它们的名字和参数见[界面组件参考](../reference/ui-components.md)；面板文件的全部字段见[面板参考](../reference/ui-panels.md)。这一页只讲怎么用，不重复那两张表。

## 1. 读懂生成的面板

打开 `runtimes/note/ui/panel.json`。它分成两部分：上面几行说明“这是哪个面板、读哪份数据”，下面的 `view` 说明“画成什么样”。

```json
{
  "id": "tavern-rumors-notes",
  "group": "tavern-rumors",
  "groupLabel": "tavern-rumors",
  "groupOrder": 800,
  "label": "Plugin Notes",
  "shortLabel": "Notes",
  "icon": "notebook-pen",
  "dataSource": { "namespace": "notes" },
  "alwaysRender": true,
  "emptyState": { "message": "No plugin notes yet. ..." },
  "view": { "component": "Stack", "children": ["..."] }
}
```

| 字段                   | 意思                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`                   | 面板的名字，在这个插件里唯一                                                                                  |
| `label`                | 页签上的完整名称                                                                                              |
| `shortLabel`           | 页签很窄时显示的短名称。两个都写，面板在每种界面布局下才都好认                                                |
| `icon`                 | 页签的图标，从框架允许的图标名里选，见[界面组件参考](../reference/ui-components.md#display)                   |
| `group` / `groupLabel` | 想把几个面板合进同一个页签时用。同一个 `group` 的面板共用一个页签，在里面用子页签切换。只有一个面板时可以不写 |
| `groupOrder`           | 页签的排序，数字小的在前，默认 500                                                                            |
| `dataSource.namespace` | 这个面板读插件的哪个数据空间。这里是 `notes`                                                                  |
| `emptyState.message`   | 数据空间里还没有内容时显示的一句话                                                                            |
| `alwaysRender`         | 写 `true` 时，没有数据也照常画出 `view`。面板里有“添加”按钮时需要它，否则空面板上只有那句提示，点不到按钮     |
| `view`                 | 界面本身：一棵由组件组成的树                                                                                  |

面板文件要在 `PLUGIN.md` 里登记，脚手架已经写好了：

```yaml
contributes:
  ui:
    right:
      - ./runtimes/note/ui/panel.json
```

### 数据怎样变成界面

插件的数据空间是一组“键 → 值”的记录。面板拿到它之后，可以用两种方式读：

- 按键读：`{ "$state": "/某个键" }`。
- 按列表读：框架会额外准备一个 `/entries` 数组，每一项是 `{ key, value }`。用 `repeat` 把一个组件对每一项重复一遍，在里面用 `{ "$item": "value/title" }` 读这一项的字段。

脚手架生成的面板下半部分就是这样列出记录的：

```json
{
  "component": "Stack",
  "repeat": { "statePath": "/entries", "key": "key" },
  "children": [
    { "component": "Text", "props": { "content": { "$item": "value/title" } } }
  ]
}
```

runtime 每次写入数据并提交之后，面板自动重画，你不需要写任何刷新的代码。更多读数据的写法见[界面组件参考](../reference/ui-components.md#data-bindings-cheat-sheet)。

## 2. 把面板改成自己的

把 `runtimes/note/ui/panel.json` 整个换成下面的内容。它只做三件事：一个“添加记录”按钮，一列传闻，每条传闻下面一个“追问这条”按钮。

```json
{
  "id": "tavern-rumors-notes",
  "label": "Rumors",
  "shortLabel": "Rumors",
  "icon": "notebook-pen",
  "dataSource": { "namespace": "notes" },
  "alwaysRender": true,
  "emptyState": { "message": "No rumors yet." },
  "view": {
    "component": "Stack",
    "props": { "gap": "sm" },
    "children": [
      {
        "component": "Button",
        "props": { "label": "Add note", "variant": "primary", "size": "md" },
        "on": {
          "click": {
            "action": "invokeRuntime",
            "params": {
              "runtimeId": "tavern-rumors/note",
              "payload": { "title": "Manual note", "text": "Written by hand." }
            }
          }
        }
      },
      {
        "component": "Card",
        "props": { "variant": "subtle" },
        "repeat": { "statePath": "/entries", "key": "key" },
        "children": [
          {
            "component": "Stack",
            "props": { "gap": "xs" },
            "children": [
              {
                "component": "Text",
                "props": {
                  "content": { "$item": "value/title" },
                  "weight": "bold",
                  "size": "sm"
                }
              },
              {
                "component": "Text",
                "props": { "content": { "$item": "value/text" }, "size": "sm" }
              },
              {
                "component": "Button",
                "props": {
                  "label": "Ask about this",
                  "variant": "ghost",
                  "size": "compact"
                },
                "on": {
                  "click": {
                    "action": "draftMessage",
                    "params": { "text": { "$item": "value/title" } }
                  }
                }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

界面上的英文换了，译文也要跟着换。打开 `locales/zh.yaml`，把 `messages` 一节改成：

```yaml
messages:
  Rumors: 传闻
  No rumors yet.: 还没有传闻。
  Add note: 添加记录
  Ask about this: 追问这条
```

然后校验：

```bash
pnpm validate:plugin ~/.covel/plugins/tavern-rumors
```

```text
✓ Static package validation: /Users/you/.covel/plugins/tavern-rumors
  languages: text en, zh; instructions en
```

如果你只改了面板、忘了改译文，校验会失败，并逐条指出哪句译文已经没有对应的英文：

```text
✗ /Users/you/.covel/plugins/tavern-rumors: locale files
  - locales/zh.yaml: messages: "Plugin Notes" is not a text of this plugin's UI or code; the English text changed or was removed, so this translation is ignored
```

在游戏里看效果：`pnpm dev` 正在运行时，保存文件后插件会自动重新加载，刷新页面即可。页签的名字变成“传闻”，点“添加记录”多出一条，点“追问这条”会把那条传闻的标题放进输入框上方的待发送区。

> [!IMPORTANT]
> 校验也检查界面文件的结构：组件名、`view` 和 `webview` 二选一、`repeat.statePath` 的写法、`$item` 的字段名、`specVersion`，以及只能引用本插件的数据。游戏显示面板时用的是同一套规则，所以校验通过的面板不会因为格式被去掉。把 `Card` 误写成 `Kard`，校验会失败，并指出是哪个文件的哪个位置，例如 `./runtimes/note/ui/panel.json: view.children[0].component: unknown component Kard`。校验还检查 `FilterContainer` 的数组绑定、行模板和 `$map` 结构；其他组件的 `props` 和动作名不在这项检查里。面板没出现时，打开浏览器的开发者工具看控制台：开发模式下，框架会把每个被去掉的面板和具体原因打印出来。

需要搜索或类别页签时，用 `FilterContainer` 的 `itemTemplate` 放每条记录的子树；它仍能包含按钮和徽标。数据里的枚举键用 `$map` 显示可翻译的标签。完整例子见[行模板](../reference/ui-components.md#filtercontainer-行模板)和[值标签映射](../reference/ui-components.md#值标签映射)。

## 3. 让按钮做事

组件的 `on.click` 里写一个动作名和它的参数。上一步用了其中两个。全部可用的动作：

| 动作                 | 效果                                                                     | 正文内容块 | 侧栏面板 | 舞台决策区 |
| -------------------- | ------------------------------------------------------------------------ | ---------- | -------- | ---------- |
| `draftMessage`       | 把一句话放进待发送区。玩家可以再补几句，一起发出                         | 可用       | 可用     | 不可用     |
| `sendMessage`        | 正文中直接发出；舞台上填入输入框，由玩家发送                             | 可用       | 不可用   | 可用       |
| `invokeRuntime`      | 运行一个手动触发的 runtime。它写入的多条数据要么全部生效，要么全部不生效 | 可用       | 可用     | 可用       |
| `invokePluginAction` | 调用插件登记的一个即时操作：立刻执行、立刻写入，不开新回合，不调用模型   | 可用       | 可用     | 可用       |
| `invokeCommand`      | 执行清单里声明的玩家命令（`/bag` 这一类）                                | 可用       | 可用     | 可用       |
| `emitEvent`          | 发出一个本插件声明过的事件。订阅它的 runtime 在后台运行                  | 可用       | 可用     | 可用       |

几条规则：

- `invokeRuntime`、`invokePluginAction`、`invokeCommand` 和 `emitEvent` 只能指向自己的插件，写不了别的插件。
- `invokeRuntime` 点名一个 runtime，等它跑完并拿到结果。`emitEvent` 只说“发生了什么”，点击立刻返回，拿不到订阅者的结果。需要马上看到结果时用前者。
- `emitEvent` 的事件名必须写在自己 `PLUGIN.md` 的 `contributes.events` 里。只给界面用的事件可以写 `advertise: false`，不让写故事的模型看到。
- 社区插件第一次发某个事件时，玩家要授权两件事：发这个事件，以及运行订阅它的社区 runtime。
- 订阅事件的 runtime 是后台任务。这一局没有可用的模型密钥时，它不会执行。

想让“去码头”成为玩家的一次行动、由故事来接，就用 `draftMessage` 或 `sendMessage`；想直接改数据，就用 `invokeRuntime` 或 `invokePluginAction`。

玩家点过的选择会被记住：通过 `draftMessage` 进入待发送区的内容，发出之后，原来那块界面下面会多一行“你的选择：……”。你不需要为此写任何东西。

## 4. 在正文里放一块内容

侧栏面板一直都在。正文内容块则跟着回合走：它出现在某个回合的故事下面，之后留在历史里。适合放“这一回合发生了什么”的简短摘要，细节留给侧栏。

下面给“酒馆传闻”加一块：每个回合结束后，在正文里显示目前一共听到多少条传闻。需要三样东西。

**一份界面文件。** 新建 `runtimes/recap/ui/rumor-block.json`：

```json
{
  "id": "tavern-rumors-recap",
  "dataSource": { "namespace": "message" },
  "view": {
    "component": "Row",
    "props": { "gap": "sm", "align": "center" },
    "children": [
      {
        "component": "Text",
        "props": { "content": "Rumors so far", "size": "sm" }
      },
      {
        "component": "Badge",
        "props": { "label": { "$state": "/count" }, "color": "blue" }
      }
    ]
  }
}
```

**在 `PLUGIN.md` 里登记。** 在 `right` 旁边加一个 `message`：

```yaml
contributes:
  ui:
    right:
      - ./runtimes/note/ui/panel.json
    message:
      - ./runtimes/recap/ui/rumor-block.json
```

**一个每回合写数据的 runtime。** 新建 `runtimes/recap/RUNTIME.md`：

```yaml
---
description: Counts the rumors after each turn and shows the total in the story.
schedule:
  stage: post-turn
  after:
    - tavern-rumors/analyst
function: {}
---
```

和 `runtimes/recap/handler.js`：

```js
/** @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler} */
export default async function recapHandler(ctx) {
  const notes = await ctx.pluginData.list("notes");
  return {
    outcome: "success",
    effects: {
      pluginData: [
        {
          namespace: "message",
          key: ctx.turnId,
          value: { __turnId: ctx.turnId, count: notes.length },
        },
      ],
    },
  };
}
```

再补上译文（`locales/zh.yaml`）：

```yaml
runtimes/recap/RUNTIME.md:
  description: 每个回合结束后数一遍传闻，把总数显示在正文里。
messages:
  Rumors so far: 目前听到的传闻
```

校验通过后，正文内容块有三条必须知道的规则：

1. **数据空间必须叫 `message`。** 正文内容块只读这一个空间。
2. **用 `__turnId` 说明它属于哪个回合。** 上面的写法是每回合写一条记录，键是回合的 ID，值里带 `__turnId`。这样每个回合各有一块，历史里可以回看。另一种写法是把 `__turnId` 直接写成 `message` 空间里的一个键，这时整个空间是一块，每回合覆盖，只保留最近的一回合。以 `__` 开头的键不会进入界面。
3. **第一次写入不能只靠这块界面里的按钮。** 数据空间里没有内容时，这块界面根本不会出现，上面的按钮也就点不到。让它第一次出现的写入要来自自动运行的 runtime（就像上面的 `recap`）、别的 runtime，或者世界包预置的数据。

可以离线确认这个 runtime 写对了。在 `tests/runtime-cases.json` 的 `cases` 里加一条：

```json
{
  "name": "recap-writes-message",
  "runtimeId": "tavern-rumors/recap",
  "expect": {
    "runtimeResults": [
      { "runtimeId": "tavern-rumors/recap", "status": "success" }
    ],
    "pluginData": [{ "namespace": "message", "field": "count" }]
  }
}
```

```bash
pnpm test:runtime -- tavern-rumors --pretty
```

输出里三条用例都是 `"status": "passed"`。

> [!NOTE]
> 每个回合里只读的内容块（提示、状态变化这一类）在默认的界面布局下会合并成一行“本回合更新 · N 项”，点开才展开。表单、选项和警告不会被折叠。

## 5. 给玩家选项

给玩家选的东西只有一种正确的写法：`ChoiceList` 里放若干个 `Choice`。

```json
{
  "component": "ChoiceList",
  "children": [
    {
      "component": "Choice",
      "props": {
        "title": { "$state": "/prompt1Text" },
        "tag": { "$state": "/prompt1Label" }
      },
      "visible": { "$state": "/prompt1Text" },
      "on": {
        "click": {
          "action": "draftMessage",
          "params": { "text": { "$state": "/prompt1Text" } }
        }
      }
    }
  ]
}
```

这样写的好处是框架替你做了三件事：

- 玩家按数字键 1 到 9 就能选中屏幕上第几个选项。
- 每套界面风格会用自己的方式画选项（带标签的卡片、编号列表、键帽），你的选项自动跟着变。
- 选过之后的回显和“你的选择”那一行都是现成的。

> [!WARNING]
> 不要用 `Card` 加 `Button` 自己拼选项。那样拼出来的东西换了界面风格不会变样，数字键也不认。

内置的 `guide` 插件是完整的例子：[`plugins/guide/ui/guide-block.json`](../../plugins/guide/ui/guide-block.json)。它在上方放一段场景回顾和“现在要决定什么”，中间是 `ChoiceList`。每条选项的 `title` 写一句可以直接发出去的行动，`tag` 写它的类别。

如果选项是“必须回答才能继续”的选择题，不用自己写界面：让 agent 调用内置的 `create-choices` 工具，框架会把它画成同样的选项。见[工具参考](../reference/tools.md#create-choices)。

## 6. 向玩家要一张表单

需要玩家填几项内容才能继续时（创建角色、多步确认），不写界面文件，而是让 runtime 发出一张表单。agent 在 `agent.tools.builtin` 里列出 `create-form` 之后就可以调用它：

```json
{
  "formId": "rumor-source",
  "title": "Who told you this?",
  "fields": [
    { "type": "text", "name": "speaker", "label": "Speaker", "required": true },
    {
      "type": "select",
      "name": "trust",
      "label": "Do you believe it?",
      "options": [
        { "value": "yes", "label": "Yes" },
        { "value": "no", "label": "No" }
      ]
    }
  ],
  "submitLabel": "Record",
  "narrativeTemplate": "{{speaker}} told me. Do I believe it: {{trust}}."
}
```

字段类型有 `text`、`textarea`、`select`、`checkbox`、`number`。全部参数见[工具参考](../reference/tools.md#create-form)。

需要模型复核填好的叙事时，组合工具可以用 SDK 的 `fillNarrativeTemplate` 返回预览，并让 runtime 在读完结果后再结束。同一交互的修订规则见[工具参考](../reference/tools.md#create-form)。

表单出现后会发生什么：

- 表单显示在正文里。玩家回答之前，输入框是锁住的。
- 玩家提交后，框架把填的内容代入 `narrativeTemplate`，作为玩家的一句话显示在正文里，然后开始下一个回合。你的插件在那个回合里读到这些值。
- 不想让这句话出现在正文里，就在表单上写 `"submitBehavior": { "echoFilledNarrative": false }`。这时下一个回合不带玩家的话，插件从已保存的表单值里读回答。这个字段默认是 `true`。

校验和错误：

| 情况                               | 玩家看到什么                                                                             | 接口返回                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- |
| 没填必填项、数字超出范围、选项不对 | 出错的字段下面出现一句说明，光标落到第一个出错的字段，已经填的内容保留。不弹出错误提示条 | `code: "form_rejected"`，什么都不保存   |
| 你自己的校验函数拒绝了这次提交     | 同上。返回的错误带字段名时显示在那个字段下面，不带时显示在所有字段的上方                 | `code: "form_rejected"`                 |
| 同一张表单提交第二次               | 显示拒绝的原因，并填回第一次的答案                                                       | `code: "interaction_already_submitted"` |

一张表单只能回答一次。玩家换一个浏览器标签页或设备重新打开这一局时，已经回答的表单会显示为已回答，并填着当时的值。

想加自己的校验规则（例如两个字段不能相同），或者想在表单重新出现时解释原因（`notice`），见[工具参考](../reference/tools.md#create-form)里的 `validation` 和 `notice`。

## 7. 一眼就该看到的状态

“当前目标”“现在几点”“身上带着什么”这类内容不该藏在某个页签里。插件可以提供一到三行状态摘要，每行是一句文字、一个量表，或者一个短列表。框架把它放在当前界面风格显示状态的位置：有的风格在面板页签的下方，有的在场景图上的状态条里。插件不需要知道现在是哪一种。

这需要在插件的 `entry` 模块里写十几行代码。写法和完整例子见[面板参考的 Session summary](../reference/ui-panels.md#session-summary)。细节仍然放在你自己的侧栏面板里，摘要只是让玩家瞥一眼。

类似地，下面这些内容由框架来画，插件只提供数据：

| 内容               | 位置名                             | 说明                                                                                           |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 场景图             | `stage.backdrop@1`                 | 舞台视图和带场景背景的文字视图读的是同一份数据                                                 |
| 在场角色、谁在说话 | `stage.cast@1`、`stage.dialogue@1` | 用于舞台视图                                                                                   |
| 舞台上的选项       | `stage.choices@1`                  | 舞台视图的决策区                                                                               |
| 角色的头像和立绘   | `character.visual@1`               | 头像、立绘面板、舞台都读它                                                                     |
| 背景音乐           | `stage.music@1`                    | 插件只说“现在该放哪一首”。播放、淡入淡出、玩家的音量和静音开关都在框架这边，插件不需要任何界面 |

这些位置的数据格式见[面板参考的 Kernel UI slots](../reference/ui-panels.md#kernel-ui-slots)。位置的名单是固定的，插件不能自己增加。

> [!TIP]
> 数值量表和随身物品有时根本不用写插件：世界的角色属性里带范围的数值、字符串数组形式的装备，框架会自己显示在状态条上。

## 8. 自己画界面

地图、棋盘、解谜机关这类东西，现成的组件画不出来。这时面板文件里不写 `view`，改写 `webview`，指向插件自带的一个 HTML 文件：

```json
{
  "id": "tavern-rumors-board",
  "label": "Rumor board",
  "shortLabel": "Board",
  "icon": "map",
  "alwaysRender": true,
  "dataSource": { "namespace": "notes" },
  "webview": { "entry": "./board.html", "height": 240 }
}
```

`view` 和 `webview` 只能写一个。`entry` 是相对这份 JSON 的路径，必须是插件目录里的 `.html` 文件，最大 512 KiB。

HTML 文件在一个隔离的框里运行。框架给它一个 `window.covel` 对象，用来读数据和触发动作：

```html
<!doctype html>
<meta charset="utf-8" />
<style>
  body {
    margin: 0;
    padding: 12px;
    color: var(--covel-foreground, CanvasText);
    font-family: var(--covel-font-sans, system-ui), system-ui, sans-serif;
  }
</style>
<ul id="list"></ul>
<script>
  window.covel.subscribe(({ data = {}, locked = false }) => {
    const list = document.getElementById("list");
    list.replaceChildren();
    for (const [key, note] of Object.entries(data)) {
      const item = document.createElement("li");
      item.textContent = note.title; // textContent, never innerHTML
      item.onclick = () => {
        if (!locked) window.covel.invoke("draftMessage", { text: note.title });
      };
      list.append(item);
    }
  });
</script>
```

| 你能做的                         | 怎么做                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| 读自己的数据，并在数据变化时重画 | `window.covel.subscribe(({ data, locale, locked, context, uiState, theme }) => …)`                  |
| 触发自己的后端逻辑               | `window.covel.invoke("invokeRuntime" \| "invokePluginAction" \| "invokeCommand" \| "emitEvent", …)` |
| 把一句话交给玩家                 | 侧栏里用 `invoke("draftMessage", { text })`，舞台上用 `invoke("sendMessage", { text })`             |
| 记住草稿这类临时的界面状态       | `invoke("setUiState", { value })`。刷新页面或离开这一局后会丢失                                     |
| 跟着玩家选的界面风格变色         | 用 `--covel-*` 这组 CSS 变量，例如 `color: var(--covel-foreground)`。玩家换风格或切换明暗时自动更新 |
| 同时出现在舞台视图的决策区       | 在面板文件里写 `"surfaces": ["panel", "stage"]`                                                     |

写 HTML 时要遵守的限制：

- **所有东西都在一个文件里。** 脚本和样式写成内联的 `<script>` 和 `<style>`，图片用 `data:` 地址。用 React 或 Vue 也可以，但要先打包成一个带内联脚本的 HTML。
- **不能联网。** 不能从网络加载脚本、样式、字体或图片，不能 `fetch`，不能提交表单或跳转。和后端打交道只走 `window.covel.invoke`。
- **读不到游戏页面的东西。** 页面的本地存储、cookie 和接口都读不到，也读不到别的插件的数据。
- **字体要写后备。** 游戏自带的字体文件进不了这个隔离的框。`--covel-font-*` 只在玩家的系统装了那款字体时生效。
- **输入框锁住时不要发动作。** `locked` 为 `true` 时，框架会拒绝你发来的动作。

画面太小时不用另做一份大的：侧栏里每个插件面板的右上角都有“放大面板”按钮，点了之后同一个面板显示在大对话框里，`webview` 在那里大约占屏幕高度的 72%。

完整的协议（`theme` 里有哪些值、`context` 在舞台上带什么、`uiState` 的大小上限）见[插件扩展参考](../reference/plugin-extensions.md#自定义组件与挂载)。隔离是怎么做的见[安全边界](../internals/security.md#plugin-html)。

### 例子：可以点的地图

仓库里有一个可以运行的完整例子：[`tests/third-party/clickable-map`](../../tests/third-party/clickable-map/README.md)。它把前面几节连了起来：

1. 地点和玩家的位置存在插件自己的数据空间里，世界包可以预置。
2. 侧栏面板是一个 `webview`，用 SVG 画地图，`subscribe` 收到数据就重画。
3. 玩家点一个地点，界面发出事件 `map.location-selected`。
4. 插件自己订阅这个事件的 runtime 检查能不能去，然后更新位置。别的插件也可以订阅同一个事件，各自做自己的事。
5. 数据提交后推回界面，地图重画。

解谜也是同一个思路：谜面和进度存在数据空间里，每走一步用 `invokePluginAction`（马上有反馈）或 `invokeRuntime`（要和别的数据一起生效）来检查。答案这类不该让玩家看到的内容，存进名字以 `_hidden.` 开头的数据空间，只在后端比对。

## 让界面跟着风格走

玩家可以在 **设置 → 外观** 里换界面风格。每套风格的配色、字体、圆角不同，有的连结构都不同：页签是图标还是文字、有没有场景背景。你不需要为每套风格各写一份界面，只要遵守下面几条：

- **说意思，不说样子。** 用组件的 `tone`、`variant` 这类参数表达“警告”“成功”“次要”。不要在界面文件里写具体的颜色、字体或圆角。
- **说内容，不说位置。** 面板放在哪、页签长什么样由风格决定。你只需要给好 `label`、`shortLabel` 和 `icon`。
- **不要假设面板有多宽，也不要假设是深色还是浅色。** 玩家可以拖动面板的宽度。内容要能换行、能滚动；图片和图表不要依赖深色的底。
- **自己画的界面用 `--covel-*` 变量上色**，不要写死颜色。

自查的办法：在 **设置 → 外观 → 风格方案** 里依次选“面板”“书卷”“舞台”，每换一次就看一眼自己的面板和正文内容块。

## 现在的限制

做更复杂的界面之前，先知道框架现在给了什么。下面这些是目前的状况，不是永远不许做的事。确实需要时，可以提议让框架增加。

| 方面           | 现在是这样                                               | 所以                                                         |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| 能放的位置     | 正文内容块、侧栏页签、舞台决策区。状态条只接受状态摘要   | 想把面板盖在场景图上，目前做不到                             |
| 面板大小       | 侧栏的宽度由玩家拖动决定。任何面板都能放大到大对话框     | 没有一块常驻的中央大区域                                     |
| 回合信息       | 舞台决策区的界面能拿到当前回合和当前选项。侧栏面板拿不到 | 侧栏面板要分清“这是哪一回合的结果”，得自己把回合信息存进数据 |
| 界面事件       | `emitEvent` 把事件交给订阅者在后台执行，不返回它们的结果 | 要马上拿到结果，用 `invokeRuntime` 或 `invokePluginAction`   |
| 框架来画的内容 | 位置的名单是固定的，每个位置的数据格式也是固定的         | 新的“框架来画”的内容要改框架。“插件自己画”的内容用 `webview` |

## 没有按预期工作时

| 现象                                                           | 原因和处理                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 校验报某句译文“is not a text of this plugin's UI or code”      | 你改了界面上的英文，`locales/zh.yaml` 里还留着旧的那句。删掉旧译文，补上新的                                              |
| 校验报 `cannot read ./…json`                                   | `PLUGIN.md` 里登记的路径和文件的实际位置不一致                                                                            |
| 校验报 `unknown component`，或提到 `repeat.statePath`、`$item` | 界面文件里这个位置写错了。报错给出文件和节点的路径，按报错末尾的说明改。组件名见[组件目录](../reference/ui-components.md) |
| 校验通过，但侧栏里没有这个面板                                 | 这一局没有选中或授权这个插件，或者界面文件有校验不检查的问题。看浏览器控制台里打印的原因                                  |
| 面板出现了，但只显示空状态那句话                               | 数据空间里还没有内容。面板上有按钮时写 `"alwaysRender": true`                                                             |
| 列表是空的，但数据明明写进去了                                 | `dataSource.namespace` 和 runtime 写入的空间名字不一样，或者 `$item` 的路径少了 `value/`                                  |
| 正文内容块从不出现                                             | 数据没有写进 `message` 空间，或者没有带 `__turnId`，或者只有块里的按钮才会写它（见第 4 节的第 3 条规则）                  |
| 点按钮没有反应                                                 | 动作名拼错，或者这个动作在这个位置不可用（见第 3 节的表）。`invokeRuntime` 的 `runtimeId` 要写完整：`插件名/runtime名`    |
| 改了文件，界面没变                                             | 没有刷新页面。不是用 `pnpm dev` 启动的环境需要重启后端                                                                    |
| 中文界面里显示的是英文                                         | `locales/zh.yaml` 的 `messages` 里没有这一句，或者英文原文和界面文件里的不完全相同                                        |
| 自己写的 HTML 一片空白                                         | 它在加载网络上的脚本或样式，被拦住了。把所有东西内联进这一个文件                                                          |

想看面板实际拿到了什么数据：开发模式下，在当前打开的侧栏面板上按 `Cmd/Ctrl+Shift+J`，会打开一个调试面板，里面有这个面板的界面文件、数据和动作。

## 接下来

- **查某个组件叫什么、有哪些参数。** 见[界面组件参考](../reference/ui-components.md)。
- **查面板文件的全部字段、多个面板怎样合并。** 见[面板参考](../reference/ui-panels.md)。
- **写即时操作、事件和玩家命令。** 见[插件字段参考](../reference/plugins.md)和[插件扩展参考](../reference/plugin-extensions.md)。
- **给界面的逻辑写测试。** 见[插件测试](./testing.md)。
- **做一套自己的界面风格。** 见[制作主题](../recipes/themes.md)。

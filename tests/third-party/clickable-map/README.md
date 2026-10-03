# Clickable Map 示例插件

一张由插件自己绘制的地图：点一个相连的地点就走过去。它是一个可独立安装的第三方插件包，位于 `tests/third-party/`，不会作为内置插件随产品加载；无 npm 依赖，不需要构建。

它用最少的代码把「自绘面板」需要的几样东西串在一起，可以直接当模板改：

| 想做的事                       | 这里怎么做                                                      | 文件                               |
| ------------------------------ | --------------------------------------------------------------- | ---------------------------------- |
| 画 catalog 组件画不出来的界面  | `ui.right` 的 `webview`：一个单文件 HTML，用 SVG 画地图         | `ui/map-panel.json`、`ui/map.html` |
| 跟随玩家选的风格方案           | 样式只用宿主给的 `--covel-*` 变量，不写死颜色                   | `ui/map.html` 的 `<style>`         |
| 把点击变成游戏里的事           | `emitEvent` 发出自己声明的事件，由事件触发的 runtime 校验并写入 | `PLUGIN.md`、`runtimes/travel/`    |
| 界面只负责画，规则留在后端     | 能不能走由 `lib/map.js` 的 `travel` 决定，界面只说「想去哪」    | `lib/map.js`                       |
| 第一次打开时准备数据           | 没有数据时界面发 `map.opened`，`chart` runtime 写入初始地图     | `runtimes/chart/`                  |
| 把点击交给叙事而不是直接改状态 | `draftMessage` 把「我动身前往……」放进输入框，玩家确认后发出     | `ui/map.html`                      |
| 不打开面板也能看到关键状态     | `session.summary@1` 提供「位置」一行，出现在状态条或场景 HUD    | `server/index.js`                  |
| 需要大画面                     | 什么都不用做：玩家点面板右上角的「放大」                        | —                                  |

## 数据流

```
点击地点 ──emitEvent──▶ map.location-selected ──▶ runtimes/travel（后台任务）
                                                    │ 校验是否相连，写入 plugin_data[clickable-map][map]/state
界面重画 ◀──subscribe── plugin-data.changed ◀──────┘
状态条「位置」 ◀── session.summary@1 重新投影（watch: map）
```

两个事件都声明为 `advertise: false`：它们只由界面发出，叙事模型看不到，也不能通过 `emit-event` 工具发出。别的插件想在玩家移动时做点什么，声明一个订阅 `map.location-selected` 的事件 runtime 即可，不需要改这个插件。

## 试用

把目录复制或软链接到用户插件目录（默认 `~/.covel/plugins/clickable-map`），重启服务，然后在会话的插件设置里启用「可点击地图」并批准它的服务端代码。打开右侧「地图」页签。

这是社区来源的插件，第一次用到下面每一项时都会请求授权（按会话记住）：

- 发出事件 `map.opened`、运行 `clickable-map/chart`
- 发出事件 `map.location-selected`、运行 `clickable-map/travel`

事件触发的 runtime 以后台任务执行。后台任务只有在会话有可用的模型凭据时才会运行（即使任务本身不调用模型）；还没配置模型时，地图会停在「正在绘制地图…」。

## 自动测试

```sh
pnpm validate:plugin tests/third-party/clickable-map
pnpm e2e:extensions
```

`e2e:extensions` 把这个包复制到隔离的用户插件目录，启动独立的服务，在真实浏览器里走完：启用与授权、绘制、点击移动、状态摘要、起草行动、放大面板（`tests/e2e/clickable-map.acceptance.ts`）。

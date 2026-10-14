# 插件扩展点

有些事情内核自己不做，而是交给插件：往提示词里加一段话、压缩历史、给界面的某个位置填内容。内核为每件这样的事定一份带版本号的约定，叫**扩展点**。实现它的插件叫**提供者**。

本页说明怎样声明和注册一个提供者、内核怎样组合多个提供者，以及会话世界上下文和历史压缩这两个扩展点的输入输出。写提供者的插件作者需要它。

## 声明与注册

分两步，和工具、Hook 一样：

1. 在根 `PLUGIN.md` 的 `contributes.extensions` 里声明 `{point, id}`。
2. 在 `entry` 里用相同的 `{point, id}` 调用 `covel.provideExtension()`。

加载器两边都核对：声明了没注册，或注册了没声明，插件都加载失败。

```yaml
entry: ./server/index.js
contributes:
  extensions:
    - point: prompt.segment@1
      id: direction
```

```js
export default function (covel) {
  covel.provideExtension("prompt.segment@1", "direction", {
    handler: (_input, ctx) => [
      {
        id: "direction",
        content: `Locale: ${ctx.locale}`,
        position: "system",
        audience: "story",
        volatility: "stable",
      },
    ],
  });
}
```

上例只展示声明与注册的形状。真实的提示词内容和缓存规则见[提示词结构](./prompt-structure.md)和 [memory 插件的实现](../../plugins/memory/PLUGIN.md)。

只有在当前会话里已启用、并且拿到所需授权的提供者才会被调用。

## 组合模式

一个扩展点可能有多个提供者。内核按扩展点的模式决定怎么用它们：

| 模式       | 组合方式                                       | 当前例子                                                             |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `single`   | 解析一个有效提供者，缺失时由调用点决定默认行为 | `session.world-context@1`、`history.compact@2`、`media.image-flow@1` |
| `collect`  | 收集各提供者通过校验的输出                     | `prompt.segment@1`                                                   |
| `pipeline` | 按声明顺序传递上一个有效结果                   | `prompt.history-transform@1`、`ui.slot@1`                            |

每个扩展点在 `packages/shared/src/extension-points/` 里定义自己的输入、输出、模式、超时和失败策略。失败策略 `onError` 有两种：`skip`（跳过这个提供者，继续）和 `fail-turn`（整个回合失败）。

| 扩展点                       | 模式       | 超时     | `onError`   |
| ---------------------------- | ---------- | -------- | ----------- |
| `prompt.segment@1`           | `collect`  | 500 毫秒 | `skip`      |
| `prompt.history-transform@1` | `pipeline` | 500 毫秒 | `skip`      |
| `ui.slot@1`                  | `pipeline` | 500 毫秒 | `skip`      |
| `media.image-flow@1`         | `single`   | 500 毫秒 | `skip`      |
| `session.world-context@1`    | `single`   | 500 毫秒 | `fail-turn` |
| `history.compact@2`          | `single`   | 60 秒    | `skip`      |

## 依赖一个扩展点

根 `requires` / `optional` 可以写扩展点或 UI 槽位。这表示“会话里要有人实现它”。规则如下：

- 解析器从 `contributes.extensions[].point` 和 `ui.slot@1` 的 `slot` 认出提供者。
- 非空的 `contributes.prompt` 算作实现了 `prompt.segment@1`（由宿主代为实现）。
- 只在根 `provides` 里写一个内核契约的名字，不能满足别人的依赖。
- 客户端预选和服务端激活用同一套规则。没有授权或被明确排除的提供者不会被自动加入。
- `conflicts` 不能引用内核扩展点或具体槽位。作者校验和直接调用会话解析器都返回 `invalid-conflict`。
- `single` 的互斥由模式本身保证；`collect` / `pipeline` 允许多个实现并存。

## handler 能拿到什么

提供者的 handler 收到两个参数：扩展点规定的输入，以及上下文 `ctx`。

- `ctx.pluginData` 只读，只能读提供者自己的数据。它读不到 `_hidden.*` 隐藏世界数据，因为扩展点的输出会进入提示词或客户端。
- `ctx.world` 是会话的 World Model 视图。
- 不能通过这里读其他插件的私有 namespace。
- 社区提供者的 `ctx.utils` 和它的 `covel.http` 一样，只能访问它自己包的 `permissions.http` 列出的源（见[插件参考](./plugins.md#runtime-分组字段)）。

`ctx.pluginData` 的读取方法在三个地方形状相同：函数 runtime 的 handler、runtime 的 guard、扩展点的 handler。代码可以在它们之间直接搬用。

| 方法                  | 返回                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| `get(namespace, key)` | 存储的值本身；不存在时返回 `null`。                                                 |
| `list(namespace)`     | `{ key, value, createdAt, updatedAt }` 数组，按创建顺序排列，不带存储用的标识字段。 |

扩展点的 handler 只有这两个读取方法，没有 `set` / `delete`。

输入和每一份输出都按扩展点的 schema 校验。超时和异常按该扩展点的 `onError` 处理。

> [!TIP]
> 扩展点不是插件之间互相调用的途径。要向另一个插件发请求并拿回结果，用公开的服务契约。要读同一回合里上游 runtime 的结果，用 runtime 的 `io.inputs`。怎么选、各自的事务边界，见[插件扩展边界与通信](./plugin-extensions.md#选择通信方式)。

## 提示词片段 `prompt.segment@1` 的两个字段

### `volatility`

`volatility` 只在 `prompt.segment@1` 里有效，取值 `stable` / `session` / `turn`。它告诉内核这段内容多久变一次，内核据此安排提示词缓存的边界。其他扩展点不读这个字段；UI 槽位、历史变换、压缩的缓存策略由它们各自的实现决定。

它目前只对两类片段生效：

| 片段                                                    | `volatility` 的效果                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `position: "system"`                                    | `stable` / `session` 进入系统提示词的稳定区。`turn` 进入历史之后的[回合上下文](./prompt-structure.md#回合上下文)（仍是 system 角色）。这样系统提示词每个回合都不变。 |
| `position: "pre-history"` 且 `role` 为 `system`         | 都留在系统提示词里，`turn` 的排在最后一个缓存边界之后。                                                                                                              |
| `pre-history` 的非 system 消息、`post-history`、`depth` | 忽略此字段。缓存行为由消息历史整体的 cache_control 布局决定。                                                                                                        |

### `order`

同一个 `volatility` 层级内，片段按 `order` 升序排列，默认 0。

多个插件用了相同的 `order` 时，顺序由 `providerPluginId`（字典序）决定，再看 `id`。这个顺序是确定的，但它只是实现细节，不是承诺：插件改名会悄悄改变它在同层里的位置。需要明确先后的插件应该设不同的 `order`。

## 其他扩展点在哪里讲

- `ui.slot@1`：提供者还要声明 `slot`，可选 `order` / `watch` / `preview`。服务端负责投影、校验和缓存，前端使用通用槽位，不读插件的 namespace。见 [UI 槽位](./ui-panels.md#kernel-ui-slots)。
- 想让插件的状态出现在玩家的状态条或场景 HUD 上，提供 `session.summary@1`。见[状态摘要](./ui-panels.md#session-summary)。
- 想让会话有背景音乐，提供 `stage.music@1`。见[背景音乐](./ui-panels.md#stage-music)。
- 世界上下文、历史变换与压缩挂在流程的哪个位置，见[插件契约](./plugins.md#提示词与记忆扩展)。

## 会话世界上下文

`session.world-context@1` 向 runtime 和客户端提供会话当前的世界状态。它是 `single` 模式：只用一个提供者，不合并多个插件的状态。

输出的字段都是可选的。还没有初始化任何内容时可以返回 `{}`，空的 map 或 entries 也合法。

| 字段                        | 形状                                  | 说明                                                                 |
| --------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `schema`                    | `Record<string, unknown>`             | 会话角色 schema                                                      |
| `entries`                   | `Record<string, unknown>`             | 其他世界上下文条目，不作为维度当前值副本                             |
| `dimensions`                | `DimensionSnapshot`                   | `{id: {name, description?, schema, value, version}}`，不含初值或规则 |
| `dimensionRecovery`         | `{editorRuntimeId, trackerRuntimeId}` | 已注册的同属主恢复 runtime 全名，由 host 校验                        |
| `dimensionProviderPluginId` | string                                | host 按实际提供者注入，不采纳插件自报的属主身份                      |

注意世界包里的维度**声明**和这里的会话**快照**是两种形状。

维度的规则：

- 世界声明了维度时，会话里必须有且只有一个启用的 `world.dimensions@1` 提供者。这个契约定义公开快照的形状，也用来找到提供者。
- 真正的输出由一个只读的 pre-turn runtime 发布。它不是让各个插件把私有 namespace 拼成一条状态总线。
- 内置提供者 `world-init` 的 `dimension-context` 只读已提交的 `_dimensions`。`session.world-context@1` 把同样形状的快照交给 runtime 和客户端。
- 提供者被移除，或权威读取失败时，不会退回去用作者写的初值。

读取和恢复：

- 公开读取在一次执行内是冻结的。post-turn 的更新提交之后，下一次执行重新发布新版本。
- 两个恢复入口分别指向手动的 editor 和 tracker。玩家重试时直接触发 tracker，并带上 `retryFromTurnId`；不是由 editor 再去调用 tracker。

参见[动态维度快照](./world-model.md#动态维度快照)与[编辑及恢复 API](./api.md#维度编辑与待结算恢复)。

## 历史压缩 `history.compact@2`

对话变长之后，内核请这个扩展点的提供者把较早的消息写成摘要。

### 输入

| 字段                | 含义                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `messages`          | 待压缩的消息                                                                             |
| `existingSummaries` | 已有的摘要段                                                                             |
| `locale`            | 会话语言                                                                                 |
| `estimatedTokens`   | 估算的 token 数                                                                          |
| `contextWindow`     | story 和 fast 两个模型各自扣掉回答预留之后，较小的那个容量。用来算触发阈值和摘要总预算。 |
| `inputWindow`       | fast 模型自己的输入容量。摘要请求必须装得进这个容量。                                    |
| `summaryBudget`     | `{maxTokens, maxSegmentTokens, maxSegments}`                                             |

### 输出

输出是 `null`，或者：

```text
{
  summaries: [{ messageIds, replacesSummaryIds, content, focusSections, truncated? }],
  deferred?: { reason }
}
```

- 每一段必须覆盖下面两者之一：一段连续的、还没压缩的消息前缀；或最旧的一段连续摘要。
- 宿主校验引用、顺序和预算，然后在一个事务里只替换被列出的摘要和对应消息的标记。
- 默认提供者保持分段稳定，只有超出总预算或超过八段时才合并最旧的连续段。单段预算随源文本量和窗口增长。具体预算见[提示词结构](./prompt-structure.md)。

### 新摘要写好了，但合并旧摘要失败

提供者不丢掉新摘要。它只返回新摘要，并带上 `deferred: {reason}`，把合并留给之后的回合。

- 宿主照常保存，并把 `reason` 按一次失败记录（`context.compaction.failed`，计入连续失败次数）。
- 这种情况下摘要总量可以暂时超出预算，上限是预算的两倍（段数和 token 都是）。超过两倍时结果被拒绝。

### 压缩失败时怎么报告

`null` 只表示“没有可压缩的内容”。

提供者没能完成一次压缩时（模型报错或超时、摘要为空、合并失败、输入装不进窗口），必须**抛出带原因的错误**，不要返回 `null`。之后发生的事：

- 宿主按 `onError: "skip"` 跳过该提供者，把原因随回合 trace 记为 `context.compaction.failed`，在 `/debug` 里能看到。
- 每个超过阈值的回合都会重试一次。
- 同一会话连续失败 3 次后，玩家会在执行时间线里看到一条已失败的任务，说明故事记忆无法压缩，以及可以做什么。之后每再失败 3 次重复一次。
- 一次成功的压缩，或一次没有失败的运行，会把计数清零。
- 计数只存在服务进程里，重启后重新累计。

## 契约版本与兼容性

契约 ID 里的 `@N` 是版本号，例如 `prompt.segment@1`。每个扩展点只有一个当前版本。内核不做版本协商，旧版本没有兼容期。

- 不兼容的修改用新的契约 ID（`@2`、`@3`）发布。内核和全部内置提供者在同一次变更里一起升级，旧版本随即失效。
- `pnpm validate:plugin` 始终按当前内核的契约校验插件。

仓库之外的插件需要跟着主仓的契约升级。CHANGELOG 会标出不兼容的变更和迁移说明。

## 公开 SDK 里的辅助函数

插件代码只依赖 SDK（`@covel/plugin-handlers-utils`），不需要为下面这些东西引入宿主的内部包。宿主自己也用同一份实现。

| 需要                                | 从哪里拿                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 估算 token 数                       | `estimateTokens`                                                                                         |
| 内置工具的名字表                    | `FRAMEWORK_TOOL_NAMES`                                                                                   |
| 解析多语言文本                      | `resolveI18nText` / `resolveI18nDeep`，以及 locale registry                                              |
| 表单工具、角色字段校验              | SDK 根入口                                                                                               |
| `world.dimensions@1` 提供者用的类型 | `@covel/plugin-handlers-utils/dimensions` 的 schema 与 materializer                                      |
| 加载插件自己的提示词模板（Node）    | `@covel/plugin-handlers-utils/prompts` 的 `createPromptLoader(root)`。这个子入口不进入浏览器用的根模块。 |

Hook 的返回规则见 [Hooks](./hooks.md#how-an-event-runs)：不返回值表示继续；可以拦截的事件上 handler 出故障算作拒绝；其他事件上出故障的 handler 被跳过，之前成功的改写保留。

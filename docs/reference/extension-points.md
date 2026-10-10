# 插件扩展点

扩展点是内核需要插件提供实现时使用的版本化契约。内核在 `packages/shared/src/extension-points/` 定义输入、输出、组合模式、超时和失败策略；插件在根 `PLUGIN.md` 的 `contributes.extensions` 声明提供者，并在 `entry` 中以相同的 `{point, id}` 调用 `covel.provideExtension()`。加载器双向核对声明与注册。只有当前会话已激活且具备所需授权的提供者参与调用。

| 模式       | 组合方式                                       | 当前例子                                                             |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `single`   | 解析一个有效提供者，缺失时由调用点决定默认行为 | `session.world-context@1`、`history.compact@2`、`media.image-flow@1` |
| `collect`  | 收集各提供者通过校验的输出                     | `prompt.segment@1`                                                   |
| `pipeline` | 按声明顺序传递上一个有效结果                   | `prompt.history-transform@1`、`ui.slot@1`                            |

根 `requires` / `optional` 指向扩展点或 UI 槽位时，依赖的是会话中的实现。解析器从 `contributes.extensions[].point` 和 `ui.slot@1` 的 `slot` 识别提供者；非空 `contributes.prompt` 由 host 实现 `prompt.segment@1`。仅在根 `provides` 写入内核契约不能满足依赖。客户端预选与服务端激活共用这些规则，未授权或明确排除的提供者不能自动加入。`conflicts` 禁止引用内核扩展点或具体槽位，作者校验与直接调用会话解析器均返回 `invalid-conflict`；`single` 继续由组合模式执行互斥，`collect` / `pipeline` 允许多个实现。

提供者的 handler 收到契约输入与上下文。上下文中的 `ctx.pluginData` 只读且绑定提供者自己的数据（读不到 `_hidden.*` 隐藏世界数据，因为扩展输出会进入提示词或客户端），`ctx.world` 提供会话 World Model 视图；不能通过这里读取其他插件的私有 namespace。输入与每个输出都经过扩展点 schema 校验，超时和异常按该点的 `onError` 处理。需要跨插件请求/响应调用时使用公开服务契约；需要同轮上游结果时使用 runtime `io.inputs`。选择方法与事务边界见[插件扩展边界与通信](plugin-extensions.md#选择通信方式)。

`ctx.pluginData.get` 在两种上下文里返回的形状不同，照搬写法会读到空值而不报错：

| 上下文                                    | `get(namespace, key)` 返回                                          | 不存在时    | `list(namespace)` 的每一项 |
| ----------------------------------------- | ------------------------------------------------------------------- | ----------- | -------------------------- |
| 函数 runtime 的 handler、runtime 的 guard | 存储的值本身                                                        | `null`      | `{ key, value }`           |
| 扩展点的 handler                          | 整行记录 `{ pluginId, namespace, key, value, … }`，值在 `.value` 里 | `undefined` | 整行记录                   |

两边的 `list` 都能用 `row.value` 取值，所以在两种上下文之间共用的代码优先用 `list`。

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

上例只展示声明与注册形状；真实提示词内容和缓存语义参见[提示词结构](prompt-structure.md)及 [memory 实现](../../plugins/memory/PLUGIN.md)。`ui.slot@1` 的提供者还需声明 `slot`、可选 `order/watch/preview`；服务端负责投影、校验和缓存，前端消费通用槽位而非插件 namespace。见[UI 槽位](ui-panels.md#kernel-ui-slots)。想让插件的状态出现在玩家的状态条或场景 HUD 上，提供 `session.summary@1`，见[状态摘要](ui-panels.md#session-summary)。想让会话有背景音乐，提供 `stage.music@1`，见[背景音乐](ui-panels.md#stage-music)。世界上下文、历史变换与压缩的挂载位置见[插件契约](plugins.md#提示词与记忆扩展)。

**`volatility` 字段作用范围**：`volatility` 仅在 `prompt.segment@1` 扩展点中有效，用于控制提示词缓存边界（`stable`/`session`/`turn`）。其他扩展点不消费此字段；UI 槽位、历史变换、压缩等扩展点的缓存策略由各自的实现决定。

当前 `volatility` 仅对 `position: "system"` 和 `position: "pre-history"` 且 `role` 为 `system` 的段落生效。`position: "system"` 的段落由组装器按它决定去向：`stable` / `session` 进入系统提示字符串的稳定区，`turn` 进入历史之后的[回合上下文](prompt-structure.md#回合上下文)（仍是 system 角色），这样系统提示逐回合不变。`pre-history` 的 system 段落都留在系统提示里，`turn` 的排在最后一个缓存边界之后。`pre-history` 的非 system role 消息、`post-history` 和 `depth` position 的段落目前忽略此字段，其缓存行为由消息历史的整体 cache_control 布局决定。

**`order` 与段落排序**：同一 `volatility` 层级内，段落按 `order`（升序，默认 0）排列。多个插件以相同 `order` 注册时，最终顺序由 `providerPluginId`（字典序）再到 `id` 决定，是确定性的实现细节而非设计承诺——这意味着插件改名会静默地改变它在同层的相对位置。需要明确相对顺序的插件应设置不同的 `order` 值。

## 会话世界上下文

`session.world-context@1` 保持 `single`，不合并多个插件的状态。输出字段都是可选的；没有已初始化内容时可以返回 `{}`，空 map/entries 合法。世界包声明与会话快照是不同形状：

| 字段                        | 形状                                  | 说明                                                                 |
| --------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `schema`                    | `Record<string, unknown>`             | 会话角色 schema                                                      |
| `entries`                   | `Record<string, unknown>`             | 其他世界上下文条目，不作为维度当前值副本                             |
| `dimensions`                | `DimensionSnapshot`                   | `{id: {name, description?, schema, value, version}}`，不含初值或规则 |
| `dimensionRecovery`         | `{editorRuntimeId, trackerRuntimeId}` | 已注册的同属主恢复 runtime 全名，由 host 校验                        |
| `dimensionProviderPluginId` | string                                | host 按实际提供者注入，不采纳插件自报的属主身份                      |

非空维度声明要求唯一活跃的 `world.dimensions@1` 提供者；该契约定义公开快照并用于提供者发现，真实输出由只读 pre-turn runtime 发布，不是让各插件把私有 namespace 合并成状态总线。捆绑提供者 `world-init` 的 `dimension-context` 只读已提交 `_dimensions`，`session.world-context@1` 将同形快照交给 runtime 与客户端。提供者被移除或权威读取失败时不回退作者初值。

公共读取在一次执行内冻结；post-turn 更新提交后，下一执行重新发布新版。恢复入口分别指向 manual editor 和 tracker；玩家重试直接触发 tracker，并带 `retryFromTurnId`，不是 editor 递归调用 tracker。参见[动态维度快照](world-model.md#动态维度快照)与[编辑及恢复 API](api.md#维度编辑与待结算恢复)。

## 历史压缩 `history.compact@2`

输入包含 `messages`、`existingSummaries`、`locale`、`estimatedTokens`、`contextWindow`、`inputWindow` 与 `summaryBudget: {maxTokens, maxSegmentTokens, maxSegments}`。`contextWindow` 是 story 与 fast 扣除响应预留后的较小容量，用于触发阈值和摘要总预算；`inputWindow` 是 fast 自身输入容量，摘要请求须装入该容量。

输出为 `null` 或 `{summaries: [{messageIds, replacesSummaryIds, content, focusSections, truncated?}]}`。每段必须覆盖连续未压缩消息前缀或最旧连续摘要段中的一种。宿主校验引用、顺序和预算，在事务中只替换被列出的摘要及其对应消息标记。默认提供者保留稳定分段，超出总预算或八段上限时才合并最旧连续段；单段预算随源文本量和窗口增长。具体预算见[提示词结构](prompt-structure.md)。

`null` 只表示「没有可压缩的内容」。提供者无法完成一次压缩（模型报错或超时、摘要为空、合并失败、输入装不进窗口）时必须抛出带原因的错误，不要返回 `null`：宿主按 `onError: "skip"` 跳过该提供者，并把原因随回合 trace 记为 `context.compaction.failed`（`/debug` 可见）。每个超过阈值的回合都会重试一次；同一会话连续失败达到 3 次后，玩家会在执行时间线里看到一条已失败的任务，说明故事记忆无法压缩以及可以做什么，之后每再失败 3 次重复一次。成功压缩或一次无失败的运行会清零计数；计数只存在服务进程内，重启后重新累计。

## 契约版本与兼容性

契约 ID 中的 `@N` 是版本标识（如 `prompt.segment@1`）。内核采用 **current-only** 策略：每个扩展点只有一个当前版本，不做版本协商，旧版本不保留兼容期。

- 破坏性变更随新契约 ID（`@2`、`@3`）发布，内核与全部内置提供者在同一变更中同步升级，旧版本随即失效
- `pnpm validate:plugin` 始终按当前内核契约校验插件

外部插件需跟随主仓契约同步升级；CHANGELOG 会标注破坏性变更及迁移说明。

插件 SDK 现在导出 `estimateTokens` 和 `FRAMEWORK_TOOL_NAMES`，无需为 token 估算或内置工具名称引入宿主内部包。hook 未返回值表示继续；守卫故障仍否决操作，转换故障保留之前成功的改写。

公开 SDK 提供 `resolveI18nText` / `resolveI18nDeep`、locale registry、`estimateTokens`、表单工具和角色字段校验。`world.dimensions@1` 的提供者使用 `@covel/plugin-handlers-utils/dimensions` 的 schema 与 materializer。Node 插件用 `@covel/plugin-handlers-utils/prompts` 的 `createPromptLoader(root)` 加载自己的模板；该子入口不进入浏览器根模块。`shared` / `tools` / `context` 复用这些实现，插件代码只依赖 SDK。

# 插件扩展点

扩展点是内核需要插件提供实现时使用的版本化契约。内核在 `packages/shared/src/extension-points/` 定义输入、输出、组合模式、超时和失败策略；插件在根 `PLUGIN.md` 的 `contributes.extensions` 声明提供者，并在 `entry` 中以相同的 `{point, id}` 调用 `covel.provideExtension()`。加载器双向核对声明与注册。只有当前会话已激活且具备所需授权的提供者参与调用。

| 模式       | 组合方式                                       | 当前例子                                                             |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `single`   | 解析一个有效提供者，缺失时由调用点决定默认行为 | `session.world-context@1`、`history.compact@1`、`media.image-flow@1` |
| `collect`  | 收集各提供者通过校验的输出                     | `prompt.segment@1`                                                   |
| `pipeline` | 按声明顺序传递上一个有效结果                   | `prompt.history-transform@1`、`ui.slot@1`                            |

根 `requires` / `optional` 指向扩展点或 UI 槽位时，依赖的是会话中的实现。解析器从 `contributes.extensions[].point` 和 `ui.slot@1` 的 `slot` 识别提供者；非空 `contributes.prompt` 由 host 实现 `prompt.segment@1`。仅在根 `provides` 写入内核契约不能满足依赖。客户端预选与服务端激活共用这些规则，未授权或明确排除的提供者不能自动加入。`conflicts` 禁止引用内核扩展点或具体槽位，作者校验与直接调用会话解析器均返回 `invalid-conflict`；`single` 继续由组合模式执行互斥，`collect` / `pipeline` 允许多个实现。

提供者的 handler 收到契约输入与上下文。上下文中的 `ctx.pluginData` 只读且绑定提供者自己的数据，`ctx.world` 提供会话 World Model 视图；不能通过这里读取其他插件的私有 namespace。输入与每个输出都经过扩展点 schema 校验，超时和异常按该点的 `onError` 处理。需要跨插件请求/响应调用时使用公开服务契约；需要同轮上游结果时使用 runtime `io.inputs`。选择方法与事务边界见[插件扩展边界与通信](plugin-extensions.md#选择通信方式)。

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

上例只展示声明与注册形状；真实提示词内容和缓存语义参见[提示词结构](prompt-structure.md)及 [director 实现](../../plugins/director/PLUGIN.md)。`ui.slot@1` 的提供者还需声明 `slot`、可选 `order/watch/preview`；服务端负责投影、校验和缓存，前端消费通用槽位而非插件 namespace。见[UI 槽位](ui-panels.md#kernel-ui-slots)。世界上下文、历史变换与压缩的挂载位置见[插件契约](plugins.md#提示词与记忆扩展)。

**`volatility` 字段作用范围**：`volatility` 仅在 `prompt.segment@1` 扩展点中有效，用于控制提示词缓存边界（`stable`/`session`/`turn`）。其他扩展点不消费此字段；UI 槽位、历史变换、压缩等扩展点的缓存策略由各自的实现决定。

当前 `volatility` 仅对 `position: "system"` 和 `position: "pre-history"` 且 `role` 为 `system` 的段落生效——这些是系统提示字符串的组成部分，提示组装器可以在稳定区和 turn 区之间分割它们。`pre-history` 的非 system role 消息、`post-history` 和 `depth` position 的段落目前忽略此字段，其缓存行为由消息历史的整体 cache_control 布局决定。

**`order` 与段落排序**：同一 `volatility` 层级内，段落按 `order`（升序，默认 0）排列。多个插件以相同 `order` 注册时，最终顺序由 `providerPluginId`（字典序）再到 `id` 决定，是确定性的实现细节而非设计承诺——这意味着插件改名会静默地改变它在同层的相对位置。需要明确相对顺序的插件应设置不同的 `order` 值。

## 契约版本与兼容性

**当前状态（v0.0.x）：开发期契约**

所有扩展点契约（`@1` 版本）目前处于开发期，可能发生破坏性变更，不保证向后兼容。内核与插件采用 current-only 同步升级策略。

**稳定后的版本策略（v1.0.0+）：**

- **`@1` 锁定**：第一个稳定版本（v1.0.0）后，所有 `@1` 契约锁定，不再破坏性变更
- **新版本增加**：需要破坏性变更时增加 `@2`、`@3` 等新版本，旧版本继续支持
- **废弃流程**：标记 deprecated → 保留至少 2 个大版本 → 删除
- **兼容性检查**：提供 `pnpm validate:plugin` 检查插件与当前内核契约的兼容性

**外部插件影响：**

- 开发期间，外部插件需要跟随主仓契约变更同步升级
- CHANGELOG 会明确标注破坏性变更及迁移指南
- 稳定后，外部插件可以安全地依赖锁定的契约版本

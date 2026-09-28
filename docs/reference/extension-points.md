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

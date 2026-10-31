# 自定义工具：工厂函数模式

插件自有工具放在插件根的 `tools/` 目录，用工厂函数接收框架注入，再由 `entry` 模块注册。参考成品：`plugins/guide`（工厂 `tools/generate-guide.js` + 入口 `server/index.js`）。

## 基本模板

```javascript
// tools/my-tool.js
export default function ({ tool, z, shortId, shortIdBatch }) {
  return tool({
    name: 'my-tool',
    description: 'Echo one selected story note.',
    annotations: { readOnly: true, idempotent: true, concurrencySafe: true },
    timeoutMs: 5000,
    parameters: z.object({
      param1: z.string().describe('The note text to echo.'),
      param2: z.number().optional().describe('Optional note priority.'),
    }),
    execute: async (params, context) => {
      // context: { sessionId, turnId, pluginId, runtimeId, locale, messages,
      //            store, world, signal, random, logicalTurn, ... }
      return { result: params.param1 };
    },
  });
}
```

注解和单次时限的完整规则见 [工具注解与超时](../../../../docs/reference/tools.md#注解与超时)。使用 `tool()` 让 SDK 补齐注解；手写模块必须提供完整注解。返回 proposal 或领域事件的工具不能声明只读，未注册的声明工具会让 runtime 启动失败，包括延迟工具。

## 注入对象

| 字段 | 用途 |
|------|------|
| `tool` | 工具定义包装函数 |
| `z` | Zod schema 库 |
| `withModelView(content, { summary?, data? })` | 选择模型可见的摘要和数据，保留代码读取的正文 |
| `ToolError(code, message, { hint? })` | 抛出使用 SDK 固定错误码的失败 |
| `withPendingProposals(content, proposals)` | 返回正文并附上待提交的 proposals |
| `shortId(prefix, label, sessionId, random?)` | 生成 LLM 友好的短 ID（如 `item-fire-sword`）；第四个参数传 `context.random` |
| `shortIdBatch(prefix, labels, sessionId, random?)` | 批量生成短 ID（自动去重） |

工具结果给模型时统一为 `{summary?,data?,staged?}` 或 `{error:{code,message,hint?}}`。错误码由 SDK 的 `TOOL_ERROR_CODES` 定义；用 `ToolError` 报告，`ctx.tools.call` 失败也抛出它。工具调用成功只代表写入暂存，回合结束时仍可能被拒绝。`withModelView` 可与 proposal 和事件辅助函数按任意顺序组合。完整规则见[统一返回格式与错误码](../../../../docs/reference/tools.md#统一返回格式与错误码)。

## 带 UI 交互的工具

工具可以通过返回 `interaction` 字段触发玩家交互：

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: 'form',            // form | choice | confirmation
    interactionId: params.formId,
    title: 'Character creation',
    fields: [
      { type: 'text', name: 'characterName', label: 'Character name', required: true },
    ],
    submitLabel: 'Create character',
    narrativeTemplate: 'Your name is {{characterName}}.',
  },
}),
```

界面文本通过 `labelText(context, "English text")` 返回各语言标签；内容文本通过 `translate(context, "English text")` 解析为会话语言。译文放在 `locales/zh.yaml`，例如：

```yaml
messages:
  Character creation: 角色创建
  Character name: 角色名
  Create character: 确认创建
  Your name is {{characterName}}.: 你的名字叫 {{characterName}}。
```

## 带持久化数据的工具

模型要读写插件自己的数据，在根 `PLUGIN.md` 用 `contributes.datasets` 声明数据集（记录 schema、`key`），再在 agent 的 `agent.tools.datasets` 里列出它：框架生成 `<数据集>-get` / `-list` / `-upsert` / `-update`，按 schema 检查后暂存写入，不用写工具代码。只有数据集工具表达不了的业务逻辑才写自定义工具：内部读自己的数据用 `context.store.getPluginData(namespace, key)`（返回 `{ key, value }` 或 `null`，已经绑定了会话和插件，包含本次执行更早的写入）；写入返回 `plugin.data` / `plugin.data.update` proposal（`withPendingProposals`），一个值最多 256 KiB。写数据集的代码用 `datasetKey(text)` 生成键，数据集工具才能按同一个键找到记录。

## 注册与声明（两步，缺一不可）

**1. `entry` 模块里注册**——一个插件一个入口，把所有工厂注册进去：

```javascript
// server/index.js
import makeMyTool from "../tools/my-tool.js";

export default function (covel) {
  covel.registerTool(makeMyTool(covel.toolkit)); // toolkit 就是上面那份注入对象
}
```

**2. PLUGIN.md 里声明**——入口默认是 `server/index.js`（放在别处才写 `entry`），`runtime.agent.tools.plugin` 列**工具名**（不是路径）：

```yaml
contributes:
  tools: [my-tool]
runtime:
  schedule:
    trigger: {type: manual}
  agent:
    tools:
      plugin: [my-tool]
```

> 旧写法 `tools: { local: [./tools/my-tool.js] }` **已被移除**：`pnpm validate:plugin` 报错，加载时这个字段被去掉，工具不会出现。工具名对不上 `runtime.agent.tools.plugin` 的话，工具注册了但那个 runtime 的 LLM 看不到它。

工具作用域是 fail-closed 的：`runtime.agent.tools.plugin` 里的工具只有声明它的插件能调，内置工具所有插件都能调。

## 参数设计原则

- 每个参数加 `.describe()` — LLM 依靠描述理解如何调用
- 工具写出的文字只写 English，译文放 `locales/<locale>.yaml` 的 `messages`：会被注入提示词的数据和给玩家的提示用 `translate(context, "English text", params)`，只由界面绘制的徽标用 `labelText(context, "English text")`；不要手写 `{ zh, en }` 两份
- 工具和参数的描述用 English 写：工具定义是给模型的指令，所有语言的会话都会读到它（`pnpm check:i18n` 会拒绝中文描述）
- 返回值中引用实体时用 `shortId()` 而非 UUID — LLM 需要能精确复制 ID
- 返回 `ui` 数组可以渲染自定义前端卡片

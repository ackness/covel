# 自定义工具：工厂函数模式

插件自有工具放在插件根的 `tools/` 目录，用工厂函数接收框架注入，再由 `entry` 模块注册。参考成品：`plugins/guide`（工厂 `tools/generate-guide.js` + 入口 `server/index.js`）。

## 基本模板

```javascript
// tools/my-tool.js
export default function ({ tool, z, shortId, shortIdBatch }) {
  return tool({
    name: 'my-tool',
    description: '工具描述（会注入 LLM 上下文，LLM 据此决定何时调用）',
    parameters: z.object({
      param1: z.string().describe('参数描述（LLM 看到的说明）'),
      param2: z.number().optional().describe('可选参数'),
    }),
    execute: async (params, context) => {
      // context: { sessionId, turnId, pluginId, runtimeId }
      return { result: params.param1 };
    },
  });
}
```

## 注入对象

| 字段 | 用途 |
|------|------|
| `tool` | 工具定义包装函数 |
| `z` | Zod schema 库 |
| `shortId(prefix, label, sessionId)` | 生成 LLM 友好的短 ID（如 `item-fire-sword`） |
| `shortIdBatch(prefix, labels, sessionId)` | 批量生成短 ID（自动去重） |

## 带 UI 交互的工具

工具可以通过返回 `interaction` 字段触发玩家交互：

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: 'form',            // form | choice | confirmation
    interactionId: params.formId,
    title: '角色创建',
    fields: [
      { type: 'text', name: 'characterName', label: '角色名', required: true },
    ],
    submitLabel: '确认创建',
    narrativeTemplate: '你的名字叫 {{characterName}}。',
  },
}),
```

## 带持久化数据的工具

使用 `plugin-data-*` builtin 工具而非自定义工具来读写数据。但如果需要在自定义工具内部操作数据，可以通过 `context.sessionId` + `context.pluginId` 配合 store 完成。

## 注册与声明（两步，缺一不可）

**1. `entry` 模块里注册**——一个插件一个入口，把所有工厂注册进去：

```javascript
// server/index.js
import makeMyTool from "../tools/my-tool.js";

export default function (covel) {
  covel.registerTool(makeMyTool(covel.toolkit)); // toolkit 就是上面那份注入对象
}
```

**2. PLUGIN.md 里声明**——`entry` 指入口，`tools.plugin` 列**工具名**（不是路径）：

```yaml
entry: ./server/index.js
tools:
  plugin:
    - my-tool # 与工厂里 tool({ name: 'my-tool' }) 一致
```

> 旧写法 `tools: { local: [./tools/my-tool.js] }` **已被移除**，schema strict 会直接判加载失败。工具名对不上 `tools.plugin` 的话，工具注册了但那个 runtime 的 LLM 看不到它。

工具作用域是 fail-closed 的：`tools.plugin` 里的工具只有声明它的插件能调，内置工具所有插件都能调。

## 参数设计原则

- 每个参数加 `.describe()` — LLM 依靠描述理解如何调用
- 用 I18nText 友好的参数名（中文描述，英文 key）
- 返回值中引用实体时用 `shortId()` 而非 UUID — LLM 需要能精确复制 ID
- 返回 `ui` 数组可以渲染自定义前端卡片

# 插件开发指南 · 进阶（Agent + 本地 JS）

> 面向**进阶创作者**：已经会用 PLUGIN.md 写零代码插件，现在要加本地 JS 工具、声明玩家交互、跨插件注入数据、暴露 RPC action，并为插件写基本的集成测试。

> **前置要求**：先完成 [零代码指南](./plugin-authoring-zero-code.md)（frontmatter、触发类型、内置工具）。

> **读完你能做到**
>
> - 用 `tool({ parameters: z.object(...) })` 工厂函数写一个本地工具并挂到 `tools.local`
> - 用 `interaction` 返回字段让工具产出玩家交互块（form / choice / confirmation）
> - 用 `input.inject` 声明跨 runtime 的 prompt 注入依赖
> - 用 `rpc:` frontmatter 暴露结构化 action 给前端 / 外部代理
> - 用 `@covel/plugin-test-utils` 的 `TestHarness + MockLLM` 写插件集成测试

---

## 1. 创建本地工具

当内置工具不够用时，可以用 JS/TS 编写自定义工具。一个工具就是一个文件，使用 `tool()` 包装函数：

```
plugins/my-codex/
├── PLUGIN.md
├── package.json
└── tools/
    └── unlock-codex-entries.js
```

**tools/unlock-codex-entries.js：**

插件本地工具使用**工厂函数**模式 — 框架在加载时注入 `{ tool, z, shortId, shortIdBatch }`：

```javascript
// 工厂函数接收框架注入
export default function ({ tool, z, shortIdBatch }) {
  const codexEntrySchema = z.object({
    category: z
      .enum(["monster", "item", "location", "lore", "character", "skill"])
      .describe("知识类别"),
    title: z.string().min(1).describe("条目标题"),
    content: z.string().min(10).describe("2-3 句话的描述"),
    tags: z.array(z.string()).min(1).max(5).describe("标签列表"),
    rarity: z
      .enum(["common", "uncommon", "rare", "legendary"])
      .default("common")
      .describe("稀有度，影响 UI 展示样式"),
    imageHint: z.string().optional().describe("可选的视觉描述提示"),
  });

  return tool({
    name: "unlock-codex-entries",
    description:
      '批量解锁新的图鉴条目。每个条目会生成一张"知识发现"卡片展示给玩家。',
    parameters: z.object({
      entries: z
        .array(codexEntrySchema)
        .min(1)
        .describe("要解锁的图鉴条目列表"),
    }),
    execute: async (params, context) => {
      // 使用 shortIdBatch 生成 LLM 友好的短 ID（如 'codex-fire-magic'）
      const ids = shortIdBatch(
        "codex",
        params.entries.map((e) => e.title),
        context.sessionId,
      );

      const results = params.entries.map((entry, i) => ({
        entryId: ids[i],
        ...entry,
        unlockedAt: new Date().toISOString(),
      }));

      return {
        unlocked: results.length,
        entries: results,
        // 框架对 `block.type === 'ui-spec'` 做统一解包：直接拿到
        // `data.spec` 传给 json-render。插件可以用目录里注册的任意组件
        // （如 EntryCard、Stack、Alert），无需框架 side 注册新的 block type。
        ui: results.map((entry) => ({
          type: "ui-spec",
          entryId: entry.entryId,
          spec: {
            type: "EntryCard",
            props: {
              title: entry.title,
              category: entry.category,
              rarity: entry.rarity,
              isNew: true,
            },
          },
        })),
      };
    },
  });
}
```

**关键点：**

1. **工厂函数** — `export default function ({ tool, z, shortId, shortIdBatch })` 接收框架注入，无需 import
2. **Zod 定义参数** — 框架自动从 Zod schema 生成 JSON Schema 注入 LLM 上下文，LLM 才知道如何调用
3. **`.describe()` 很重要** — 每个参数的 describe 会作为参数说明发给 LLM
4. **`execute(params, context)`** — params 是经过 Zod 验证的输入，context 包含会话信息
5. **短 ID** — 使用 `shortId()` / `shortIdBatch()` 代替 UUID，让 LLM 能精确引用实体
6. **返回值** — 任意 JSON，会作为 tool result 返回给 LLM

在 PLUGIN.md frontmatter 中声明本地工具：

```yaml
tools:
  local:
    - ./tools/unlock-codex-entries.js
  builtin:
    - create-notification
```

**package.json** 需要声明对 `@covel/tools` 的依赖：

```json
{
  "name": "@covel/plugin-my-codex",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@covel/tools": "workspace:*"
  },
  "devDependencies": {
    "@covel/plugin-test-utils": "workspace:*",
    "vitest": "^4.1.2"
  }
}
```

## 2. 交互协议（interaction）

工具可以通过返回值中的 `interaction` 字段声明"需要玩家交互"。框架自动处理渲染、等待、和结果注入。

**三种交互类型：**

### form — 表单填写

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: "form",
    interactionId: params.formId,
    title: params.title,
    fields: params.fields,
    submitLabel: params.submitLabel,
    narrativeTemplate:
      "你的名字叫 {{characterName}}，拥有 {{spiritRoot}} 灵根。",
  },
});
```

### choice — 选项选择

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: "choice",
    interactionId: params.choiceId,
    prompt: params.prompt,
    choices: params.choices,
    narrativeTemplate: "你思考片刻后决定：{{selectedLabel}}。",
  },
});
```

### confirmation — 确认/取消

```javascript
execute: async (params) => ({
  created: true,
  interaction: {
    type: "confirmation",
    interactionId: "confirm-1",
    narrativeTemplate: "你{{confirmed}}了这个请求。", // "确认" 或 "取消"
  },
});
```

**协议流程：**

```
工具返回 interaction
  → 框架扫描所有 tool result 的 interaction（通用，无硬编码）
  → 聚合存入 TurnMessage.pendingInput
  → 前端渲染交互 UI
  → 玩家提交
  → 框架用 narrativeTemplate 替换占位符，生成自然语言
  → 追加到消息历史（LLM 看到的和普通消息一样）
```

**`narrativeTemplate` 由插件作者编写**，决定了交互结果如何翻译为 LLM 可理解的叙事文本。

## 3. 注入其他插件的输出

通过 `input.inject` 声明依赖其他插件的输出。

以 `char-creator` 为例——它需要读取 `narrator` 的开场叙事：

```yaml
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
input:
  inject:
    - from: narrator # 来源插件 ID
      field: narrativeOutput # 要提取的输出字段
      as: "<narrator-opening>" # 包裹的 XML 标签名
```

在提示词中通过模板变量访问注入的数据：

```markdown
## 主叙事开场

<narrator-opening>{{ inputs.narrator.narrator.narrativeOutput }}</narrator-opening>
```

**注意：**

- `from` 指定来源插件的 ID
- `field` 指定要提取的字段名
- `as` 指定包裹的 XML 标签名，帮助 LLM 区分不同数据来源
- 如果来源插件尚未执行（优先级更低），注入会为空

## 4. 暴露 RPC action

如果你的插件想被前端或外部代理通过结构化指令调用(而不是触发 turn pipeline),在 PLUGIN.md 加 `rpc:` 字段:

```yaml
rpc:
  regenerate:
    handler: ./rpc/regenerate.js
    description: 重新生成上一次的 narrator 输出
  cancel:
    handler: ./rpc/cancel.js
    trustLevel: builtin # 跳过 PR-7 approval 流程,慎用
```

handler 是一个 ES module,默认导出一个函数:

```js
// plugins/my-plugin/rpc/regenerate.js

/**
 * @param {unknown} payload  调用方传入的载荷
 * @param {{ sessionId: string, pluginId: string, action: string, store: any }} ctx
 * @returns {Promise<unknown>}
 */
export default async function regenerate(payload, ctx) {
  // 直接读 store / 触发 RPC / 写 plugin_data
  const messages = await ctx.store.listTurnMessages();
  // ...
  return { ok: true, regeneratedAt: new Date().toISOString() };
}
```

调用方:

```bash
curl -X POST http://localhost:3001/api/sessions/$SESSION_ID/plugin-rpc \
  -H 'Content-Type: application/json' \
  -d '{"pluginId": "my-plugin", "action": "regenerate", "payload": {}}'
```

**约束:**

- action 名必须是 kebab-case
- 不能以 `framework-` 开头(保留命名空间)
- handler 是按需 lazy import,首次调用时才 `import()`。模块本身可以 throw,框架会捕获并返回 500
- payload 可以是任意 JSON,推荐在 handler 内自己用 zod 校验
- handler 的 `store` 是 raw `DataStore`,可以读写,但**不要绕过 commit 链做大型状态变更**——那是 turn pipeline 的职责。RPC 适合小范围读 / 通知 / 重新触发的场景

**框架默认 action(无需声明,所有插件可直接调):**

| Action        | 说明                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `submit-form` | 持久化玩家输入 + 填模板,等同于 legacy `POST /api/sessions/:id/submit-inputs` |

详细 API 见 [docs/reference/api.md `POST /api/sessions/:id/plugin-rpc`](../reference/api.md#post-apisessionsidplugin-rpc)。

## 5. 测试你的插件

使用 `@covel/plugin-test-utils` 提供的 `TestHarness` 进行集成测试。

推荐最少覆盖四类行为：

1. manifest / runtime 发现与加载
2. local tool 参数与返回结构
3. handler / agent runtime 的核心输出
4. `plugin_data` 与 `ui.message / ui.right` 的契约

**安装依赖：**

```json
{
  "devDependencies": {
    "@covel/plugin-loader": "workspace:*",
    "@covel/plugin-test-utils": "workspace:*",
    "vitest": "^4.1.2"
  }
}
```

**tests/my-plugin.test.ts：**

```typescript
import { describe, it, expect } from "vitest";
import { createTestHarness, MockLLM } from "@covel/plugin-test-utils";
import path from "node:path";

describe("my-codex", () => {
  it("should discover and load plugin manifest", async () => {
    const harness = await createTestHarness({
      pluginsDir: path.resolve(__dirname, "../../"), // 指向 plugins/ 目录
      activePlugins: ["my-codex"], // 只激活要测试的插件
    });

    // 验证 manifest 被正确解析
    expect(harness.manifests).toHaveLength(1);
    expect(harness.manifests[0].name).toBe("my-codex");
    expect(harness.manifests[0].priority).toBe(650);
  });

  it("should execute a turn and get result", async () => {
    // 配置 MockLLM 返回包含工具调用的响应
    const mockLLM = new MockLLM({
      defaultResponse: {
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            name: "unlock-codex-entries",
            arguments: {
              entries: [
                {
                  category: "location",
                  title: "青萍山",
                  content: "青萍宗所在的灵脉山峰，山腰以下是外门。",
                  tags: ["地点", "宗门"],
                  rarity: "common",
                },
              ],
            },
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 200, outputTokens: 100 },
      },
    });

    const harness = await createTestHarness({
      pluginsDir: path.resolve(__dirname, "../../"),
      activePlugins: ["my-codex"],
      llm: mockLLM,
    });

    const result = await harness.executeTurn("我来到了青萍山的坊市");

    // 验证 LLM 被调用
    expect(mockLLM.calls).toHaveLength(1);

    // 验证 system prompt 包含插件提示词
    const systemMessage = mockLLM.calls[0].messages.find(
      (m) => m.role === "system",
    );
    expect(systemMessage?.content).toContain("知识图鉴系统");
  });
});
```

**TestHarness API：**

| 属性/方法                          | 类型                                                   | 说明                                  |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------- |
| `executeTurn(message, overrides?)` | `(string, Partial<TurnInput>?) => Promise<TurnResult>` | 执行一轮游戏                          |
| `store`                            | `DataStore`                                            | 内存 store，可读取/断言状态           |
| `manifests`                        | `RuntimeManifest[]`                                    | 已加载的 runtime 清单（按优先级排序） |
| `llm`                              | `LLMAdapter`                                           | 使用的 LLM 适配器（可断言调用记录）   |

**测试数据工厂：**

```typescript
import {
  makeTurnInput,
  makeTriggerContext,
  makeRuntimeResult,
} from "@covel/plugin-test-utils";

// 创建带默认值的测试数据，可覆盖任意字段
const input = makeTurnInput({ playerMessage: "我要去云梦泽" });
const ctx = makeTriggerContext({ turnNumber: 5, triggerCount: 2 });
const result = makeRuntimeResult({ status: "success" });
```

运行测试：

```bash
pnpm --filter @covel/plugin-my-codex test
```

更详细的测试模式（端到端 API harness、真实 LLM 验证）见 [插件测试指南](./plugin-testing.md)。

---

## 下一步

- 想用完整 TypeScript 类型、拆多 runtime、自定义审批、发布到社区？ → [高级指南（TypeScript + 审批 + 发布）](./plugin-authoring-advanced.md)
- 想写交互 UI 面板的 json-render spec？ → [插件 UI 与 runtime 指南](./plugin-ui-runtime-guidelines.md)
- 想看所有插件的 frontmatter 速查与调度层级？ → [插件注册表 `docs/reference/plugins.md`](../reference/plugins.md)
